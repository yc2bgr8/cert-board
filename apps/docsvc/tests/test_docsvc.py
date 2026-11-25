import base64
import io
import json
from pathlib import Path
from time import monotonic
from zipfile import ZipFile

import docsvc
from docx import Document
from fastapi.testclient import TestClient
from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, TextStringObject

from docsvc import app, operation_lock
import compare_l08
from parsers import MAX_INPUT, convert_office, sha256


client = TestClient(app)
PDF_TEXT = "This fictional document contains more than forty readable characters."
DATASETS = b'<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><sample>fixture</sample></xfa:data></xfa:datasets>'


def sample_pdf(with_xfa=False, text_operator=None, field_value=None,
               xfa_template=None, xfa_envelope=None, compress_template=False):
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
        parts = [TextStringObject("datasets"), writer._add_object(packet)]
        if xfa_template is not None:
            template = DecodedStreamObject()
            template.set_data(xfa_template)
            if compress_template:
                template = template.flate_encode()
            parts += [TextStringObject("template"), writer._add_object(template)]
        value = ArrayObject(parts)
        if xfa_envelope is not None:
            envelope = DecodedStreamObject()
            envelope.set_data(xfa_envelope)
            value = writer._add_object(envelope)
        form = writer._add_object(DictionaryObject({
            NameObject("/Fields"): ArrayObject(),
            NameObject("/XFA"): value,
        }))
        writer.root_object[NameObject("/AcroForm")] = form
        writer.root_object[NameObject("/NeedsRendering")] = BooleanObject(True)
        writer.add_attachment("2026-01-01T12_fixture.txt", b"fictional attachment")
        writer.add_attachment("../safe-name.txt", b"fictional attachment")
        writer.encrypt("", owner_password="fixture-owner-only", algorithm="AES-256")
    if field_value is not None:
        appearance = TextStringObject("/F1 18 Tf 0 g")
        widget = writer._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/FT"): NameObject("/Tx"),
            NameObject("/T"): TextStringObject("SyntheticText"),
            NameObject("/V"): TextStringObject(field_value),
            NameObject("/DA"): appearance,
            NameObject("/Rect"): ArrayObject([NumberObject(n) for n in [50, 500, 260, 530]]),
            NameObject("/F"): NumberObject(4),
            NameObject("/P"): page.indirect_reference,
        }))
        page[NameObject("/Annots")] = ArrayObject([widget])
        writer.root_object[NameObject("/AcroForm")] = writer._add_object(DictionaryObject({
            NameObject("/Fields"): ArrayObject([widget]),
            NameObject("/DA"): appearance,
            NameObject("/DR"): page[NameObject("/Resources")],
            NameObject("/NeedAppearances"): BooleanObject(True),
        }))
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


def rewrite_sheet(data, old, new):
    adjusted = io.BytesIO()
    with ZipFile(io.BytesIO(data)) as source, ZipFile(adjusted, "w") as target:
        for name in source.namelist():
            entry = source.read(name)
            if name == "xl/worksheets/sheet1.xml":
                assert old in entry
                entry = entry.replace(old, new)
            target.writestr(name, entry)
    return adjusted.getvalue()


def assert_preview(data, kind, upload_response):
    params = {"kind": kind, "sha256": sha256(data), "page": 1}
    assert client.get("/render", params=params).status_code in {400, 404}
    headers = {"X-Docsvc-Preview": upload_response.headers["X-Docsvc-Preview"]}
    first = client.get("/render", params=params, headers=headers)
    assert first.status_code == 200, first.text if first.status_code != 200 else ""
    assert first.headers["content-type"] == "image/png"
    assert first.headers["cache-control"] == "no-store"
    assert int(first.headers["x-docsvc-preview-pages"]) >= 1
    assert first.content.startswith(b"\x89PNG\r\n\x1a\n")
    assert client.get("/render", params=params, headers=headers).content == first.content
    return headers


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
    headers = assert_preview(data, "pdf", result)
    missing = client.get("/render", params={"kind": "pdf", "sha256": sha256(data), "page": 5}, headers=headers)
    assert missing.status_code == 404


def test_pdf_preserves_t1_spacing_for_positioned_text():
    data = sample_pdf(text_operator=f"[({PDF_TEXT}) 500 (Next line.)] TJ")
    response = upload(data, "pdf")
    assert response.status_code == 200
    assert response.json()["pages"][0]["text"] == f"{PDF_TEXT} Next line."


