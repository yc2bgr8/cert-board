"""Read-only public-page fetch service on the dedicated fetch network."""

import base64
import codecs
import hashlib
import http.client
import json
import os
import re
import socket
import ssl
from contextlib import contextmanager, suppress
from datetime import datetime, timezone
from email.message import Message
from html.parser import HTMLParser
from ipaddress import ip_address
from queue import Empty, Queue
from time import monotonic
from threading import BoundedSemaphore, Event, Thread, Timer
from urllib.parse import parse_qsl, quote, unquote, urlencode, urljoin, urlsplit, urlunsplit

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field


MAX_BODY = 2 * 1024 * 1024
MAX_TEXT = 64000
MAX_URL = 2048
TIMEOUT = 8
MEDIA_TYPES = {"text/html", "application/xhtml+xml", "text/plain", "application/json", "application/pdf"}
PRIVATE_SUFFIXES = (".localhost", ".local", ".internal", ".invalid", ".test", ".example", ".onion", ".home.arpa")
CREDENTIAL_PARAMETER = re.compile(
    r"(?:(?:xamz|xgoog|xoss|awsaccess|googleaccess).+|"
    r".*(?:apikey|token|credential|signature|password|sessionid|secret)|"
    r"auth|authorization|bearer|code|key|policy|sig|session|jwt)"
)
HTML_MEDIA = {"text/html", "application/xhtml+xml"}
RESOLVERS = BoundedSemaphore(2)


