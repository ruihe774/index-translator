# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Writes test/fixtures/sample.docx, the Word document the browser tests open (e2e/open.spec.ts).

A heading, two paragraphs (one with a bold run) and a two-by-two table, written as the smallest
WordprocessingML package Word and undoc both read. Its entries are DEFLATE-compressed, so opening
it goes through the browser's DecompressionStream. Holds words the tests look for. Entry dates are
fixed, so a run gives the same bytes for the same Python.

    uv run test/fixtures/make_sample_docx.py
"""

import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def run(text: str, bold: bool = False) -> str:
    props = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return f'<w:r>{props}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def paragraph(*runs: str, style: str | None = None) -> str:
    props = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{props}{''.join(runs)}</w:p>"


def table(rows: list[list[str]]) -> str:
    cells = lambda row: "".join(f"<w:tc>{paragraph(run(c))}</w:tc>" for c in row)
    grid = "".join('<w:gridCol w:w="4000"/>' for _ in rows[0])
    return f"<w:tbl><w:tblGrid>{grid}</w:tblGrid>{''.join(f'<w:tr>{cells(r)}</w:tr>' for r in rows)}</w:tbl>"


BODY = [
    paragraph(run("Harbours of the South"), style="Heading1"),
    paragraph(
        run("A harbour shelters ships from the open sea. "),
        run("Lighthouses", bold=True),
        run(" mark the way in, and the town grows around the quay."),
    ),
    paragraph(run("Fishermen leave before dawn and return with the tide, selling their catch on the pier.")),
    table([["Port", "Founded"], ["Marlow", "1204"]]),
]

DOCUMENT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<w:document xmlns:w="{W}"><w:body>{"".join(BODY)}</w:body></w:document>'
)

STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<w:styles xmlns:w="{W}">'
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>'
    '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
    "</w:styles>"
)

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    "</Types>"
)

RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    "</Relationships>"
)

DOCUMENT_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
    'Target="styles.xml"/>'
    "</Relationships>"
)

ENTRIES = [
    ("[Content_Types].xml", CONTENT_TYPES),
    ("_rels/.rels", RELS),
    ("word/document.xml", DOCUMENT),
    ("word/_rels/document.xml.rels", DOCUMENT_RELS),
    ("word/styles.xml", STYLES),
]

out = Path(__file__).with_name("sample.docx")
with zipfile.ZipFile(out, "w") as z:
    for name, content in ENTRIES:
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, content)
print(f"wrote {out}")