def test_encrypted_estar_extracts_xfa_and_deduplicates_attachments():
    original = sample_pdf(with_xfa=True)
    result = upload(original, "estar")
    assert result.status_code == 200, result.text if result.status_code != 200 else ""
    data = result.json()
    assert base64.b64decode(data["xfaDatasetsBase64"]) == DATASETS
    assert len(data["attachments"]) == 1
    attachment = data["attachments"][0]
    assert attachment["name"] == "safe-name.txt"
    assert "safe-name.txt" in attachment["sourceNames"] and len(attachment["sourceNames"]) == 2
    assert attachment["sha256"] == sha256(b"fictional attachment")
    assert base64.b64decode(attachment["bodyBase64"]) == b"fictional attachment"
    preview = client.get("/render", params={"kind": "estar", "sha256": sha256(original), "page": 1},
                         headers={"X-Docsvc-Preview": result.headers["X-Docsvc-Preview"]})
    assert preview.status_code == 422
    assert preview.json() == {"code": "DOC_XFA_PREVIEW_UNAVAILABLE"}


def test_content_inspection_distinguishes_pdf_and_xfa_without_names():
    fda = '<template><desc><b>FDA</b> eSTAR fictional fixture at fda.gov.</desc></template>'
    ordinary = b"<template><desc>restart at fda.gov</desc></template>"
    split_word = b"<template><desc><b>not</b>eSTAR at fda.gov</desc></template>"
    separate_fields = b"<template><field>eSTAR</field><field>FDA at fda.gov</field></template>"
    multiline_fda = b"<template><p>Food and Drug <br/>Administration eSTAR</p></template>"
    samples = [
        (sample_pdf(), "pdf"),
        (sample_pdf(with_xfa=True), "pdf"),
        (sample_pdf(with_xfa=True, xfa_template=ordinary), "pdf"),
        (sample_pdf(with_xfa=True, xfa_template=split_word), "pdf"),
        (sample_pdf(with_xfa=True, xfa_template=separate_fields), "estar"),
        (sample_pdf(with_xfa=True, xfa_template=multiline_fda), "estar"),
        (sample_pdf(with_xfa=True, xfa_template=fda.encode("utf-16")), "estar"),
        (sample_pdf(with_xfa=True, xfa_template=fda.encode()), "estar"),
    ]
    for source, kind in samples:
        result = upload(source, "pdf", endpoint="inspect")
        assert result.status_code == 200
        assert result.json() == {"kind": kind, "byteSize": len(source), "sha256": sha256(source)}


def test_template_and_envelope_limits_are_independent_and_apply_during_decode(monkeypatch):
    import parsers
    import pytest

    monkeypatch.setattr(parsers, "MAX_XFA_TEMPLATE_BYTES", 100)
    template = b"<template><desc>eSTAR at fda.gov</desc></template>"
    envelope = b"<form>" + template + b"<datasets>" + b"sample " * 20 + b"</datasets></form>"
    nested = sample_pdf(with_xfa=True, xfa_envelope=envelope)
    assert len(envelope) > 100 and parsers.inspect_pdf(nested)["kind"] == "estar"
    long_template = sample_pdf(with_xfa=True, xfa_template=template + b" " * 150, compress_template=True)
    with pytest.raises(parsers.DocError) as rejected:
        parsers.inspect_pdf(long_template)
    assert rejected.value.code == "DOC_XFA_TEMPLATE_LIMIT"


def test_bounded_flate_decoding_applies_prediction():
    import pytest
    from pypdf.errors import PdfReadError
    from pypdf.generic import IndirectObject
    from parsers import DocError, bounded_xfa_data

    class MissingReference(IndirectObject):
        def get_object(self):
            raise PdfReadError("synthetic missing object")

    template = b"<template>fictional XML</template>"
    stream = DecodedStreamObject()
    stream.set_data(b"\0" + template)
    encoded = stream.flate_encode()
    writer = PdfWriter()
    encoded[NameObject("/Filter")] = ArrayObject([writer._add_object(NameObject("/FlateDecode"))])
    parameters = DictionaryObject({
        NameObject("/Predictor"): NumberObject(12),
        NameObject("/Columns"): NumberObject(len(template)),
    })
    encoded[NameObject("/DecodeParms")] = parameters
    assert bounded_xfa_data(encoded, len(template)) == template
    parameters[NameObject("/Predictor")] = TextStringObject("invalid fixture")
    with pytest.raises(DocError) as invalid:
        bounded_xfa_data(encoded, len(template))
    assert invalid.value.code == "DOC_XFA_INVALID"
    parameters[NameObject("/Predictor")] = NumberObject(12)
    missing = MissingReference(999, 0, writer)
    for reference in (missing, ArrayObject([missing])):
        encoded[NameObject("/DecodeParms")] = reference
        with pytest.raises(DocError) as broken:
            bounded_xfa_data(encoded, len(template))
        assert broken.value.code == "DOC_XFA_INVALID"
    encoded[NameObject("/DecodeParms")] = parameters
    encoded._data = encoded._data[:-2]
    with pytest.raises(DocError) as truncated:
        bounded_xfa_data(encoded, len(template))
    assert truncated.value.code == "DOC_XFA_INVALID"


