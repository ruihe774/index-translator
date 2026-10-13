// Opening a file into the source box: which files are taken, how a text file is read, and what
// is said about a PDF page. Pure, so it is tested without a browser (test/open-file.test.ts); the
// page side is open-ui.ts, the PDF libraries are behind pdf.ts.
//
// Text and PDF files never leave the browser: a text file is decoded here, a PDF by the libraries
// in public/vendor/, and the server only ever sees the text that is sent for translation. An image
// is the exception: it takes the place of the text, and Translate sends the file itself.

/** Plain text and Markdown are the same to the page: whether a text is Markdown is read from it. */
export type FileKind = "text" | "pdf" | "image";

/** What the file picker offers, as an `accept` list. */
export const ACCEPT_TEXT = ".txt,.md,.markdown,text/plain,text/markdown";
export const ACCEPT_PDF = ".pdf,application/pdf";
export const ACCEPT_IMAGE = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";

/** A text far beyond what a model takes is refused instead of freezing the text box. */
export const MAX_TEXT_BYTES = 2 * 2 ** 20;
/** The file is held in memory twice (once per library). */
export const MAX_PDF_BYTES = 256 * 2 ** 20;
/** What the server takes (MAX_IMAGE_BYTES in src/image.ts). */
export const MAX_IMAGE_BYTES = 8 * 2 ** 20;

const TEXT_EXTENSIONS = ["txt", "text", "md", "markdown"];
const TEXT_TYPES = ["text/plain", "text/markdown", "text/x-markdown"];
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** The kind of a picked file, by its name's extension, else by its media type; `null` when neither is taken. */
export function fileKind(name: string, type: string): FileKind | null {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  if (extension === "pdf") {
    return "pdf";
  }
  if (TEXT_EXTENSIONS.includes(extension)) {
    return "text";
  }
  if (IMAGE_EXTENSIONS.includes(extension)) {
    return "image";
  }
  const media = type.split(";")[0]!.trim().toLowerCase();
  if (media === "application/pdf") {
    return "pdf";
  }
  if (TEXT_TYPES.includes(media)) {
    return "text";
  }
  if (IMAGE_TYPES.includes(media)) {
    return "image";
  }
  return null;
}

/**
 * A text file's content: UTF-8 (a byte order mark is dropped), line ends as `\n`. `null` when
 * the bytes are not UTF-8 text, which is what a binary file or another encoding looks like.
 */
export function decodeText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.includes("\0")) {
    return null;
  }
  return text.replaceAll(/\r\n?/g, "\n");
}

export function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / 2 ** 20)} MB`;
}

/** Why a picked file is not opened; `null` when it can be. */
export function refusal(name: string, kind: FileKind | null, size: number): string | null {
  if (kind === null) {
    return `${name} was not opened: only plain text, Markdown and PDF files and JPEG, PNG and WebP images can be.`;
  }
  const limit = kind === "pdf" ? MAX_PDF_BYTES : kind === "image" ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  if (size > limit) {
    return `${name} was not opened: it is larger than ${megabytes(limit)}.`;
  }
  if (size === 0) {
    return `${name} was not opened: it is empty.`;
  }
  return null;
}

/** What the extraction of one PDF page gave. */
export interface PageText {
  markdown: string;
  /** The library found the page's text missing or unreliable (a scan, fonts without a character map). */
  needsOcr: boolean;
}

export interface PageNote {
  text: string;
  /** Nothing was put in the box. */
  failed: boolean;
  /** The text is in the box but should be checked. */
  warning: boolean;
}

/** What to say after page `page` of `count` was extracted from `name`. */
export function pageNote(name: string, page: number, count: number, result: PageText): PageNote {
  const where = `${name}, page ${page} of ${count}`;
  if (result.markdown.trim() === "") {
    return {
      text: `${where}: no text was found. A scanned page has to be recognized (OCR) first, which this app does not do.`,
      failed: true,
      warning: false,
    };
  }
  if (result.needsOcr || result.markdown.includes("�")) {
    return {
      text: `${where}: some of the text could not be read from the PDF and may be missing or garbled. Check it before translating.`,
      failed: false,
      warning: true,
    };
  }
  return { text: `${where}.`, failed: false, warning: false };
}
