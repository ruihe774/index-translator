# /// script
# requires-python = ">=3.10"
# dependencies = ["reportlab==4.4.4"]
# ///
"""Writes test/fixtures/sample.pdf, the PDF the browser tests open (e2e/open.spec.ts).

Three A5 pages with a text layer: two English pages (a heading and paragraphs each) and a Chinese
one in a font that is named but not embedded (STSong-Light, encoding UniGB-UCS2-H), so a reader
needs its own CMaps for it. pdf.js draws that page; pdf-inspector 1.25.2 gives replacement
characters for it and reports the page as needing OCR, which is what the tests use it for (the
warning). Each English page holds words the tests look for. Dates and ids are fixed (`invariant`),
so a run gives the same bytes for the same reportlab.

    uv run test/fixtures/make_sample_pdf.py
"""

from pathlib import Path

from reportlab.lib.pagesizes import A5
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer

PAGES = [
    (
        "Rivers of the North",
        [
            "The first page is about rivers. A river gathers the rain of a whole valley and carries it "
            "to the sea, and every village along it takes its name from the water.",
            "In spring the ice breaks with a sound like distant thunder, and the ferrymen wait three "
            "days before they trust the current again.",
        ],
    ),
    (
        "Mountains of the South",
        [
            "The second page is about mountains. A mountain keeps its own weather: the pass may be "
            "closed by snow while the orchards below are in flower.",
            "Shepherds count the summer by the height of the pasture, and come down when the first "
            "frost whitens the upper huts.",
        ],
    ),
]
CHINESE = ("海边的城市", ["第三页讲的是海。潮水每天两次漫过石阶，渔船在黎明前出港。", "灯塔的光每十秒转一圈。"])


def main() -> None:
    out = Path(__file__).with_name("sample.pdf")
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    styles = getSampleStyleSheet()
    heading, body = styles["Heading1"], styles["BodyText"]
    zh_heading = ParagraphStyle("zh-heading", parent=heading, fontName="STSong-Light")
    zh_body = ParagraphStyle("zh-body", parent=body, fontName="STSong-Light", wordWrap="CJK")

    story = []
    for title, paragraphs in PAGES:
        story.append(Paragraph(title, heading))
        for text in paragraphs:
            story += [Paragraph(text, body), Spacer(1, 8)]
        story.append(PageBreak())
    story.append(Paragraph(CHINESE[0], zh_heading))
    for text in CHINESE[1]:
        story += [Paragraph(text, zh_body), Spacer(1, 8)]

    SimpleDocTemplate(
        str(out), pagesize=A5, title="Sample for the browser tests", author="Index Translator", invariant=1
    ).build(story)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
