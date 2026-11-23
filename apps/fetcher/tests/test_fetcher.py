import base64
import hashlib
import http.client
import io
import json
import socket
import ssl
from concurrent.futures import ThreadPoolExecutor
from threading import BoundedSemaphore, Event, Semaphore, Thread
from time import monotonic

import pytest

import fetcher
from fetcher import FetchError, canonical_url, fetch_page, search_pages


class Reply:
    def __init__(self, status, body=b"", headers=None):
        self.status = status
        self.body = io.BytesIO(body)
        self.headers = headers or {}

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read1(self, limit):
        return self.body.read(limit)

    def close(self):
        self.body.close()


class Connection:
    def __init__(self, reply):
        self.reply = reply
        self.calls = []
        self.closed = False

    def set_tunnel(self, domain, port):
        self.calls.append((domain, port))

    def request(self, method, path, headers):
        self.calls.append((method, path, headers))

    def getresponse(self):
        return self.reply

    def close(self):
        self.closed = True


@pytest.mark.parametrize("url", [
    "http://www.fda.gov/", "https://127.0.0.1/", "https://10.0.0.1/", "https://[::1]/",
    "https://private.internal/", "https://fda.gov:5443/", "https://user:pass@fda.gov/",
    "https://fda.gov/%0d%0a", "https://fda.gov/unsafe\\host", "https://fda.gov/a#fragment",
    "https://fda.gov/file?%58-Amz-Signature=fixture", "https://fda.gov/file?access_token=fixture",
    "https://fda.gov/file?sig=fixture", "https://www.fda.gov/" + "界" * 300,
])
def test_rejects_unsafe_addresses_before_connecting(url):
    with pytest.raises(FetchError):
        fetch_page(url, lambda: pytest.fail("rejected request contacted the proxy"))


def test_uses_public_domain_tunnel_and_saves_original_with_safe_text():
    raw = b"<title>Regulatory guide</title><p>Public <b>text</b></p><script>ignore this</script>"
    proxy = Connection(Reply(200, raw, {"Content-Type": "text/html; charset=utf-8"}))
    result = fetch_page("https://www.fda.gov/guide?item=1", lambda: proxy)
    assert proxy.calls[0] == ("www.fda.gov", 443)
    assert proxy.calls[1][:2] == ("GET", "/guide?item=1")
    assert "Cookie" not in proxy.calls[1][2]
    assert proxy.closed
    assert result["text"] == "Public text"
    assert result["title"] == "Regulatory guide"
    assert result["sha256"] == hashlib.sha256(raw).hexdigest()
    assert base64.b64decode(result["bodyBase64"]) == raw


def test_url_preserves_node_serialization_of_square_brackets_and_query():
    address = "https://www.fda.gov/guides/[public]?item=%27known%27"
    proxy = Connection(Reply(200, b"page", {"Content-Type": "text/plain", "Content-Length": "4"}))
    assert fetch_page(address, lambda: proxy)["url"] == address
    assert proxy.calls[1][1] == "/guides/[public]?item=%27known%27"


def test_only_confirmed_official_query_empty_is_a_downloadable_snapshot():
    body = b'{"error":{"code":"NOT_FOUND","message":"No matches found!"}}'
    fda_url = "https://api.fda.gov/device/510k.json?search=fixture"
    supported = Connection(Reply(404, body, {"Content-Type": "application/json"}))
    assert base64.b64decode(fetch_page(fda_url, lambda: supported)["bodyBase64"]) == body

    for url, raw in [
        (fda_url, b'{"error":{"code":"NOT_FOUND","message":"endpoint removed"}}'),
        ("https://www.fda.gov/device/510k.json", body),
        ("https://api.fda.gov/other.json", body),
    ]:
        denied = Connection(Reply(404, raw, {"Content-Type": "application/json"}))
        with pytest.raises(FetchError, match="FETCH_UPSTREAM_STATUS"):
            fetch_page(url, lambda: denied)


@pytest.mark.parametrize("count,valid", [(63, True), (64, False)])
def test_query_field_limit_counts_empty_separators(count, valid):
    address = "https://www.fda.gov/guide?" + "&" * count + "item=1"
    if valid:
        assert canonical_url(address) == address
    else:
        with pytest.raises(FetchError, match="FETCH_URL_INVALID"):
            canonical_url(address)


