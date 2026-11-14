"""
Generate the binary/rich-document fixtures the Node engine must refuse cleanly,
plus a few text fixtures in encodings Node alone cannot easily produce.

Writes into <root>/fixtures/.
"""
import os
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
out = root / "fixtures"
out.mkdir(parents=True, exist_ok=True)


def note(name, **kw):
    print(f"  {name}: " + ", ".join(f"{k}={v}" for k, v in kw.items()))


# ---- real Office / PDF files -------------------------------------------
try:
    from docx import Document

    doc = Document()
    doc.add_heading("Quarterly review", level=0)
    doc.add_paragraph("This paragraph lives in a real Word document.")
    doc.add_heading("Findings", level=1)
    doc.add_paragraph("Binary container, not plain text.")
    doc.save(out / "sample.docx")
    note("sample.docx", bytes=(out / "sample.docx").stat().st_size)
except Exception as error:  # noqa: BLE001
    print("  docx FAILED:", error)

try:
    from openpyxl import Workbook

    book = Workbook()
    sheet = book.active
    sheet["A1"] = "id"
    sheet["B1"] = "value"
    for row in range(2, 50):
        sheet[f"A{row}"] = row
        sheet[f"B{row}"] = row * 3
    book.save(out / "sample.xlsx")
    note("sample.xlsx", bytes=(out / "sample.xlsx").stat().st_size)
except Exception as error:  # noqa: BLE001
    print("  xlsx FAILED:", error)

try:
    from pptx import Presentation

    deck = Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[1])
    slide.shapes.title.text = "Deck title"
    slide.placeholders[1].text = "Body text in a real presentation."
    deck.save(out / "sample.pptx")
    note("sample.pptx", bytes=(out / "sample.pptx").stat().st_size)
except Exception as error:  # noqa: BLE001
    print("  pptx FAILED:", error)

# A minimal, valid PDF written by hand (no dependency).
pdf_lines = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    "4 0 obj<</Length 62>>stream",
    "BT /F1 24 Tf 72 700 Td (Hello from a real PDF) Tj ET",
    "endstream endobj",
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
]
(out / "sample.pdf").write_bytes("\n".join(pdf_lines).encode("latin-1"))
note("sample.pdf", bytes=(out / "sample.pdf").stat().st_size)

# ---- a zip that is not an Office document ------------------------------
with zipfile.ZipFile(out / "sample.zip", "w") as archive:
    archive.writestr("readme.txt", "plain archive entry\n")
note("sample.zip", bytes=(out / "sample.zip").stat().st_size)

# ---- an image ----------------------------------------------------------
try:
    from PIL import Image

    Image.new("RGB", (32, 32), (40, 120, 200)).save(out / "sample.png")
    note("sample.png", bytes=(out / "sample.png").stat().st_size)
except Exception as error:  # noqa: BLE001
    print("  png FAILED:", error)

# ---- encodings Node's TextDecoder covers, written explicitly -----------
texts = {
    "cjk-utf16le.txt": ("# UTF-16 标题\n\n正文一行。\n", "utf-16-le"),
    "cjk-gb18030.txt": ("# 国标标题\n\n正文一行。\n", "gb18030"),
    "cjk-big5.txt": ("# 繁體標題\n\n正文一行。\n", "big5"),
}
for name, (body, codec) in texts.items():
    (out / name).write_bytes(body.encode(codec))
    note(name, bytes=(out / name).stat().st_size)

# ---- a file with a BOM, and one with mixed line endings ----------------
(out / "bom-utf8.md").write_bytes(b"\xef\xbb\xbf# BOM heading\n\ntext\n")
note("bom-utf8.md", bytes=(out / "bom-utf8.md").stat().st_size)

(out / "mixed-eol.md").write_bytes(b"# Mixed\r\n\r\npara one\npara two\r\n## Next\nlast\n")
note("mixed-eol.md", bytes=(out / "mixed-eol.md").stat().st_size)

print(f"\nfixtures written to {out}")
