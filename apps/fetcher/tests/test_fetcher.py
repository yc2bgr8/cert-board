import base64
import hashlib
import io
import json

import pytest

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


@pytest.mark.parametrize("location,next_url", [
    ("/updated", "https://www.fda.gov/updated"),
    ("https://127.0.0.1/private", None),
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
