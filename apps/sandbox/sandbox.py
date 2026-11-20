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
from contextlib import suppress
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
SCRATCH = Path("/scratch")
RUNNER = Path(__file__).with_name("runner.py")
gate = Lock()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class SandboxError(Exception):
    def __init__(self, code, status=422):
        self.code = code
        self.status = status


class InputFile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=160)
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
        or re.search(r"[:/\\]", name)
        or any(unicodedata.category(character).startswith("C") for character in name)
        or len(name.encode("utf-8")) > 200
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
        "PATH": "/usr/local/bin:/usr/bin:/bin",
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
    with (root / "stdout").open("wb") as stdout, (root / "stderr").open("wb") as stderr:
        child = subprocess.Popen(
            [sys.executable, str(RUNNER), str(root), str(seconds)],
            cwd=root, env=environment, stdin=subprocess.DEVNULL,
            stdout=stdout, stderr=stderr, start_new_session=True,
        )
        deadline = monotonic() + seconds
        timed_out = False
        try:
            while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG) is None:
                if disconnected.is_set():
                    break
                if monotonic() >= deadline:
                    timed_out = True
                    break
                sleep(0.02)
        finally:
            # 子进程尚未回收，PID 不会在清理进程组期间被复用。
            with suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    status = ("timed_out" if timed_out or child.returncode == -signal.SIGXCPU else
              "ok" if child.returncode == 0 else "memory_limit" if child.returncode == 73 else "failed")
    return status, child.returncode


def console(path, root):
    with path.open("rb") as source:
        data = source.read(MAX_CONSOLE + 1)
    return data[:MAX_CONSOLE].decode("utf-8", errors="replace").replace(str(root), "."), len(data) > MAX_CONSOLE


def artifacts(root):
    files = []
    size = 0
    paths = set()
    for directory, folders, names in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in sorted([*folders, *names]):
            path = parent / name
            metadata = path.lstat()
            if stat.S_ISDIR(metadata.st_mode):
                continue
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise SandboxError("SANDBOX_OUTPUT_TYPE_REJECTED")
            relative = "/".join(file_name(part) for part in path.relative_to(root).parts)
            if relative in paths or len(relative) > 512:
                raise SandboxError("SANDBOX_PATH_REJECTED")
            paths.add(relative)
            size += metadata.st_size
            if size > MAX_OUTPUT or len(files) >= 32:
                raise SandboxError("SANDBOX_OUTPUT_LIMIT", 413)
            data = path.read_bytes()
            files.append({"path": relative, "byteSize": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                          "bodyBase64": base64.b64encode(data).decode("ascii")})
    return sorted(files, key=lambda row: row["path"])


def run(request, disconnected):
    started = monotonic()
    with tempfile.TemporaryDirectory(prefix="job-", dir=SCRATCH) as directory:
        root = Path(directory)
        inputs, outputs, temporary = (root / name for name in ("inputs", "outputs", "tmp"))
        for folder in (inputs, outputs, temporary):
            folder.mkdir(mode=0o700)
        input_hashes = materialize(request.files, inputs)
        code = request.code.encode("utf-8")
        (root / "program.py").write_bytes(code)
        status, exit_code = run_child(root, temporary, request.timeoutSeconds, disconnected)
        if exit_code == 126:
            raise SandboxError("SANDBOX_SETUP_FAILED", 503)
        stdout, stdout_truncated = console(root / "stdout", root)
        stderr, stderr_truncated = console(root / "stderr", root)
        return {"status": status, "exitCode": exit_code, "elapsedMs": round((monotonic() - started) * 1000),
                "codeSha256": hashlib.sha256(code).hexdigest(), "inputHashes": input_hashes,
                "stdout": stdout, "stderr": stderr, "stdoutTruncated": stdout_truncated,
                "stderrTruncated": stderr_truncated, "files": artifacts(outputs) if status == "ok" else []}


@app.get("/health")
async def health():
    return {"status": "ok"}


async def watch_disconnect(request, disconnected):
    while not disconnected.is_set():
        if await request.is_disconnected():
            disconnected.set()
            return
        await async_sleep(0.1)


@app.post("/run")
async def execute(request: Request):
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
