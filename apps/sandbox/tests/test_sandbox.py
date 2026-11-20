import base64
import io
from pathlib import Path
from time import sleep

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader

from sandbox import SCRATCH, app


client = TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def start_service():
    with client:
        assert client.get("/health").status_code == 200
        yield


def run(code, seconds=15, files=None):
    response = client.post("/run", json={"code": code, "timeoutSeconds": seconds, "files": files or []})
    assert response.status_code == 200, response.json()
    return response.json()


def test_outputs_are_isolated_and_no_credentials_or_network_reach_the_program(monkeypatch):
    monkeypatch.setenv("SANDBOX_FIXTURE_TOKEN", "synthetic-value")
    result = run(r'''
from pathlib import Path
import os, resource, shutil, socket, subprocess

assert os.getuid() != 0
assert "SANDBOX_FIXTURE_TOKEN" not in os.environ
try:
    resource.prlimit(os.getppid(), resource.RLIMIT_NOFILE)
    raise AssertionError("outside process limits are visible")
except PermissionError:
    pass
try:
    Path(f"/proc/{os.getppid()}/environ").read_bytes()
    raise AssertionError("outside process environment is visible")
except PermissionError:
    pass
try:
    socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    raise AssertionError("network unexpectedly available")
except PermissionError:
    pass
try:
    Path("inputs/test.txt").write_text("not allowed")
    raise AssertionError("input became writable")
except PermissionError:
    pass
data = Path("inputs/test.txt").read_text()
Path("outputs/结果.txt").write_text("处理: " + data, encoding="utf-8")
os.close(os.open("outputs/复制.txt", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o200))
shutil.copy("inputs/test.txt", "outputs/复制.txt")
subprocess.run(["python", "-c", "import pandas, pypdf, shutil; shutil.copy('inputs/test.txt', 'tmp/副本.txt')"], check=True)
print("isolated")
''', files=[{"name": "test.txt", "bodyBase64": base64.b64encode(b"fixture").decode("ascii")}])
    assert result["status"] == "ok", result["stderr"]
    assert result["stdout"] == "isolated\n"
    assert result["inputHashes"][0]["name"] == "test.txt"
    outputs = {file["path"]: base64.b64decode(file["bodyBase64"]) for file in result["files"]}
    assert outputs == {"结果.txt": "处理: fixture".encode(), "复制.txt": b"fixture"}


def test_real_wall_timeout_and_memory_ceiling_leave_service_available():
    timeout = run("import time\ntime.sleep(5)", seconds=1)
    assert timeout["status"] == "timed_out"
    assert timeout["files"] == []
    memory = run("bytearray(900 * 1024 * 1024)")
    assert memory["status"] == "memory_limit"
    for exit_code in (73, 126):
        regular_exit = run(f"import os\nos._exit({exit_code})")
        assert (regular_exit["status"], regular_exit["exitCode"]) == ("failed", exit_code)
    assert run('print("available")')["status"] == "ok"


def test_path_and_artifact_guards():
    names = ["e\u0301.txt", "é.txt"]
    response = client.post("/run", json={
        "code": 'print("unused")', "timeoutSeconds": 2,
        "files": [{"name": name, "bodyBase64": "YQ=="} for name in names],
    })
    assert response.status_code == 422
    assert response.json() == {"code": "SANDBOX_DUPLICATE_INPUT"}
    output = client.post("/run", json={
        "code": 'from pathlib import Path\nPath("outputs/link").symlink_to("../program.py")',
        "timeoutSeconds": 15,
    })
    assert output.status_code == 422
    assert output.json() == {"code": "SANDBOX_OUTPUT_TYPE_REJECTED"}
    assert run('print("x" * 20000)')["stdoutTruncated"] is True
    assert run('print("甲" + chr(0) + "乙")')["stdout"] == "甲\ufffd乙\n"


def test_unselected_files_are_unreadable_and_deep_directories_are_cleaned():
    unrelated = SCRATCH / "unselected-fixture.txt"
    unrelated.write_text("synthetic", encoding="utf-8")
    try:
        result = run('''
from pathlib import Path
assert Path('/scratch/unselected-fixture.txt').exists()
try:
    Path('/scratch/unselected-fixture.txt').read_text()
    raise AssertionError('unselected contents are visible')
except PermissionError:
    pass
try:
    Path('/scratch/unselected-fixture.txt').chmod(0)
    raise AssertionError('unselected file permissions can be changed')
except PermissionError:
    pass
''')
        assert result["status"] == "ok", result["stderr"]
        response = client.post("/run", json={"code": '''
import os
os.chdir('outputs')
for _ in range(1_100):
    os.mkdir('x')
    os.chdir('x')
os.mkdir('unreadable', 0)
''', "timeoutSeconds": 10})
        assert response.status_code == 413
        assert not list(SCRATCH.glob("job-*"))
    finally:
        unrelated.unlink()


def test_job_processes_share_a_memory_ceiling():
    result = run('''
import subprocess, sys, time
program = "import time; memory = bytearray(410 * 1024 * 1024); time.sleep(8)"
for _ in range(2):
    subprocess.Popen([sys.executable, "-c", program])
time.sleep(8)
''', seconds=12)
    assert result["status"] == "memory_limit"
    assert run("pass")["status"] == "ok"


def test_orphans_are_reaped_after_repeated_job_shutdown():
    def zombies():
        count = 0
        for status in Path('/proc').glob('[0-9]*/status'):
            try:
                count += '\nState:\tZ' in status.read_text()
            except FileNotFoundError:
                pass
        return count

    baseline = zombies()
    for _ in range(4):
        timeout = run('''
import subprocess
from time import sleep
for _ in range(6):
    subprocess.Popen(["/usr/bin/sleep", "30"])
sleep(30)
''', seconds=1)
        assert timeout["status"] == "timed_out"
    for _ in range(10):
        if zombies() <= baseline:
            break
        sleep(0.05)
    assert zombies() <= baseline
    assert run("print('ready')")["status"] == "ok"


def test_libreoffice_preserves_chinese_and_pdf_artifacts():
    result = run('''
import os
import subprocess
from pathlib import Path
from docx import Document

document = Document()
document.add_paragraph("中文转换验证")
document.save("outputs/中文样例.docx")
profile = Path(os.environ["TMPDIR"]) / "office"
subprocess.run(["libreoffice", "-env:UserInstallation=" + profile.as_uri(), "--headless",
                "--convert-to", "pdf", "--outdir", "outputs", "outputs/中文样例.docx"],
               check=True)
''', seconds=30)
    assert result["status"] == "ok", result["stderr"]
    pdf = next(file for file in result["files"] if file["path"].endswith(".pdf"))
    reader = PdfReader(io.BytesIO(base64.b64decode(pdf["bodyBase64"])))
    assert "中文转换验证" in reader.pages[0].extract_text()


def test_pdf_merge_and_bookmarks_are_materialized():
    result = run('''
import io
from pypdf import PdfWriter

result = PdfWriter()
for title in ("第一份", "第二份"):
    document = PdfWriter()
    document.add_blank_page(width=612, height=792)
    content = io.BytesIO()
    document.write(content)
    content.seek(0)
    result.append(content, import_outline=False)
    result.add_outline_item(title, len(result.pages) - 1)
result.write("outputs/合并.pdf")
''')
    assert result["status"] == "ok", result["stderr"]
    reader = PdfReader(io.BytesIO(base64.b64decode(result["files"][0]["bodyBase64"])))
    assert len(reader.pages) == 2
    assert [item.title for item in reader.outline] == ["第一份", "第二份"]
