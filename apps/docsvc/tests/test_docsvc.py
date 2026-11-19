import base64
import io
from time import monotonic

from docx import Document
from fastapi.testclient import TestClient
from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, TextStringObject

from docsvc import app, operation_lock
from parsers import MAX_INPUT, convert_office, sha256


client = TestClient(app)
PDF_TEXT = "This fictional document contains more than forty readable characters."
DATASETS = b'<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><sample>fixture</sample></xfa:data></xfa:datasets>'


def sample_pdf(with_xfa=False, text_operator=None):
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = writer._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    }))
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
    })
    content = DecodedStreamObject()
    operator = text_operator or f"({PDF_TEXT}) Tj"
    content.set_data(f"BT /F1 12 Tf 50 700 Td {operator} ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(content)
    if with_xfa:
        packet = DecodedStreamObject()
        packet.set_data(DATASETS)
        form = writer._add_object(DictionaryObject({
            NameObject("/Fields"): ArrayObject(),
            NameObject("/XFA"): ArrayObject([TextStringObject("datasets"), writer._add_object(packet)]),
        }))
        writer.root_object[NameObject("/AcroForm")] = form
        writer.add_attachment("2026-01-01T12_fixture.txt", b"fictional attachment")
        writer.add_attachment("../safe-name.txt", b"fictional attachment")
        writer.encrypt("", owner_password="fixture-owner-only", algorithm="AES-256")
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def upload(data, kind, endpoint="parse", digest=None):
    return client.post(f"/{endpoint}", params={"kind": kind}, content=data, headers={
        "content-type": "application/octet-stream", "X-Content-Sha256": digest or sha256(data),
    })


def word_bytes():
    document = Document()
    document.add_paragraph("合成 Word 原文")
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "字段"
    table.cell(0, 1).text = "值"
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


def sheet_bytes():
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "清单"
    sheet.append(["编号", 7])
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


def assert_preview(data, kind):
    params = {"kind": kind, "sha256": sha256(data), "page": 1}
    first = client.get("/render", params=params)
    assert first.status_code == 200, first.text if first.status_code != 200 else ""
    assert first.headers["content-type"] == "image/png"
    assert first.headers["cache-control"] == "no-store"
    assert first.content.startswith(b"\x89PNG\r\n\x1a\n")
    assert client.get("/render", params=params).content == first.content


def test_pdf_text_parse_and_render():
    data = sample_pdf()
    result = upload(data, "pdf")
    assert result.status_code == 200, result.text if result.status_code != 200 else ""
    content = result.json()
    assert content["pageCount"] == 1
    assert content["sha256"] == sha256(data)
    assert content["pages"][0] == {"page": 1, "method": "text", "locatorKind": "physical_page", "text": PDF_TEXT}
    assert result.headers["cache-control"] == "no-store"
    assert upload(data, "pdf").content == result.content
    assert_preview(data, "pdf")
    missing = client.get("/render", params={"kind": "pdf", "sha256": sha256(data), "page": 5})
    assert missing.status_code == 404


def test_pdf_preserves_t1_spacing_for_positioned_text():
    data = sample_pdf(text_operator=f"[({PDF_TEXT}) 500 (Next line.)] TJ")
    response = upload(data, "pdf")
    assert response.status_code == 200
    assert response.json()["pages"][0]["text"] == f"{PDF_TEXT} Next line."


def test_encrypted_estar_extracts_xfa_and_deduplicates_attachments():
    result = upload(sample_pdf(with_xfa=True), "estar")
    assert result.status_code == 200, result.text if result.status_code != 200 else ""
    data = result.json()
    assert base64.b64decode(data["xfaDatasetsBase64"]) == DATASETS
    assert len(data["attachments"]) == 1
    attachment = data["attachments"][0]
    assert attachment["name"] == "safe-name.txt"
    assert attachment["sha256"] == sha256(b"fictional attachment")
    assert base64.b64decode(attachment["bodyBase64"]) == b"fictional attachment"


def test_office_text_and_layout_use_the_local_converter():
    for data, kind, expected in [(word_bytes(), "docx", "合成 Word 原文"), (sheet_bytes(), "xlsx", "编号 | 7")]:
        result = upload(data, kind)
        assert result.status_code == 200, result.text if result.status_code != 200 else ""
        assert result.json()["pages"][0]["locatorKind"] == "extraction_unit"
        assert expected in result.json()["pages"][0]["text"]
        plain = upload(data, kind, endpoint="text")
        assert plain.status_code == 200
        assert expected in plain.json()["text"]
        assert_preview(data, kind)


def test_legacy_word_is_converted_and_parsed():
    legacy = convert_office(word_bytes(), "docx", "doc", monotonic() + 90)
    parsed = upload(legacy, "doc")
    assert parsed.status_code == 200, parsed.text if parsed.status_code != 200 else ""
    assert "合成 Word 原文" in parsed.json()["pages"][0]["text"]


def test_image_only_page_is_recognized_locally():
    original = Image.new("RGB", (800, 300), "white")
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 48)
    ImageDraw.Draw(original).text((30, 100), "DOCUMENT FIXTURE", fill="black", font=font)
    output = io.BytesIO()
    original.save(output, format="PDF")
    parsed = upload(output.getvalue(), "pdf")
    assert parsed.status_code == 200, parsed.text if parsed.status_code != 200 else ""
    page = parsed.json()["pages"][0]
    assert page["method"] == "ocr"
    assert "DOCUMENT" in page["text"].upper()
    assert 0 < page["ocrScore"] <= 1


def test_request_limits_hash_and_document_errors_use_safe_codes():
    body = sample_pdf()
    wrong = upload(body, "pdf", digest="0" * 64)
    assert wrong.status_code == 422
    assert wrong.json() == {"code": "DOC_HASH_MISMATCH"}
    assert upload(body, "xlsx").json() == {"code": "DOC_PROCESSING_FAILED"}
    oversized = client.post("/parse", params={"kind": "pdf"}, content=b"", headers={
        "content-type": "application/octet-stream", "X-Content-Sha256": "0" * 64,
        "content-length": str(MAX_INPUT + 1),
    })
    assert oversized.status_code == 413
    short = client.post("/parse", params={"kind": "pdf"}, content=body, headers={
        "content-type": "application/octet-stream", "X-Content-Sha256": sha256(body),
        "content-length": str(len(body) + 1),
    })
    assert short.json() == {"code": "DOC_UPLOAD_INCOMPLETE"}
    assert client.get("/render", params={"kind": "pdf", "sha256": "a" * 64, "page": 1}).status_code == 404
    with operation_lock:
        busy = upload(body, "pdf")
    assert busy.status_code == 429
    assert busy.json() == {"code": "DOC_BUSY"}
