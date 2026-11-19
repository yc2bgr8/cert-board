"""Read-only public-page fetch service on the dedicated fetch network."""

import base64
import hashlib
import http.client
import json
import os
import re
import ssl
from datetime import datetime, timezone
from html.parser import HTMLParser
from ipaddress import ip_address
from time import monotonic
from urllib.parse import quote, unquote, urlencode, urljoin, urlsplit, urlunsplit

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field


MAX_BODY = 2 * 1024 * 1024
MAX_TEXT = 64000
TIMEOUT = 8
MEDIA_TYPES = {"text/html", "application/xhtml+xml", "text/plain", "application/json", "application/pdf"}
PRIVATE_SUFFIXES = (".localhost", ".local", ".internal", ".invalid", ".test", ".example", ".onion", ".home.arpa")


class FetchError(Exception):
    def __init__(self, code, status=400, next_url=None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.next_url = next_url


def canonical_url(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 4000
            or re.search(r"[\x00-\x20\x7f\\]", value)):
        raise FetchError("FETCH_URL_INVALID")
    try:
        split = urlsplit(value)
        if (split.scheme != "https" or not split.hostname or split.username is not None
                or split.password is not None or split.port not in (None, 443) or split.fragment):
            raise FetchError("FETCH_URL_INVALID")
        host = split.hostname.encode("idna").decode("ascii").lower()
    except (ValueError, UnicodeError) as error:
        raise FetchError("FETCH_URL_INVALID") from error

    try:
        ip_address(host)
    except ValueError:
        pass
    else:
        raise FetchError("FETCH_DESTINATION_REJECTED", 403)
    if (host.endswith(PRIVATE_SUFFIXES) or not re.fullmatch(
            r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}", host)):
        raise FetchError("FETCH_DESTINATION_REJECTED", 403)
    if re.search(r"[\x00-\x1f\x7f\\]", unquote(split.path + split.query)):
        raise FetchError("FETCH_URL_INVALID")
    path = quote(split.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(split.query, safe="/%?:@!$&'()*+,;=-._~[]")
    return urlunsplit(("https", host, path, query, ""))


class DocumentText(HTMLParser):
    silent_tags = {"script", "style", "template", "noscript", "svg"}
    blocks = {"p", "div", "li", "br", "section", "article", "tr", "h1", "h2", "h3", "h4", "pre"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ignored = []
        self.in_title = False
        self.title = []
        self.text = []

    def handle_starttag(self, tag, _attrs):
        if tag in self.silent_tags:
            self.ignored.append(tag)
        if not self.ignored:
            if tag == "title":
                self.in_title = True
            if tag in self.blocks:
                self.text.append("\n")

    def handle_endtag(self, tag):
        if self.ignored:
            if self.ignored[-1] == tag:
                self.ignored.pop()
            return
        if tag == "title":
            self.in_title = False
        if tag in self.blocks:
            self.text.append("\n")

    def handle_data(self, data):
        if not self.ignored:
            (self.title if self.in_title else self.text).append(data)


def plain_text(value):
    safe = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]", "", value)
    cleaned = re.sub(r"[^\S\n]+", " ", safe.replace("\r", "\n"))
    return re.sub(r"\n(?:[ \n])*\n", "\n\n", cleaned).strip()


def decode_text(body, content_type):
    charset = re.search(r"charset\s*=\s*[\"']?([\w-]+)", content_type, re.IGNORECASE)
    codec = charset.group(1).lower() if charset else "utf-8"
    if codec not in {"utf-8", "utf8", "gbk", "gb18030", "windows-1252", "iso-8859-1"}:
        codec = "utf-8"
    return body.decode(codec, errors="replace").replace("\0", "")


def extract(body, content_type, media_type, url):
    title = urlsplit(url).hostname
    if media_type == "application/pdf":
        return title, "", False
    decoded = decode_text(body, content_type)
    if media_type in {"text/html", "application/xhtml+xml"}:
        parser = DocumentText()
        parser.feed(decoded)
        parser.close()
        title = " ".join("".join(parser.title).split())[:200] or title
        decoded = "".join(parser.text)
    text = plain_text(decoded)
    return title, text[:MAX_TEXT], len(text) > MAX_TEXT


def public_connection():
    return http.client.HTTPSConnection(
        "fetch-egress", 3128, timeout=TIMEOUT, context=ssl.create_default_context()
    )


def bounded_read(reply):
    declared = reply.getheader("Content-Length")
    if declared is not None:
        if not re.fullmatch(r"[0-9]{1,12}", declared):
            raise FetchError("FETCH_UPSTREAM_STATUS", 502)
        if int(declared) > MAX_BODY:
            raise FetchError("FETCH_BODY_TOO_LARGE", 413)
    deadline = monotonic() + TIMEOUT
    chunks = bytearray()
    while len(chunks) <= MAX_BODY:
        if monotonic() >= deadline:
            raise FetchError("FETCH_PROXY_UNAVAILABLE", 502)
        piece = reply.read1(min(65536, MAX_BODY + 1 - len(chunks)))
        if not piece:
            return bytes(chunks)
        chunks.extend(piece)
    raise FetchError("FETCH_BODY_TOO_LARGE", 413)


def fetch_page(value, connect=public_connection):
    url = canonical_url(value)
    target = urlsplit(url)
    connection = connect()
    try:
        connection.set_tunnel(target.hostname, 443)
        path = target.path + ("?" + target.query if target.query else "")
        connection.request("GET", path, headers={
            "Accept": "text/html,application/pdf,text/plain,application/json",
            "Accept-Encoding": "identity", "Connection": "close", "User-Agent": "cert-board-fetcher/1",
            "Host": target.hostname,
        })
        reply = connection.getresponse()
        if 300 <= reply.status < 400:
            try:
                next_url = canonical_url(urljoin(url, reply.getheader("Location", "")))
            except FetchError:
                next_url = None
            raise FetchError("FETCH_REDIRECT", 409, next_url if next_url != url else None)
        if not 200 <= reply.status < 300:
            raise FetchError("FETCH_UPSTREAM_STATUS", 502)
        content_type = reply.getheader("Content-Type", "")
        media_type = content_type.partition(";")[0].strip().lower()
        if media_type not in MEDIA_TYPES or reply.getheader("Content-Encoding", "identity").lower() != "identity":
            raise FetchError("FETCH_MEDIA_UNSUPPORTED", 415)
        content = bounded_read(reply)
        if media_type == "application/pdf" and not content.startswith(b"%PDF-"):
            raise FetchError("FETCH_MEDIA_UNSUPPORTED", 415)
    except (OSError, http.client.HTTPException) as error:
        raise FetchError("FETCH_PROXY_UNAVAILABLE", 502) from error
    finally:
        connection.close()
    title, text, truncated = extract(content, content_type, media_type, url)
    return {
        "url": url, "title": title, "text": text, "truncated": truncated, "mediaType": media_type,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "sha256": hashlib.sha256(content).hexdigest(),
        "bodyBase64": base64.b64encode(content).decode("ascii"),
    }


def search_pages(query, limit, connect=None):
    if connect is None and os.environ.get("CERT_SEARXNG_ENABLED") != "1":
        raise FetchError("SEARCH_PROVIDER_UNAVAILABLE", 503)
    connection = connect() if connect is not None else http.client.HTTPConnection("searxng", 8080, timeout=TIMEOUT)
    try:
        path = "/search?" + urlencode({"q": query, "format": "json"})
        connection.request("GET", path, headers={"Accept": "application/json", "Connection": "close"})
        response = connection.getresponse()
        if response.status != 200:
            raise FetchError("SEARCH_PROVIDER_UNAVAILABLE", 502)
        payload = bounded_read(response)
        document = json.loads(payload)
        if not isinstance(document, dict) or not isinstance(document.get("results"), list):
            raise FetchError("SEARCH_PROVIDER_INVALID", 502)
    except (OSError, ValueError, http.client.HTTPException) as error:
        raise FetchError("SEARCH_PROVIDER_UNAVAILABLE", 502) from error
    finally:
        connection.close()
    items = []
    seen = set()
    for entry in document["results"][:100]:
        if not isinstance(entry, dict):
            continue
        try:
            url = canonical_url(entry.get("url"))
        except FetchError:
            continue
        if url in seen:
            continue
        seen.add(url)
        raw_title = entry.get("title")
        raw_content = entry.get("content")
        title = plain_text(raw_title)[:200] if isinstance(raw_title, str) else url[:200]
        snippet = plain_text(raw_content)[:500] if isinstance(raw_content, str) else ""
        items.append({"url": url, "title": title or urlsplit(url).hostname, "snippet": snippet})
        if len(items) >= limit:
            break
    return {"items": items}


class FetchInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    url: str = Field(min_length=1, max_length=4000)


class SearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    query: str = Field(min_length=1, max_length=1200)
    limit: int = Field(default=5, ge=1, le=10)


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(FetchError)
async def fetch_error(_request, error):
    return JSONResponse({"code": error.code, "nextUrl": error.next_url}, status_code=error.status)


@app.exception_handler(RequestValidationError)
async def validation_error(_request, _error):
    return JSONResponse({"code": "FETCH_INPUT_INVALID", "nextUrl": None}, status_code=400)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/fetch")
def fetch(input: FetchInput):
    return fetch_page(input.url)


@app.post("/search")
def search(input: SearchInput):
    return search_pages(input.query, input.limit)