@pytest.mark.parametrize("location,next_url", [
    ("/updated", "https://www.fda.gov/updated"),
    ("https://127.0.0.1/private", None),
    ("/private?sig=fixture", None),
])
def test_never_follows_redirects_without_another_review(location, next_url):
    proxy = Connection(Reply(302, headers={"Location": location}))
    with pytest.raises(FetchError) as failed:
        fetch_page("https://www.fda.gov/guide", lambda: proxy)
    assert failed.value.code == "FETCH_REDIRECT"
    assert failed.value.next_url == next_url
    assert len(proxy.calls) == 2
    assert proxy.closed


@pytest.mark.parametrize("headers,body,code", [
    ({"Content-Type": "application/octet-stream"}, b"binary", "FETCH_MEDIA_UNSUPPORTED"),
    ({"Content-Type": "text/html", "Content-Encoding": "gzip"}, b"text", "FETCH_MEDIA_UNSUPPORTED"),
    ({"Content-Type": "text/html", "Content-Length": "99999999"}, b"text", "FETCH_BODY_TOO_LARGE"),
    ({"Content-Type": "text/html", "Content-Length": "8"}, b"text", "FETCH_BODY_INCOMPLETE"),
    ({"Content-Type": "text/html", "Content-Length": "4", "Transfer-Encoding": "chunked"}, b"text", "FETCH_UPSTREAM_STATUS"),
    ({"Content-Type": "text/html"}, b"x" * (2 * 1024 * 1024 + 1), "FETCH_BODY_TOO_LARGE"),
    ({"Content-Type": "application/pdf"}, b"<html>", "FETCH_MEDIA_UNSUPPORTED"),
])
def test_rejects_non_archive_formats_and_oversized_bodies(headers, body, code):
    with pytest.raises(FetchError) as failed:
        fetch_page("https://www.fda.gov/source", lambda: Connection(Reply(200, body, headers)))
    assert failed.value.code == code


def test_pdf_is_archived_without_claiming_extracted_page_text():
    pdf = b"%PDF-1.7\n%%EOF"
    result = fetch_page("https://www.fda.gov/test.pdf", lambda: Connection(Reply(200, pdf, {"Content-Type": "application/pdf"})))
    assert result["text"] == ""
    assert base64.b64decode(result["bodyBase64"]) == pdf


def test_total_deadline_interrupts_incomplete_upstream_headers(monkeypatch):
    monkeypatch.setattr(fetcher, "TIMEOUT", 0.20)
    reader, writer = socket.socketpair()
    with reader, writer:
        class SlowProxy(Connection):
            sock = reader

            def getresponse(self):
                response = http.client.HTTPResponse(self.sock)
                response.begin()
                return response

        writer.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Partial")
        client = SlowProxy(None)
        before = monotonic()
        with pytest.raises(FetchError) as failed:
            fetch_page("https://www.fda.gov/source", lambda: client)
        assert failed.value.code == "FETCH_TIMEOUT"
        assert monotonic() - before < 1.5
        assert client.closed


def test_total_deadline_interrupts_tls_handshake_after_proxy_tunnel(monkeypatch):
    monkeypatch.setattr(fetcher, "TIMEOUT", 0.65)
    with socket.socket() as proxy:
        proxy.bind(("127.0.0.1", 0))
        proxy.listen()
        proxy.settimeout(1)
        connected = Event()
        handshake_started = Event()
        shutdown = Event()

        def tunnel_then_wait():
            upstream, _ = proxy.accept()
            with upstream:
                upstream.settimeout(1)
                request = b""
                while b"\r\n\r\n" not in request:
                    block = upstream.recv(4096)
                    if not block:
                        return
                    request += block
                if not request.startswith(b"CONNECT www.fda.gov:443 "):
                    return
                connected.set()
                upstream.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                if upstream.recv(4096):
                    handshake_started.set()
                shutdown.wait(1)

        thread = Thread(target=tunnel_then_wait, daemon=True)
        thread.start()
        client = fetcher.ServiceConnection("127.0.0.1", proxy.getsockname()[1], ssl.create_default_context())
        before = monotonic()
        try:
            with pytest.raises(FetchError, match="FETCH_TIMEOUT"):
                fetch_page("https://www.fda.gov/source", lambda: client)
            assert monotonic() - before < 1.25
            assert connected.is_set() and handshake_started.is_set()
            assert client.sock is None
        finally:
            shutdown.set()
            thread.join(1.5)


