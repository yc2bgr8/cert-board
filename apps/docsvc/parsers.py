"""T1 conversion rules from sources/t1_parse/parse_l08.py, executed without network access."""

import base64
import hashlib
import io
import logging
import os
import re
import signal
import subprocess
import tempfile
import unicodedata
from contextlib import closing, suppress
from pathlib import Path
from time import monotonic
from xml.etree import ElementTree
from zipfile import ZipFile

import docx
import openpyxl
import pypdfium2 as pdfium
from defusedxml.ElementTree import fromstring
from pypdf import PdfReader, _page
from pypdf.generic import ArrayObject, StreamObject


KINDS = {"pdf", "estar", "doc", "docx", "xlsx"}
MAX_INPUT = 96 * 1024 * 1024
MAX_ATTACHMENTS = 64
MAX_ATTACHMENT_BYTES = 80 * 1024 * 1024
MAX_TEXT_BYTES = 6 * 1024 * 1024
MAX_PAGES = 800
MAX_XFA_BYTES = 5 * 1024 * 1024
OCR_THRESHOLD = 40
LONG_SIDE = 1600
MAX_OCR_SIDE = 3600
MAX_OPERATION_SECONDS = 360
LEGACY_WORD = bytes.fromhex("d0cf11e0a1b11ae1")
logging.getLogger("pypdf").disabled = True
logging.getLogger("pypdf").propagate = False
logging.getLogger("pypdf").addHandler(logging.NullHandler())


class T1TextExtraction(_page.TextExtraction):
    """Keep T1's text spacing with the pinned pypdf 7.1.1 parser."""

    def __init__(self):
        super().__init__()
        self.operation_handlers.pop(b"Tc", None)

    def _handle_tf(self, operands):
        super()._handle_tf(operands)
        self._previous_font_space = None

    def process_tj_offset(self, offset, space_width):
        if abs(offset) >= space_width and self.text and self.text[-1] != " ":
            self.process_operation(b"Tj", [" "])


# The service's private Python process uses this extractor for plain PDF text only.
# Keep the pypdf pin and run the T1 comparison when upgrading it.
_page.TextExtraction = T1TextExtraction


class DocError(Exception):
    def __init__(self, code, status=422):
        super().__init__(code)
        self.code = code
        self.status = status


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def check_time(deadline):
    if monotonic() >= deadline:
        raise DocError("DOC_PROCESSING_TIMEOUT", 504)


class TextBudget:
    def __init__(self):
        self.used = 0

    def add(self, value):
        self.used += len(value.encode("utf-8")) + 1
        if self.used > MAX_TEXT_BYTES:
            raise DocError("DOC_TEXT_LIMIT", 413)
        return value


def check_kind(data, kind):
    if kind not in KINDS:
        raise DocError("DOC_FORMAT_UNSUPPORTED", 415)
    if kind in {"pdf", "estar"} and not data.startswith(b"%PDF-"):
        raise DocError("DOC_FORMAT_MISMATCH", 415)
    if kind == "doc" and not data.startswith(LEGACY_WORD):
        raise DocError("DOC_FORMAT_MISMATCH", 415)
    if kind not in {"docx", "xlsx"}:
        return
    with ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        expected = "word/document.xml" if kind == "docx" else "xl/workbook.xml"
        if expected not in {entry.filename for entry in entries}:
            raise DocError("DOC_FORMAT_MISMATCH", 415)
        if len(entries) > 2500 or sum(info.file_size for info in entries) > 256 * 1024 * 1024:
            raise DocError("DOC_PACKAGE_LIMIT", 413)
        if any(info.filename.lower().endswith("vbaproject.bin") for info in entries):
            raise DocError("DOC_MACRO_UNSUPPORTED", 415)


class LocalOCR:
    def __init__(self):
        self.engine = None

    def recognize(self, pdf, index):
        if self.engine is None:
            from rapidocr_onnxruntime import RapidOCR

            self.engine = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
        with closing(pdf[index]) as page:
            width, height = page.get_size()
            side = max(width, height)
            if side <= 0:
                raise DocError("DOC_PAGE_DIMENSIONS_INVALID")
            # Preserve T1's normal scale while bounding unusually large pages.
            scale = min(max(2.0, min(6.0, LONG_SIDE / side)), MAX_OCR_SIDE / side)
            with closing(page.render(scale=scale)) as bitmap:
                image = bitmap.to_pil().copy()
        result, _ = self.engine(image)
        lines = [(str(text), float(score)) for _, text, score in (result or [])]
        average = sum(score for _, score in lines) / len(lines) if lines else 0.0
        return "\n".join(text for text, _ in lines), round(average, 3), len(lines)