def test_filled_pdf_form_is_drawn_in_page_preview():
    data = sample_pdf(field_value="Filled fixture value")
    uploaded = upload(data, "pdf")
    preview = client.get("/render", params={"kind": "pdf", "sha256": sha256(data), "page": 1},
                         headers={"X-Docsvc-Preview": uploaded.headers["X-Docsvc-Preview"]})
    assert preview.status_code == 200
    with Image.open(io.BytesIO(preview.content)) as image:
        region = image.convert("L").crop((110, 534, 500, 584))
        assert sum(pixel < 80 for pixel in region.get_flattened_data()) > 20


def test_office_text_and_layout_use_the_local_converter():
    for data, kind, expected in [(word_bytes(), "docx", "合成 Word 原文"), (sheet_bytes(), "xlsx", "编号 | 7")]:
        result = upload(data, kind)
        assert result.status_code == 200, result.text if result.status_code != 200 else ""
        assert result.json()["pages"][0]["locatorKind"] == "extraction_unit"
        assert expected in result.json()["pages"][0]["text"]
        plain = upload(data, kind, endpoint="text")
        assert plain.status_code == 200
        assert expected in plain.json()["text"]
        assert_preview(data, kind, result)


def test_word_comparison_keeps_document_order_and_repeated_columns():
    document = Document()
    document.add_paragraph("前一段")
    row = document.add_table(rows=1, cols=3).rows[0]
    for cell, text in zip(row.cells, ["合格", "合格", "待确认"]):
        cell.text = text
    document.add_paragraph("后一段")
    output = io.BytesIO()
    document.save(output)
    result = upload(output.getvalue(), "docx", endpoint="text")
    assert result.json()["text"] == "前一段\n合格 | 合格 | 待确认\n后一段"
    assert result.json()["paragraphs"] == ["前一段", '表格行 ["合格", "合格", "待确认"]', "后一段"]


def test_word_comparison_disambiguates_table_cell_boundaries():
    def compare(cells):
        document = Document()
        row = document.add_table(rows=1, cols=2).rows[0]
        for cell, value in zip(row.cells, cells):
            cell.text = value
        output = io.BytesIO()
        document.save(output)
        return upload(output.getvalue(), "docx", endpoint="text").json()

    before, after = compare(["5 | 10", "20"]), compare(["5", "10 | 20"])
    assert before["text"] == after["text"]
    assert before["paragraphs"] != after["paragraphs"]


def test_spreadsheet_comparison_keeps_formulas_beyond_stale_dimensions():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"] = "清单"
    sheet["B2"] = "=1+2"
    output = io.BytesIO()
    workbook.save(output)
    adjusted = rewrite_sheet(output.getvalue(), b'<dimension ref="A1:B2"', b'<dimension ref="A1:A1"')
    result = upload(adjusted, "xlsx", endpoint="text")
    assert "=1+2" in result.json()["text"]


def test_spreadsheet_keeps_known_width_and_reports_changed_formula_cache():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"] = "清单"
    sheet["B2"] = "=TODAY()"
    output = io.BytesIO()
    workbook.save(output)
    raw = output.getvalue()
    before = rewrite_sheet(raw, b"<v></v>", b"<v>47001</v>")
    after = rewrite_sheet(raw, b"<v></v>", b"<v>47002</v>")
    parsed = upload(before, "xlsx").json()["pages"][0]["text"]
    assert parsed == "清单 | \n | 47001"
    first = upload(before, "xlsx", endpoint="text").json()["text"]
    second = upload(after, "xlsx", endpoint="text").json()["text"]
    assert "=TODAY() [47001]" in first
    assert "=TODAY() [47002]" in second
    inflated_dimensions = rewrite_sheet(before, b'<dimension ref="A1:B2"', b'<dimension ref="A1:D2"')
    assert upload(inflated_dimensions, "xlsx", endpoint="text").json()["text"] == first


