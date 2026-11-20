"""Bounded document processing service; user programs run only in worker subprocesses."""

import base64
import hashlib
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import unicodedata
from contextlib import asynccontextmanager, contextmanager, suppress
from pathlib import Path
from threading import Event, Lock
from time import monotonic, sleep

from anyio import create_task_group, fail_after, sleep as async_sleep, to_thread
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.requests import ClientDisconnect


MAX_INPUT = 12 * 1024 * 1024
MAX_BODY = 18 * 1024 * 1024
MAX_OUTPUT = 12 * 1024 * 1024
MAX_CONSOLE = 16_384
JOB_MEMORY_LIMIT = 768 * 1024 * 1024
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
SCRATCH = Path("/scratch")
RUNNER = Path(__file__).with_name("runner.py")
gate = Lock()


@asynccontextmanager
async def lifespan(application):
    application.state.isolated = False
    probe_code = "import os\nassert os.getuid() != 0"
    try:
        probe = await to_thread.run_sync(run, RunRequest(code=probe_code, timeoutSeconds=5), Event())
        application.state.isolated = probe["status"] == "ok"
    except (SandboxError, OSError, ValueError):
        pass
    yield


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


class SandboxError(Exception):
    def __init__(self, code, status=422):
        self.code = code
        self.status = status


class InputFile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=320)
    bodyBase64: str = Field(max_length=16 * 1024 * 1024)


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    code: str = Field(min_length=1, max_length=24_000)
    timeoutSeconds: int = Field(ge=1, le=120)
    files: list[InputFile] = Field(default_factory=list, max_length=16)


@app.exception_handler(SandboxError)
async def error_response(_request, failure):
    return JSONResponse({"code": failure.code}, status_code=failure.status, headers={"cache-control": "no-store"})


def file_name(value):
    name = unicodedata.normalize("NFC", value)
    if (
        name.strip(" .") != name or not name or name in {".", ".."}
        or re.search(r'[:/\\<>"|?*]', name)
        or re.match(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", name, re.IGNORECASE | re.ASCII)
        or any(unicodedata.category(character).startswith("C") for character in name)
        or len(name) > 160 or len(name.encode("utf-8")) > 200
    ):
        raise SandboxError("SANDBOX_PATH_REJECTED")
    return name


def materialize(files, folder):
    used = 0
    inputs = []
    names = set()
    for item in files:
        name = file_name(item.name)
        if name in names:
            raise SandboxError("SANDBOX_DUPLICATE_INPUT")
        try:
            data = base64.b64decode(item.bodyBase64, validate=True)
        except ValueError as error:
            raise SandboxError("SANDBOX_INPUT_INVALID") from error
        names.add(name)
        used += len(data)
        if used > MAX_INPUT:
            raise SandboxError("SANDBOX_INPUT_LIMIT", 413)
        (folder / name).write_bytes(data)
        inputs.append({"name": name, "sha256": hashlib.sha256(data).hexdigest()})
    return inputs


def run_child(root, temporary, seconds, disconnected):
    environment = {
        "PATH": f"{Path(sys.executable).parent}:/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": str(temporary),
        "TMPDIR": str(temporary),
        "XDG_CACHE_HOME": str(temporary),
        "MPLCONFIGDIR": str(temporary),
        "SAL_USE_VCLPLUGIN": "svp",
        "OSL_SOCKET_PATH": str(temporary),
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
    }
    receiver, reporter = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        try:
            with (root / "stdout").open("wb") as stdout, (root / "stderr").open("wb") as stderr:
                child = subprocess.Popen(
                    [sys.executable, str(RUNNER), str(root), str(seconds), str(reporter)],
                    cwd=root, env=environment, stdin=subprocess.DEVNULL, pass_fds=(reporter,),
                    stdout=stdout, stderr=stderr, start_new_session=True,
                )
        finally:
            os.close(reporter)
        stopped = wait_for_job(child, seconds, disconnected)
        report = os.read(receiver, 2)
    finally:
        os.close(receiver)
    if stopped is None and not report.startswith(b"R"):
        raise SandboxError("SANDBOX_SETUP_FAILED", 503)
    status = (stopped if stopped else "timed_out" if child.returncode == -signal.SIGXCPU else
              "ok" if child.returncode == 0 else "memory_limit" if report == b"RM" else "failed")
    return status, child.returncode


def wait_for_job(child, seconds, disconnected):
    deadline = monotonic() + seconds
    try:
        while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG) is None:
            if disconnected.is_set():
                return "failed"
            if monotonic() >= deadline:
                return "timed_out"
            if job_rss(child.pid) > JOB_MEMORY_LIMIT:
                return "memory_limit"
            sleep(0.02)
        return None
    finally:
        # 子进程尚未回收，PID 不会在清理进程组期间被复用。
        with suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGKILL)
        child.wait()