class FetchError(Exception):
    def __init__(self, code, status=400, next_url=None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.next_url = next_url


def canonical_url(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= MAX_URL
            or re.search(r"[\s\x00-\x1f\x7f\ud800-\udfff\\]", value)):
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
    if (len(host) > 253 or host.endswith(PRIVATE_SUFFIXES) or not re.fullmatch(
            r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}", host)):
        raise FetchError("FETCH_DESTINATION_REJECTED", 403)
    try:
        address = split.path + split.query
        if ";" in split.query or re.search(r"%(?![0-9a-fA-F]{2})", address) or re.search(
            r"[\x00-\x1f\x7f\\]", unquote(address, errors="strict")
        ):
            raise FetchError("FETCH_URL_INVALID")
        for key, _ in parse_qsl(split.query, keep_blank_values=True, errors="strict", max_num_fields=64):
            if CREDENTIAL_PARAMETER.fullmatch(key.strip().lower().replace("-", "").replace("_", "")):
                raise FetchError("FETCH_URL_INVALID")
    except (ValueError, UnicodeError) as error:
        raise FetchError("FETCH_URL_INVALID") from error
    path = quote(split.path or "/", safe="/%:@!$&'()*+,;=-._~[]|^")
    query = quote(split.query, safe="/%?:@!$&()*+,;=-._~[]|^`{}")
    result = urlunsplit(("https", host, path, query, ""))
    if len(result) > MAX_URL:
        raise FetchError("FETCH_URL_INVALID")
    return result


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


def truncate_utf16(value, limit):
    return value.encode("utf-16-le", errors="replace")[:limit * 2].decode("utf-16-le", errors="ignore")


def header_charset(content_type):
    headers = Message()
    headers["Content-Type"] = content_type
    return headers.get_content_charset()


class HtmlEncoding(HTMLParser):
    charset = None

    def handle_starttag(self, tag, attributes):
        if tag == "meta" and self.charset is None:
            attrs = dict(attributes)
            self.charset = attrs.get("charset") or (
                header_charset(attrs.get("content") or "")
                if (attrs.get("http-equiv") or "").lower() == "content-type" else None
            )


def decode_text(body, content_type, media_type):
    if body.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        return None
    if body.startswith(codecs.BOM_UTF8):
        charset = "utf-8-sig"
    elif body.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        charset = "utf-16"
    else:
        charset = header_charset(content_type)
    if not charset and media_type in HTML_MEDIA:
        meta = HtmlEncoding()
        meta.feed(body[:1024].decode("ascii", errors="ignore"))
        meta.close()
        charset = meta.charset
    try:
        codec = codecs.lookup((charset or "utf-8").strip()).name
        if codec in {"utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "ascii",
                     "gbk", "gb18030", "cp1252", "iso8859-1", "big5", "shift_jis"}:
            return body.decode(codec, errors="strict").replace("\0", "")
    except (LookupError, UnicodeError, ValueError):
        pass
    return None


def extract(body, content_type, media_type, url):
    title = urlsplit(url).hostname
    if media_type == "application/pdf":
        return title, "", False
    decoded = decode_text(body, content_type, media_type)
    if decoded is None:
        return title, "", False
    if media_type in HTML_MEDIA:
        parser = DocumentText()
        parser.feed(decoded)
        parser.close()
        title = truncate_utf16(plain_text(" ".join("".join(parser.title).split())), 200) or title
        decoded = "".join(parser.text)
    text = plain_text(decoded)
    truncated = truncate_utf16(text, MAX_TEXT)
    return title, truncated, truncated != text


def remaining(deadline):
    seconds = deadline - monotonic()
    if seconds <= 0:
        raise FetchError("FETCH_TIMEOUT", 504)
    return seconds


def resolve_service(host, port, deadline):
    slots = RESOLVERS
    if not slots.acquire(timeout=remaining(deadline)):
        raise FetchError("FETCH_TIMEOUT", 504)
    result = Queue(maxsize=1)

    def resolve():
        try:
            result.put(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
        except OSError as error:
            result.put(error)
        finally:
            slots.release()

    try:
        Thread(target=resolve, daemon=True).start()
    except RuntimeError as error:
        slots.release()
        raise FetchError("FETCH_PROXY_UNAVAILABLE", 502) from error
    try:
        addresses = result.get(timeout=remaining(deadline))
    except Empty as error:
        raise FetchError("FETCH_TIMEOUT", 504) from error
    if isinstance(addresses, OSError):
        raise addresses
    return addresses


class ServiceConnection(http.client.HTTPConnection):
    def __init__(self, host, port, context=None):
        super().__init__(host, port, timeout=TIMEOUT)
        self.context = context
        self.deadline = monotonic() + TIMEOUT

    def connect(self):
        last_error = None
        for family, kind, protocol, _, address in resolve_service(self.host, self.port, self.deadline):
            try:
                self.sock = socket.socket(family, kind, protocol)
                self.sock.settimeout(remaining(self.deadline))
                self.sock.connect(address)
                break
            except OSError as error:
                if self.sock is not None:
                    self.sock.close()
                self.sock = None
                last_error = error
        if self.sock is None:
            raise last_error or OSError("internal service endpoint unavailable")
        if self.context is not None:
            if not self._tunnel_host:
                raise OSError("proxy tunnel is required")
            self.sock.settimeout(remaining(self.deadline))
            self._tunnel()
            # Publish the SSL socket before beginning the handshake so the deadline can interrupt it.
            self.sock = self.context.wrap_socket(
                self.sock, server_hostname=self._tunnel_host, do_handshake_on_connect=False
            )
            self.sock.settimeout(remaining(self.deadline))
            self.sock.do_handshake()
        self.sock.settimeout(remaining(self.deadline))


def public_connection():
    return ServiceConnection("fetch-egress", 3128, ssl.create_default_context())


@contextmanager
def request_deadline(connection):
    deadline = monotonic() + TIMEOUT
    if isinstance(connection, ServiceConnection):
        connection.deadline = deadline
    timed_out = Event()
    upstream = None

    def stop():
        timed_out.set()
        transport = upstream or getattr(connection, "sock", None)
        if transport is not None:
            with suppress(OSError):
                transport.shutdown(socket.SHUT_RDWR)

    def receive():
        nonlocal upstream
        # http.client can detach its socket when the response will close the connection.
        upstream = getattr(connection, "sock", None)
        return connection.getresponse()

    timer = Timer(TIMEOUT, stop)
    timer.daemon = True
    timer.start()
    try:
        yield receive, deadline
        if timed_out.is_set() or monotonic() >= deadline:
            raise FetchError("FETCH_TIMEOUT", 504)
    except (OSError, FetchError, http.client.HTTPException) as error:
        if ((timed_out.is_set() or monotonic() >= deadline)
                and not (isinstance(error, FetchError) and error.code == "FETCH_TIMEOUT")):
            raise FetchError("FETCH_TIMEOUT", 504) from error
        raise
    finally:
        timer.cancel()
        connection.close()


def bounded_read(reply, deadline):
    length = reply.getheader("Content-Length")
    declared = None
    if length is not None:
        if not re.fullmatch(r"[0-9]{1,12}", length) or reply.getheader("Transfer-Encoding"):
            raise FetchError("FETCH_UPSTREAM_STATUS", 502)
        declared = int(length)
        if declared > MAX_BODY:
            raise FetchError("FETCH_BODY_TOO_LARGE", 413)
    chunks = bytearray()
    while len(chunks) <= MAX_BODY:
        if monotonic() >= deadline:
            raise FetchError("FETCH_TIMEOUT", 504)
        piece = reply.read1(min(65536, MAX_BODY + 1 - len(chunks)))
        if not piece:
            if declared is not None and len(chunks) != declared:
                raise FetchError("FETCH_BODY_INCOMPLETE", 502)
            return bytes(chunks)
        chunks.extend(piece)
    raise FetchError("FETCH_BODY_TOO_LARGE", 413)


def fetch_page(value, connect=public_connection):
    url = canonical_url(value)
    target = urlsplit(url)
    connection = connect()
    try:
        with request_deadline(connection) as (receive, deadline):
            connection.set_tunnel(target.hostname, 443)
            path = target.path + ("?" + target.query if target.query else "")
            connection.request("GET", path, headers={
                "Accept": "text/html,application/pdf,text/plain,application/json",
                "Accept-Encoding": "identity", "Connection": "close", "User-Agent": "cert-board-fetcher/1",
                "Host": target.hostname,
            })
            with_response = receive()
            try:
                if 300 <= with_response.status < 400:
                    try:
                        next_url = canonical_url(urljoin(url, with_response.getheader("Location", "")))
                    except FetchError:
                        next_url = None
                    raise FetchError("FETCH_REDIRECT", 409, next_url if next_url != url else None)
                if with_response.status != 200:
                    raise FetchError("FETCH_UPSTREAM_STATUS", 502)
                content_type = with_response.getheader("Content-Type", "")
                media_type = content_type.partition(";")[0].strip().lower()
                if media_type not in MEDIA_TYPES or with_response.getheader("Content-Encoding", "identity").lower() != "identity":
                    raise FetchError("FETCH_MEDIA_UNSUPPORTED", 415)
                content = bounded_read(with_response, deadline)
            finally:
                with_response.close()
            if media_type == "application/pdf" and not content.startswith(b"%PDF-"):
                raise FetchError("FETCH_MEDIA_UNSUPPORTED", 415)
    except (OSError, http.client.HTTPException) as error:
        raise FetchError("FETCH_PROXY_UNAVAILABLE", 502) from error
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
    connection = connect() if connect is not None else ServiceConnection("searxng", 8080)
    try:
        with request_deadline(connection) as (receive, deadline):
            path = "/search?" + urlencode({"q": query, "format": "json"})
            connection.request("GET", path, headers={"Accept": "application/json", "Connection": "close"})
            response = receive()
            try:
                if response.status != 200:
                    raise FetchError("SEARCH_PROVIDER_UNAVAILABLE", 502)
                payload = bounded_read(response, deadline)
            finally:
                response.close()
        document = json.loads(payload)
        if not isinstance(document, dict) or not isinstance(document.get("results"), list):
            raise FetchError("SEARCH_PROVIDER_INVALID", 502)
    except (OSError, ValueError, http.client.HTTPException) as error:
        raise FetchError("SEARCH_PROVIDER_UNAVAILABLE", 502) from error
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
        title = truncate_utf16(plain_text(raw_title), 200) if isinstance(raw_title, str) else url[:200]
        snippet = truncate_utf16(plain_text(raw_content), 500) if isinstance(raw_content, str) else ""
        items.append({"url": url, "title": title or urlsplit(url).hostname, "snippet": snippet})
        if len(items) >= limit:
            break
    return {"items": items}


class FetchInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    url: str = Field(min_length=1, max_length=MAX_URL)


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