def test_word_preview_reports_physical_count_separately_from_extraction_units():
    document = Document()
    document.add_paragraph("第一页")
    document.add_page_break()
    document.add_paragraph("第二页")
    output = io.BytesIO()
    document.save(output)
    data = output.getvalue()
    parsed = upload(data, "docx")
    assert parsed.json()["pageCount"] == 1
    first = client.get("/render", params={"kind": "docx", "sha256": sha256(data), "page": 1},
                       headers={"X-Docsvc-Preview": parsed.headers["X-Docsvc-Preview"]})
    assert first.status_code == 200
    assert first.headers["x-docsvc-preview-pages"] == "2"


def test_cached_preview_requires_fresh_proof_after_source_eviction(monkeypatch):
    monkeypatch.setattr(docsvc, "sources", docsvc.ByteCache(1024 * 1024, items=1))
    data = sample_pdf()
    result = upload(data, "pdf")
    headers = assert_preview(data, "pdf", result)
    other = sample_pdf(text_operator=f"({PDF_TEXT} Added.) Tj")
    assert upload(other, "pdf").status_code == 200
    params = {"kind": "pdf", "sha256": sha256(data), "page": 1}
    assert client.get("/render", params=params, headers=headers).status_code == 404
    refreshed = upload(data, "pdf")
    assert refreshed.headers["X-Docsvc-Preview"] != headers["X-Docsvc-Preview"]
    assert client.get("/render", params=params, headers=headers).status_code == 404
    assert_preview(data, "pdf", refreshed)


def test_worker_is_terminated_at_deadline_and_next_request_recovers(monkeypatch, tmp_path):
    stalled_worker = tmp_path / "stalled_worker.py"
    stalled_worker.write_text(
        "import os, time\nfrom pathlib import Path\n"
        "work = Path(os.environ['TMPDIR'])\n(work / 'synthetic.pdf').write_bytes(b'fixture')\n"
        "Path(__file__).with_name('job-path').write_text(str(work))\ntime.sleep(60)\n",
        encoding="utf-8",
    )
    data = sample_pdf(text_operator=f"({PDF_TEXT} Timeout fixture.) Tj")
    with monkeypatch.context() as temporary:
        temporary.setattr(docsvc, "worker_file", stalled_worker)
        temporary.setitem(docsvc.worker_timeouts, "parse", 0.75)
        result = upload(data, "pdf")
        assert result.status_code == 504
        assert result.json() == {"code": "DOC_PROCESSING_TIMEOUT"}
        assert not Path((tmp_path / "job-path").read_text()).exists()
    assert upload(data, "pdf").status_code == 200


def test_l08_comparison_fails_on_missing_office_text(monkeypatch, tmp_path, capsys):
    source = tmp_path / "sample.doc"
    source.write_bytes(b"fictional legacy fixture")
    records = [{"id": "D001", "source_type": "外层文件夹", "name": source.name, "ext": ".doc",
                "path": source.name, "sha256": sha256(source.read_bytes())}]
    (tmp_path / "documents.json").write_text(json.dumps(records), encoding="utf-8")
    (tmp_path / "pages.jsonl").write_text(
        json.dumps({"doc": "D001", "page": 1, "method": "docx", "text": "Expected source."}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(compare_l08, "parse_document", lambda *args: {"pages": [{"text": ""}]})
    assert compare_l08.compare(tmp_path, tmp_path) == 1
    report = json.loads(capsys.readouterr().out)
    assert any(row["reason"] == "office_text_missing" for row in report["differences"])


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


def test_ocr_disables_runtime_telemetry_before_initializing_engine(monkeypatch):
    import onnxruntime
    import pypdfium2
    import rapidocr_onnxruntime
    from parsers import LocalOCR

    order = []
    monkeypatch.setattr(onnxruntime, "disable_telemetry_events", lambda: order.append("disabled"))

    def make_engine(**_options):
        order.append("engine")
        return lambda _image: ([], 0)

    monkeypatch.setattr(rapidocr_onnxruntime, "RapidOCR", make_engine)
    with pypdfium2.PdfDocument(sample_pdf()) as document:
        LocalOCR().recognize(document, 0)
    assert order == ["disabled", "engine"]


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