def test_dns_lookups_wait_for_a_free_slot_within_the_deadline(monkeypatch):
    monkeypatch.setattr(fetcher, "RESOLVERS", BoundedSemaphore(2))
    entered = Semaphore(0)
    allow_lookup = Event()
    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 3128))

    def lookup(_host, _port, **_options):
        entered.release()
        assert allow_lookup.wait(1)
        return [address]

    monkeypatch.setattr(socket, "getaddrinfo", lookup)
    with ThreadPoolExecutor(max_workers=3) as requests:
        def request():
            return fetcher.resolve_service("fetch-egress", 3128, monotonic() + 1)

        first = [requests.submit(request) for _ in range(2)]
        try:
            assert entered.acquire(timeout=1) and entered.acquire(timeout=1)
            queued = requests.submit(request)
            assert not entered.acquire(timeout=0.05)
        finally:
            allow_lookup.set()
        for response in [*first, queued]:
            assert response.result(timeout=1) == [address]


def test_connection_falls_back_when_the_first_socket_family_is_unavailable(monkeypatch):
    addresses = [
        (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", 3128, 0, 0)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 3128)),
    ]
    monkeypatch.setattr(fetcher, "resolve_service", lambda *_args: addresses)
    attempts = []

    class LocalSocket:
        def settimeout(self, seconds):
            assert seconds > 0

        def connect(self, address):
            assert address == addresses[1][4]

        def close(self):
            pass

    def create_socket(family, _kind, _protocol):
        attempts.append(family)
        if family == socket.AF_INET6:
            raise OSError("address family unavailable")
        return LocalSocket()

    monkeypatch.setattr(socket, "socket", create_socket)
    client = fetcher.ServiceConnection("fetch-egress", 3128)
    client.connect()
    try:
        assert attempts == [socket.AF_INET6, socket.AF_INET]
    finally:
        client.close()


def test_html_meta_charset_and_undecodable_body_preserve_original():
    domain = "https://www.fda.gov/localized"
    headers = {"Content-Type": "text/html"}
    raw = '<meta charset="gbk"><title>指南</title><p>可引用的内容。</p>'.encode("gbk")
    decoded = fetch_page(domain, lambda: Connection(Reply(200, raw, headers)))
    assert decoded["text"] == "可引用的内容。"
    assert decoded["title"] == "指南"
    bad = b"<p>\xff</p>"
    placeholder = fetch_page(domain, lambda: Connection(Reply(200, bad, headers)))
    assert placeholder["text"] == ""
    assert base64.b64decode(placeholder["bodyBase64"]) == bad

    utf32 = '公开😀正文'.encode('utf-32')
    result = fetch_page(domain, lambda: Connection(Reply(200, utf32, {"Content-Type": "text/html; charset=utf-32"})))
    assert result["text"] == ""
    assert base64.b64decode(result["bodyBase64"]) == utf32


def test_non_bmp_text_and_search_fit_the_shared_utf16_contract(monkeypatch):
    monkeypatch.setattr(fetcher, "MAX_TEXT", 3)
    raw = "😀😀".encode()
    response = Connection(Reply(200, raw, {"Content-Type": "text/plain"}))
    output = fetch_page("https://www.fda.gov/content", lambda: response)
    assert output["text"] == "😀"
    assert output["truncated"] is True
    reply = Reply(200, json.dumps({"results": [
        {"url": "https://www.fda.gov/" + "x" * 2048},
        {"url": "https://www.fda.gov/\ud800", "title": "invalid URL"},
        {"url": "https://www.fda.gov/guide", "title": "😀" * 120 + "\ud800", "content": "😀" * 280 + "\ud800"},
    ]}).encode())
    selected = search_pages("public", 5, lambda: Connection(reply))["items"]
    assert len(selected) == 1
    assert selected[0]["title"] == "😀" * 100
    assert selected[0]["snippet"] == "😀" * 250


def test_selects_searxng_results_without_accepting_private_links():
    reply = Reply(200, json.dumps({"results": [
        {"url": "https://127.0.0.1/", "title": "private"},
        {"url": "https://www.fda.gov/guide", "title": "Public guide", "content": "Official source"},
        {"url": "https://www.fda.gov/guide", "title": "duplicate"},
        {"url": "https://www.canada.ca/", "title": "Second result"},
    ]}).encode())
    search = Connection(reply)
    result = search_pages("FDA tools", 1, lambda: search)
    assert result == {"items": [{"url": "https://www.fda.gov/guide", "title": "Public guide", "snippet": "Official source"}]}
    assert search.calls[0][:2] == ("GET", "/search?q=FDA+tools&format=json")
    assert search.closed


def test_provider_unavailable_without_config(monkeypatch):
    monkeypatch.delenv("CERT_SEARXNG_ENABLED", raising=False)
    with pytest.raises(FetchError) as failed:
        search_pages("public documents", 5)
    assert failed.value.code == "SEARCH_PROVIDER_UNAVAILABLE"
    assert canonical_url("HTTPS://WWW.FDA.GOV") == "https://www.fda.gov/"