def pdf_reader(data):
    reader = PdfReader(io.BytesIO(data), strict=False)
    if reader.is_encrypted and not reader.decrypt(""):
        raise DocError("DOC_PASSWORD_REQUIRED", 422)
    if len(reader.pages) > MAX_PAGES:
        raise DocError("DOC_PAGE_LIMIT", 413)
    return reader


def parse_pdf(data, kind, ocr, deadline):
    reader = pdf_reader(data)
    pages = []
    renderer = None
    budget = TextBudget()
    try:
        for index, page in enumerate(reader.pages):
            check_time(deadline)
            text = page.extract_text() or ""
            if len(re.sub(r"\s+", "", text)) >= OCR_THRESHOLD or kind == "estar":
                pages.append({"page": index + 1, "method": "text", "locatorKind": "physical_page", "text": budget.add(text)})
            else:
                if renderer is None:
                    renderer = pdfium.PdfDocument(data, password="")
                recognized, score, lines = ocr.recognize(renderer, index)
                pages.append({"page": index + 1, "method": "ocr", "locatorKind": "physical_page",
                              "text": budget.add(recognized or text), "ocrScore": score, "ocrLines": lines})
    finally:
        if renderer is not None:
            renderer.close()
    return pages, reader


def checked_xml(content):
    if len(content) > MAX_XFA_BYTES:
        raise DocError("DOC_XFA_LIMIT", 413)
    return fromstring(content, forbid_dtd=True)


def xfa_datasets(reader):
    if "/AcroForm" not in reader.root_object:
        return None
    form = reader.root_object["/AcroForm"].get_object()
    reference = form.get("/XFA")
    if reference is None:
        return None
    value = reference.get_object()
    if isinstance(value, ArrayObject):
        for index in range(0, len(value) - 1, 2):
            if str(value[index].get_object()) != "datasets":
                continue
            packet = value[index + 1].get_object()
            if not isinstance(packet, StreamObject):
                raise DocError("DOC_XFA_INVALID")
            content = packet.get_data()
            checked_xml(content)
            return content
        return None
    if not isinstance(value, StreamObject):
        raise DocError("DOC_XFA_INVALID")
    root = checked_xml(value.get_data())
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] == "datasets":
            return ElementTree.tostring(element, encoding="utf-8")
    return None


def encoded(data):
    return base64.b64encode(data).decode("ascii")


def document_attachments(reader, deadline):
    entries = {}
    available = 0
    for index, attachment in enumerate(reader.attachment_list):
        check_time(deadline)
        if index >= MAX_ATTACHMENTS:
            raise DocError("DOC_ATTACHMENT_LIMIT", 413)
        content = attachment.content
        digest = sha256(content)
        previous = entries.get(digest)
        name = unicodedata.normalize("NFC", attachment.name or "attachment")
        name = name.replace("\\", "/").rsplit("/", 1)[-1]
        name = "".join(character for character in name if not unicodedata.category(character).startswith("C"))
        name = name.strip(" .")[:200] or "attachment"
        if previous is not None:
            if re.match(r"^\d{4}-\d{2}-\d{2}T", previous["name"]) and not re.match(r"^\d{4}-\d{2}-\d{2}T", name):
                previous["name"] = name
            continue
        available += len(content)
        if available > MAX_ATTACHMENT_BYTES:
            raise DocError("DOC_ATTACHMENT_LIMIT", 413)
        entries[digest] = {"name": name, "sha256": digest, "byteSize": len(content), "bodyBase64": encoded(content)}
    return list(entries.values())


def parse_docx(data, deadline):
    document = docx.Document(io.BytesIO(data))
    budget = TextBudget()
    parts = []
    for paragraph in document.paragraphs:
        check_time(deadline)
        text = paragraph.text
        if text.strip():
            parts.append(budget.add(text))
    for table in document.tables:
        for row in table.rows:
            check_time(deadline)
            cells = []
            for cell in row.cells:
                text = cell.text.strip()
                if not cells or cells[-1] != text:
                    cells.append(text)
            parts.append(budget.add(" | ".join(cells)))
    return [{"page": 1, "method": "docx", "locatorKind": "extraction_unit", "text": "\n".join(parts)}]


