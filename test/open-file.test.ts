import { describe, expect, test } from "bun:test";
import {
  decodeText,
  fileKind,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_BYTES,
  type PageText,
  pageNote,
  refusal,
} from "../public/open-file";

describe("fileKind", () => {
  test("goes by the extension, whatever its case", () => {
    expect(fileKind("notes.txt", "")).toBe("text");
    expect(fileKind("README.MD", "")).toBe("text");
    expect(fileKind("a.b.markdown", "application/octet-stream")).toBe("text");
    expect(fileKind("paper.PDF", "")).toBe("pdf");
    expect(fileKind("photo.JPG", "")).toBe("image");
    expect(fileKind("photo.jpeg", "")).toBe("image");
    expect(fileKind("shot.png", "")).toBe("image");
    expect(fileKind("shot.webp", "")).toBe("image");
  });

  test("falls back to the media type when the extension says nothing", () => {
    expect(fileKind("LICENSE", "text/plain")).toBe("text");
    expect(fileKind("notes", "text/markdown; charset=utf-8")).toBe("text");
    expect(fileKind("download", "application/pdf")).toBe("pdf");
    expect(fileKind("image", "image/png")).toBe("image");
    expect(fileKind("blob", "image/webp")).toBe("image");
  });

  test("takes nothing else", () => {
    expect(fileKind("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(
      null,
    );
    expect(fileKind("page.html", "text/html")).toBe(null);
    expect(fileKind("photo.gif", "image/gif")).toBe(null);
    expect(fileKind("scan.heic", "image/heic")).toBe(null);
    expect(fileKind("noextension", "")).toBe(null);
  });
});

describe("decodeText", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  test("reads UTF-8, drops a byte order mark and normalizes line ends", () => {
    expect(decodeText(bytes("héllo 世界"))).toBe("héllo 世界");
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
    expect(decodeText(bytes("a\r\nb\rc\n"))).toBe("a\nb\nc\n");
  });

  test("refuses bytes that are not UTF-8 text", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toBe(null); // UTF-16
    expect(decodeText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBe(null); // GBK
    expect(decodeText(bytes("a\0b"))).toBe(null);
  });
});

describe("refusal", () => {
  test("names the file and the reason", () => {
    expect(refusal("a.docx", null, 10)).toContain(
      "only plain text, Markdown and PDF files and JPEG, PNG and WebP images",
    );
    expect(refusal("a.png", "image", MAX_IMAGE_BYTES + 1)).toContain("larger than 8 MB");
    expect(refusal("a.png", "image", MAX_IMAGE_BYTES)).toBe(null);
    expect(refusal("a.png", "image", 0)).toContain("empty");
    expect(refusal("a.txt", "text", 0)).toContain("empty");
    expect(refusal("a.txt", "text", MAX_TEXT_BYTES + 1)).toContain("larger than 2 MB");
    expect(refusal("a.pdf", "pdf", MAX_PDF_BYTES + 1)).toContain("larger than 256 MB");
  });

  test("lets a PDF be larger than a text", () => {
    expect(refusal("a.txt", "text", MAX_TEXT_BYTES)).toBe(null);
    expect(refusal("a.pdf", "pdf", MAX_TEXT_BYTES + 1)).toBe(null);
  });
});

describe("pageNote", () => {
  const note = (result: PageText) => pageNote("paper.pdf", 2, 14, result);

  test("a page with text is named", () => {
    expect(note({ markdown: "# Title\n", needsOcr: false })).toEqual({
      text: "paper.pdf, page 2 of 14.",
      failed: false,
      warning: false,
    });
  });

  test("a page without text fails and says why", () => {
    const n = note({ markdown: " \n", needsOcr: true });
    expect(n.failed).toBe(true);
    expect(n.text).toContain("no text was found");
  });

  test("text the library doubts, or with replacement characters, is a warning", () => {
    for (const result of [
      { markdown: "text", needsOcr: true },
      { markdown: "te�t", needsOcr: false },
    ]) {
      const n = note(result);
      expect(n.failed).toBe(false);
      expect(n.warning).toBe(true);
      expect(n.text).toContain("Check it before translating");
    }
  });
});