def job_rss(group):
    pages = 0
    for entry in Path("/proc").iterdir():
        if not entry.name.isascii() or not entry.name.isdecimal():
            continue
        try:
            fields = (entry / "stat").read_bytes().rsplit(b")", 1)[1].split()
            if int(fields[2]) == group:
                pages += int(fields[21])
        except (FileNotFoundError, ProcessLookupError, IndexError, ValueError):
            pass
    return pages * PAGE_SIZE


def console(path, root):
    with path.open("rb") as source:
        data = source.read(MAX_CONSOLE + 1)
    visible = data[:MAX_CONSOLE].decode("utf-8", errors="replace")
    # 工具回执写入 JSONB，标准输出里的 NUL 必须转换成可存储的文本。
    return visible.replace("\0", "\ufffd").replace(str(root), "."), len(data) > MAX_CONSOLE


def artifacts(root):
    files = []
    size = 0
    paths = set()
    entries = 0
    def unavailable(_error):
        raise SandboxError("SANDBOX_OUTPUT_TYPE_REJECTED")

    for directory, folders, names in os.walk(root, onerror=unavailable, followlinks=False):
        parent = Path(directory)
        for name in sorted([*folders, *names]):
            path = parent / name
            entries += 1
            parts = path.relative_to(root).parts
            if entries > 128 or len(parts) > 12:
                raise SandboxError("SANDBOX_OUTPUT_LIMIT", 413)
            metadata = path.lstat()
            relative = "/".join(file_name(part) for part in parts)
            if len(relative.encode("utf-8")) > 512:
                raise SandboxError("SANDBOX_PATH_REJECTED")
            if stat.S_ISDIR(metadata.st_mode):
                if not metadata.st_mode & stat.S_IRUSR:
                    raise SandboxError("SANDBOX_OUTPUT_TYPE_REJECTED")
                continue
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise SandboxError("SANDBOX_OUTPUT_TYPE_REJECTED")
            if relative in paths:
                raise SandboxError("SANDBOX_PATH_REJECTED")
            paths.add(relative)
            size += metadata.st_size
            if size > MAX_OUTPUT or len(files) >= 32:
                raise SandboxError("SANDBOX_OUTPUT_LIMIT", 413)
            data = path.read_bytes()
            files.append({"path": relative, "byteSize": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                          "bodyBase64": base64.b64encode(data).decode("ascii")})
    return sorted(files, key=lambda row: row["path"])


