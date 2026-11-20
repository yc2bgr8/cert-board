import base64
import io

from fastapi.testclient import TestClient
from pypdf import PdfReader

from sandbox import app


client = TestClient(app)


def run(code, seconds=15, files=None):
    response = client.post("/run", json={"code": code, "timeoutSeconds": seconds, "files": files or []})
    assert response.status_code == 200, response.json()
    return response.json()


def test_outputs_are_isolated_and_no_credentials_or_network_reach_the_program(monkeypatch):
    monkeypatch.setenv("SANDBOX_FIXTURE_TOKEN", "synthetic-value")
    result = run(r'''
from pathlib import Path
import os, socket

assert os.getuid() != 0
assert "SANDBOX_FIXTURE_TOKEN" not in os.environ
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
print("isolated")
''', files=[{"name": "test.txt", "bodyBase64": base64.b64encode(b"fixture").decode("ascii")}])
    assert result["status"] == "ok", result["stderr"]
    assert result["stdout"] == "isolated\n"
    assert result["inputHashes"][0]["name"] == "test.txt"
    assert result["files"][0]["path"] == "结果.txt"
    assert base64.b64decode(result["files"][0]["bodyBase64"]).decode("utf-8") == "处理: fixture"


def test_real_wall_timeout_and_memory_ceiling_leave_service_available():
    timeout = run("import time\ntime.sleep(5)", seconds=1)
    assert timeout["status"] == "timed_out"
    assert timeout["files"] == []
    memory = run("bytearray(900 * 1024 * 1024)")
    assert memory["status"] == "memory_limit"
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
