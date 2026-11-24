import hashlib
import json
import os
import subprocess
from pathlib import Path

from docx import Document
from docx.shared import Inches, Pt, RGBColor


draft = json.loads(Path("inputs/draft.json").read_text(encoding="utf-8"))
output = Path("outputs")
target = output / "510k-cover-letter.draft.docx"

document = Document()
document.core_properties.author = "cert-board"
document.core_properties.title = draft["document"]["title"]
section = document.sections[0]
section.left_margin = Inches(1)
section.right_margin = Inches(1)
section.top_margin = Inches(1)
section.bottom_margin = Inches(1)

normal = document.styles["Normal"]
normal.font.name = "Liberation Serif"
normal.font.size = Pt(11)
normal.font.color.rgb = RGBColor(0, 0, 0)
normal.paragraph_format.space_after = Pt(10)
normal.paragraph_format.line_spacing = 1.15

title = document.styles["Title"]
title.font.name = "Liberation Serif"
title.font.size = Pt(20)
title.font.bold = True
title.font.color.rgb = RGBColor(0, 0, 0)
for border in title.element.xpath("./w:pPr/w:pBdr"):
    border.getparent().remove(border)

document.add_paragraph(draft["document"]["title"], style="Title")
document.add_paragraph("For internal review.")
for text in draft["document"]["paragraphs"]:
    document.add_paragraph(text)
document.save(target)

sources = draft["sourceMap"]
sources["wordSha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
(output / "510k-cover-letter.sources.json").write_text(
    json.dumps(sources, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
subprocess.run(
    [
        "libreoffice",
        f"-env:UserInstallation={(Path(os.environ['TMPDIR']) / 'office').as_uri()}",
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        str(output),
        str(target),
    ],
    check=True,
    capture_output=True,
    timeout=50,
)
