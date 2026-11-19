"""Isolated byte-in, document-out service. Callers retrieve and authorize files first."""

import hashlib
import hmac
import json
import re
from collections import OrderedDict
from threading import Lock
from typing import Literal

from anyio import fail_after, to_thread
from fastapi import FastAPI, Header, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.requests import ClientDisconnect

from parsers import MAX_INPUT, MAX_PAGES, DocError, LocalOCR, parse_document, pdf_for_render, render_page


Kind = Literal["pdf", "estar", "doc", "docx", "xlsx"]
HASH_PATTERN = "^[a-f0-9]{64}$"
operation_lock = Lock()
upload_lock = Lock()
ocr = LocalOCR()


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


def serialized(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


def ensure_parsed(data, kind, key):
    cached = parsed_results.get(key)
    if cached is None:
        result = parse_document(data, kind, ocr)
        cached = serialized(result)
        parsed_results.put(key, cached)
    sources.put(key, data)
    return cached


def text_result(data, kind, key):
    parsed = json.loads(ensure_parsed(data, kind, key))
    return serialized({"sha256": key[0], "pageCount": parsed["pageCount"],
                       "text": "\n\n".join(page["text"] for page in parsed["pages"])})


def rendered_image(key, page):
    cache_key = (*key, page)
    image = page_images.get(cache_key)
    if image is not None:
        return image
    original = sources.get(key)
    if original is None:
        raise DocError("DOC_SOURCE_NOT_CACHED", 404)
    pdf_data = original if key[1] in {"pdf", "estar"} else converted_pdfs.get(key)
    if pdf_data is None:
        pdf_data = pdf_for_render(original, key[1])
        converted_pdfs.put(key, pdf_data)
    image = render_page(pdf_data, page)
    page_images.put(cache_key, image)
    return image


async def uploaded_result(request, kind, digest, action):
    if not upload_lock.acquire(blocking=False):
        raise DocError("DOC_BUSY", 429)
    try:
        data = await upload(request, digest)
        result = await to_thread.run_sync(run_operation, action, data, kind, (digest, kind))
        return Response(result, media_type="application/json", headers={"cache-control": "no-store"})
    finally:
        upload_lock.release()


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/parse")
async def parse(request: Request, kind: Kind, content_sha256: str = Header(alias="X-Content-Sha256", pattern=HASH_PATTERN)):
    return await uploaded_result(request, kind, content_sha256, ensure_parsed)


@app.post("/text")
async def text(request: Request, kind: Kind, content_sha256: str = Header(alias="X-Content-Sha256", pattern=HASH_PATTERN)):
    return await uploaded_result(request, kind, content_sha256, text_result)


@app.get("/render")
async def render(kind: Kind, sha256: str = Query(pattern=HASH_PATTERN), page: int = Query(ge=1, le=MAX_PAGES)):
    data = await to_thread.run_sync(run_operation, rendered_image, (sha256, kind), page)
    return Response(data, media_type="image/png", headers={"cache-control": "no-store", "x-content-type-options": "nosniff"})