def parse_xlsx(data, deadline):
    workbook = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    pages = []
    cells = 0
    budget = TextBudget()
    try:
        if len(workbook.worksheets) > MAX_PAGES:
            raise DocError("DOC_PAGE_LIMIT", 413)
        for index, sheet in enumerate(workbook.worksheets):
            if (sheet.max_row or 0) > 20000 or (sheet.max_column or 0) > 256:
                raise DocError("DOC_SHEET_LIMIT", 413)
            lines = []
            for row_index, row in enumerate(sheet.iter_rows(values_only=True)):
                check_time(deadline)
                cells += len(row)
                if row_index >= 20000 or len(row) > 256 or cells > 250000:
                    raise DocError("DOC_SHEET_LIMIT", 413)
                if any(item is not None for item in row):
                    lines.append(budget.add(" | ".join("" if item is None else str(item) for item in row)))
            pages.append({"page": index + 1, "method": "xlsx", "locatorKind": "extraction_unit",
                          "sheet": sheet.title, "text": "\n".join(lines)})
    finally:
        workbook.close()
    return pages


def convert_office(data, kind, output, deadline):
    with tempfile.TemporaryDirectory(prefix="cert-doc-") as root:
        directory = Path(root)
        source = directory / f"source.{kind}"
        source.write_bytes(data)
        profile = directory / "profile"
        user_profile = profile / "user"
        user_profile.mkdir(parents=True)
        (user_profile / "registrymodifications.xcu").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
            '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
            '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
            '</item></oor:items>', encoding="utf-8",
        )
        check_time(deadline)
        timeout = min(90, max(0.1, deadline - monotonic()))
        try:
            process = subprocess.Popen(
                ["libreoffice", f"-env:UserInstallation={profile.as_uri()}", "--headless", "--norestore",
                 "--nofirststartwizard", "--nodefault", "--convert-to", output, "--outdir", root, str(source)],
                cwd=root, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": root,
                               "TMPDIR": root, "SAL_USE_VCLPLUGIN": "svp", "LANG": "C.UTF-8"},
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as error:
            raise DocError("DOC_OFFICE_CONVERSION_FAILED", 503) from error
        try:
            exit_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise DocError("DOC_OFFICE_CONVERSION_TIMEOUT", 504) from error
        converted = directory / f"source.{output}"
        if exit_code != 0 or not converted.is_file() or converted.stat().st_size > MAX_INPUT:
            raise DocError("DOC_OFFICE_CONVERSION_FAILED")
        return converted.read_bytes()


def parse_document(data, kind, ocr):
    deadline = monotonic() + MAX_OPERATION_SECONDS
    check_kind(data, kind)
    attachments = []
    xfa = None
    if kind in {"pdf", "estar"}:
        pages, reader = parse_pdf(data, kind, ocr, deadline)
        if kind == "estar":
            xfa = xfa_datasets(reader)
            attachments = document_attachments(reader, deadline)
    elif kind == "xlsx":
        pages = parse_xlsx(data, deadline)
    else:
        converted = convert_office(data, kind, "docx", deadline) if kind == "doc" else data
        check_kind(converted, "docx")
        pages = parse_docx(converted, deadline)
    check_time(deadline)
    return {"sha256": sha256(data), "kind": kind, "byteSize": len(data), "pageCount": len(pages),
            "pages": pages, "attachments": attachments, "xfaDatasetsBase64": encoded(xfa) if xfa is not None else None}


def pdf_for_render(data, kind):
    return data if kind in {"pdf", "estar"} else convert_office(data, kind, "pdf", monotonic() + 90)


def render_page(pdf_data, number):
    with pdfium.PdfDocument(pdf_data, password="") as pdf:
        if not 1 <= number <= len(pdf):
            raise DocError("DOC_PAGE_NOT_FOUND", 404)
        with closing(pdf[number - 1]) as page:
            side = max(page.get_size())
            if side <= 0:
                raise DocError("DOC_PAGE_DIMENSIONS_INVALID")
            with closing(page.render(scale=LONG_SIDE / side)) as bitmap:
                rendered = io.BytesIO()
                bitmap.to_pil().save(rendered, format="PNG")
    return rendered.getvalue()
