"""Isolated byte-in, document-out service. Callers retrieve and authorize files first."""

import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import subprocess
import sys
from collections import OrderedDict
from contextlib import suppress
from pathlib import Path
from threading import Lock
from typing import Literal

from anyio import fail_after, to_thread
from fastapi import FastAPI, Header, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.requests import ClientDisconnect

from parsers import MAX_INPUT, MAX_PAGES, DocError


Kind = Literal["pdf", "estar", "doc", "docx", "xlsx"]
HASH_PATTERN = "^[a-f0-9]{64}$"
operation_lock = Lock()
upload_lock = Lock()
worker_file = Path(__file__).with_name("doc_worker.py")
worker_timeouts = {"parse": 370, "text": 370, "convert": 100, "render": 30}


class CachedSource:
    def __init__(self, content):
        self.content = content
        self.token = secrets.token_urlsafe(32)

    def __len__(self):
        return len(self.content) + len(self.token)


class ByteCache:
    def __init__(self, maximum, items=64):
        self.maximum = maximum
        self.items = items
        self.values = OrderedDict()
        self.used = 0

    def get(self, key):
        value = self.values.get(key)
        if value is not None:
            self.values.move_to_end(key)
        return value

    def put(self, key, value):
        if len(value) > self.maximum:
            return
        existing = self.values.pop(key, None)
        if existing is not None:
            self.used -= len(existing)
        while self.values and (self.used + len(value) > self.maximum or len(self.values) >= self.items):
            _, expired = self.values.popitem(last=False)
            self.used -= len(expired)
        self.values[key] = value
        self.used += len(value)


sources = ByteCache(144 * 1024 * 1024)
parsed_results = ByteCache(128 * 1024 * 1024)
converted_pdfs = ByteCache(96 * 1024 * 1024)
page_images = ByteCache(48 * 1024 * 1024)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(DocError)
async def document_error(_request, error):
    return JSONResponse({"code": error.code}, status_code=error.status)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, _error):
    return JSONResponse({"code": "DOC_INPUT_INVALID"}, status_code=400)


async def upload(request, expected):
    if request.headers.get("content-type", "").partition(";")[0].strip().lower() != "application/octet-stream":
        raise DocError("DOC_MEDIA_UNSUPPORTED", 415)
    if request.headers.get("content-encoding", "identity").lower() != "identity":
        raise DocError("DOC_MEDIA_UNSUPPORTED", 415)
    size = request.headers.get("content-length")
    if size is not None:
        if not re.fullmatch(r"[0-9]{1,12}", size):
            raise DocError("DOC_INPUT_INVALID", 400)
        if int(size) > MAX_INPUT:
            raise DocError("DOC_UPLOAD_LIMIT", 413)
    content = bytearray()
    digest = hashlib.sha256()
    try:
        with fail_after(30):
            async for block in request.stream():
                if len(content) + len(block) > MAX_INPUT:
                    raise DocError("DOC_UPLOAD_LIMIT", 413)
                content.extend(block)
                digest.update(block)
    except TimeoutError as error:
        raise DocError("DOC_UPLOAD_TIMEOUT", 408) from error
    except ClientDisconnect as error:
        raise DocError("DOC_UPLOAD_INCOMPLETE", 400) from error
    if size is not None and len(content) != int(size):
        raise DocError("DOC_UPLOAD_INCOMPLETE", 400)
    if not content or not hmac.compare_digest(digest.hexdigest(), expected):
        raise DocError("DOC_HASH_MISMATCH", 422)
    return bytes(content)


def run_operation(action, *arguments):
    if not operation_lock.acquire(blocking=False):
        raise DocError("DOC_BUSY", 429)
    try:
        return action(*arguments)
    except DocError:
        raise
    except Exception as error:
        raise DocError("DOC_PROCESSING_FAILED") from error
    finally:
        operation_lock.release()


def run_worker(action, data, kind, *arguments):
    command = [sys.executable, str(worker_file), action, kind, *arguments]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        output, _ = process.communicate(input=data, timeout=worker_timeouts[action])
    except subprocess.TimeoutExpired as error:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise DocError("DOC_PROCESSING_TIMEOUT", 504) from error
    if process.returncode == 0:
        return output
    if process.returncode == 1 and len(output) <= 256:
        result = json.loads(output)
        if re.fullmatch(r"DOC_[A-Z0-9_]{1,60}", result["code"]) and 400 <= result["status"] <= 599:
            raise DocError(result["code"], result["status"])
    raise DocError("DOC_PROCESSING_FAILED")


def upload_operation(data, key, action):
    result_key = (*key, action)
    cached = parsed_results.get(result_key)
    if cached is None:
        cached = run_worker(action, data, key[1])
        parsed_results.put(result_key, cached)
    source = sources.get(key)
    if source is None:
        source = CachedSource(data)
        sources.put(key, source)
    return cached, source.token


def rendered_image(key, page, token):
    source = sources.get(key)
    if source is None or token is None or not hmac.compare_digest(source.token, token):
        raise DocError("DOC_SOURCE_NOT_CACHED", 404)
    cache_key = (*key, page)
    image = page_images.get(cache_key)
    if image is not None:
        return image
    pdf_data = source.content if key[1] in {"pdf", "estar"} else converted_pdfs.get(key)
    if pdf_data is None:
        pdf_data = run_worker("convert", source.content, key[1])
        converted_pdfs.put(key, pdf_data)
    image = run_worker("render", pdf_data, key[1], str(page))
    page_images.put(cache_key, image)
    return image


async def uploaded_result(request, kind, digest, action):
    if not upload_lock.acquire(blocking=False):
        raise DocError("DOC_BUSY", 429)
    try:
        data = await upload(request, digest)
        result, token = await to_thread.run_sync(run_operation, upload_operation, data, (digest, kind), action)
        return Response(result, media_type="application/json",
                        headers={"cache-control": "no-store", "x-docsvc-preview": token})
    finally:
        upload_lock.release()


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/parse")
async def parse(request: Request, kind: Kind, content_sha256: str = Header(alias="X-Content-Sha256", pattern=HASH_PATTERN)):
    return await uploaded_result(request, kind, content_sha256, "parse")


@app.post("/text")
async def text(request: Request, kind: Kind, content_sha256: str = Header(alias="X-Content-Sha256", pattern=HASH_PATTERN)):
    return await uploaded_result(request, kind, content_sha256, "text")


@app.get("/render")
async def render(kind: Kind, sha256: str = Query(pattern=HASH_PATTERN), page: int = Query(ge=1, le=MAX_PAGES),
                 token: str | None = Header(default=None, alias="X-Docsvc-Preview", pattern=r"^[A-Za-z0-9_-]{43}$")):
    output = await to_thread.run_sync(run_operation, rendered_image, (sha256, kind), page, token)
    return Response(output[4:], media_type="image/png", headers={
        "cache-control": "no-store", "x-content-type-options": "nosniff",
        "x-docsvc-preview-pages": str(int.from_bytes(output[:4], "big")),
    })