def clear_tree(parent, name):
    # 使用目录描述符逐层清理，避免深目录触发 Python 递归或完整路径长度限制。
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

    def enter(directory, entry):
        os.chmod(entry, 0o700, dir_fd=directory)
        descriptor = os.open(entry, flags, dir_fd=directory)
        try:
            items = iter(os.listdir(descriptor))
        except BaseException:
            os.close(descriptor)
            raise
        return descriptor, (entry, items)

    descriptor, first = enter(parent, name)
    stack = [first]
    try:
        while stack:
            entry, items = stack[-1]
            child = next(items, None)
            if child is None:
                above = os.open("..", flags, dir_fd=descriptor)
                try:
                    os.rmdir(entry, dir_fd=above)
                except BaseException:
                    os.close(above)
                    raise
                os.close(descriptor)
                descriptor = above
                stack.pop()
            elif stat.S_ISDIR(os.stat(child, dir_fd=descriptor, follow_symlinks=False).st_mode):
                below, frame = enter(descriptor, child)
                os.close(descriptor)
                descriptor = below
                stack.append(frame)
            else:
                os.unlink(child, dir_fd=descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def job_directory():
    path = Path(tempfile.mkdtemp(prefix="job-", dir=SCRATCH))
    try:
        yield path
    finally:
        parent = os.open(SCRATCH, os.O_RDONLY | os.O_DIRECTORY)
        try:
            clear_tree(parent, path.name)
        except OSError as error:
            app.state.isolated = False
            raise SandboxError("SANDBOX_CLEANUP_FAILED", 503) from error
        finally:
            os.close(parent)


def run(request, disconnected):
    started = monotonic()
    with job_directory() as root:
        inputs, outputs, temporary = (root / name for name in ("inputs", "outputs", "tmp"))
        for folder in (inputs, outputs, temporary):
            folder.mkdir(mode=0o700)
        input_hashes = materialize(request.files, inputs)
        code = request.code.encode("utf-8")
        (root / "program.py").write_bytes(code)
        status, exit_code = run_child(root, temporary, request.timeoutSeconds, disconnected)
        stdout, stdout_truncated = console(root / "stdout", root)
        stderr, stderr_truncated = console(root / "stderr", root)
        return {"status": status, "exitCode": exit_code, "elapsedMs": round((monotonic() - started) * 1000),
                "codeSha256": hashlib.sha256(code).hexdigest(), "inputHashes": input_hashes,
                "stdout": stdout, "stderr": stderr, "stdoutTruncated": stdout_truncated,
                "stderrTruncated": stderr_truncated, "files": artifacts(outputs) if status == "ok" else []}


@app.get("/health")
async def health():
    if not app.state.isolated:
        raise SandboxError("SANDBOX_SETUP_FAILED", 503)
    return {"status": "ok"}


async def watch_disconnect(request, disconnected):
    while not disconnected.is_set():
        if await request.is_disconnected():
            disconnected.set()
            return
        await async_sleep(0.1)


@app.post("/run")
async def execute(request: Request):
    if not app.state.isolated:
        raise SandboxError("SANDBOX_SETUP_FAILED", 503)
    if request.headers.get("content-type", "").partition(";")[0].lower().strip() != "application/json":
        raise SandboxError("SANDBOX_INPUT_INVALID", 415)
    if request.headers.get("content-encoding", "identity").lower() != "identity":
        raise SandboxError("SANDBOX_INPUT_INVALID", 415)
    if not gate.acquire(blocking=False):
        raise SandboxError("SANDBOX_BUSY", 429)
    try:
        raw = bytearray()
        try:
            with fail_after(30):
                async for chunk in request.stream():
                    if len(raw) + len(chunk) > MAX_BODY:
                        raise SandboxError("SANDBOX_INPUT_LIMIT", 413)
                    raw.extend(chunk)
        except TimeoutError as error:
            raise SandboxError("SANDBOX_INPUT_TIMEOUT", 408) from error
        except ClientDisconnect as error:
            raise SandboxError("SANDBOX_INPUT_INVALID", 400) from error
        try:
            payload = RunRequest.model_validate_json(raw)
        except ValidationError as error:
            raise SandboxError("SANDBOX_INPUT_INVALID", 400) from error
        disconnected = Event()
        failure = None
        async with create_task_group() as tasks:
            tasks.start_soon(watch_disconnect, request, disconnected)
            try:
                result = await to_thread.run_sync(run, payload, disconnected)
            except SandboxError as error:
                failure = error
            except (OSError, ValueError):
                failure = SandboxError("SANDBOX_RUN_FAILED", 422)
            finally:
                tasks.cancel_scope.cancel()
        if failure is not None:
            raise failure
        return JSONResponse(result, headers={"cache-control": "no-store"})
    finally:
        gate.release()
