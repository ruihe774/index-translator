// The Open button: a text or Markdown file goes into the source box, a PDF is shown as a strip of
// page thumbnails (elements/pdf-pages.ts) and the page that is clicked goes into the box as
// Markdown, and an image (JPEG, PNG, WebP) takes the place of the box. While a PDF is open the
// button reads Close and puts it away. Nothing is translated by opening. The page (app.ts) supplies
// how a text or an image is put in the box; open-file.ts holds the rules and the wording, pdf.ts
// the libraries.
//
// Opening happens in this browser: no request carries the file or says that one was opened. Only
// Translate sends something, and for an image that is the file.

import type { PdfPages } from "./elements/pdf-pages.ts";
import { looksLikeMarkdown } from "./markdown.ts";
import { ACCEPT_IMAGE, ACCEPT_PDF, ACCEPT_TEXT, decodeText, fileKind, pageNote, refusal } from "./open-file.ts";
import { openPdf, type PdfDocument, PdfError, pdfInstalled } from "./pdf.ts";

export interface OpenUiDeps {
  button: HTMLElement;
  input: HTMLInputElement;
  pages: PdfPages;
  /** The line under the source's button row that says what was opened, or why not. */
  note: HTMLElement;
  /** The source box's field: gets `aria-busy` (a spinner at its center) while a file is read. */
  area: HTMLElement;
  /**
   * Puts `text` in the source box in place of what is there and drops the translation of the old
   * text. `preview` shows it rendered instead of in the text box: it was not typed, so it is more
   * likely read than edited (a Markdown file, a PDF page).
   */
  load: (text: string, preview: boolean) => void;
  /**
   * Shows `picture`, the decoded `file`, in place of the source box and drops the text and its
   * translation. The file is what Translate then sends; the picture becomes the page's to close.
   */
  loadImage: (file: File, picture: ImageBitmap) => void;
}

export interface OpenUi {
  /** A translation is running: nothing is opened and no page is taken until it ends. */
  setBusy(busy: boolean): void;
  /** The box no longer holds the page that is marked in the strip. */
  deselect(): void;
}

const NOT_INSTALLED = "PDF files cannot be opened: PDF support is not installed on this server.";

export function initOpenUi(d: OpenUiDeps): OpenUi {
  let busy = false;
  let pdf: { name: string; doc: PdfDocument } | null = null;
  /** Counts up with every file picked and every page clicked; an answer to an older one is dropped. */
  let turn = 0;

  function say(text: string, kind: "plain" | "warning" | "error" = "plain") {
    d.note.textContent = text;
    d.note.hidden = text === "";
    d.note.classList.toggle("error", kind === "error");
    d.note.classList.toggle("advice", kind === "warning");
    d.note.classList.toggle("hint", kind === "plain");
  }

  /**
   * Shows `next` as the open PDF, or none. While one is open the button closes it instead of
   * opening another file, so a document is never put away by picking the next one.
   */
  function setPdf(next: { name: string; doc: PdfDocument } | null) {
    pdf?.doc.close();
    pdf = next;
    if (next) d.pages.show(next.doc);
    else d.pages.clear();
    d.button.textContent = next ? "Close" : "Open";
    d.button.setAttribute("aria-label", next ? "Close the PDF" : "Open a file");
  }

  /** The spinner over the box; only the newest pick may end it. */
  function reading(on: boolean, mine = turn) {
    if (on) d.area.setAttribute("aria-busy", "true");
    else if (mine === turn) d.area.removeAttribute("aria-busy");
  }

  async function openText(file: File, mine: number) {
    const text = decodeText(new Uint8Array(await file.arrayBuffer()));
    reading(false, mine);
    if (mine !== turn || busy) return;
    if (text === null) {
      say(`${file.name} was not opened: it is not text in UTF-8.`, "error");
      return;
    }
    d.load(text, looksLikeMarkdown(text));
    say(`Opened ${file.name}.`);
  }

  async function openImage(file: File, mine: number) {
    let picture: ImageBitmap;
    try {
      picture = await createImageBitmap(file);
    } catch {
      reading(false, mine);
      if (mine === turn) say(`${file.name} was not opened: it could not be read as an image.`, "error");
      return;
    }
    reading(false, mine);
    if (mine !== turn || busy) {
      picture.close();
      return;
    }
    d.loadImage(file, picture);
    say(`Opened ${file.name}. Translate sends the image to the server, which reads the text in it.`);
  }

  async function openDocument(file: File, mine: number) {
    say(`Opening ${file.name}…`);
    let doc: PdfDocument;
    try {
      doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
      reading(false, mine);
    } catch (e) {
      reading(false, mine);
      if (mine !== turn) return;
      if (!(e instanceof PdfError)) console.error(e);
      say(`${file.name} was not opened. ${e instanceof PdfError ? e.message : "It could not be read."}`, "error");
      return;
    }
    if (mine !== turn) {
      doc.close();
      return;
    }
    setPdf({ name: file.name, doc });
    const pages = doc.pageCount === 1 ? "1 page" : `${doc.pageCount} pages`;
    say(`${file.name}: ${pages}. Select a page to put its text in the box.`);
  }

  function open(file: File) {
    const mine = ++turn;
    d.pages.busy = null;
    const kind = fileKind(file.name, file.type);
    const problem = refusal(file.name, kind, file.size);
    if (problem !== null) say(problem, "error");
    else {
      reading(true);
      void (kind === "pdf"
        ? openDocument(file, mine)
        : kind === "image"
          ? openImage(file, mine)
          : openText(file, mine));
    }
  }

  async function takePage(page: number) {
    if (!pdf || busy) return;
    const mine = ++turn;
    const { name, doc } = pdf;
    d.pages.busy = page;
    say(`${name}: reading page ${page}…`);
    try {
      const result = await doc.extract(page);
      // A translation that started meanwhile keeps its source.
      if (mine !== turn || busy) return;
      const note = pageNote(name, page, doc.pageCount, result);
      if (!note.failed) {
        d.load(result.markdown, true);
        d.pages.selected = page;
      }
      say(note.text, note.failed ? "error" : note.warning ? "warning" : "plain");
    } catch (e) {
      if (mine !== turn) return;
      if (!(e instanceof PdfError)) console.error(e);
      say(`${name}, page ${page} was not read. ${e instanceof PdfError ? e.message : ""}`.trim(), "error");
    } finally {
      if (mine === turn) d.pages.busy = null;
    }
  }

  d.button.addEventListener("click", () => {
    if (d.button.getAttribute("aria-disabled") === "true") return;
    if (!pdf) {
      d.input.click();
      return;
    }
    turn++;
    reading(false);
    setPdf(null);
    say("");
  });
  /** What picking a file and dropping one on the page share. */
  function pick(file: File | undefined) {
    if (file && !busy && !pdf) open(file);
  }
  d.input.addEventListener("change", () => {
    const file = d.input.files?.[0];
    d.input.value = ""; // so picking the same file again is a change
    pick(file);
  });

  // Drop anywhere on the page. Only drags that carry files count (not selected text), and the
  // browser's own reaction (navigating to the file) is always prevented for them.
  const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
  // dragenter/dragleave fire for every element passed over and are not reliably paired, so they are
  // not counted. The mark is on while dragover keeps arriving (the browser repeats it while the drag
  // is over the page, even without movement) and ends when the drag leaves the window
  // (`relatedTarget` null), drops, ends, or the events stop.
  const DRAG_IDLE_MS = 500;
  let idle = 0;
  const mark = (on: boolean) => {
    clearTimeout(idle);
    document.documentElement.classList.toggle("dropping", on);
    if (on) idle = window.setTimeout(() => mark(false), DRAG_IDLE_MS);
  };
  window.addEventListener("dragover", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    const blocked = busy || pdf !== null;
    if (e.dataTransfer) e.dataTransfer.dropEffect = blocked ? "none" : "copy";
    mark(!blocked);
  });
  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) mark(false);
  });
  window.addEventListener("dragend", () => mark(false));
  window.addEventListener("drop", (e) => {
    mark(false);
    if (!carriesFiles(e)) return;
    e.preventDefault();
    pick(e.dataTransfer?.files[0]);
  });
  d.pages.addEventListener("page", (e) => void takePage((e as CustomEvent<number>).detail));

  // Without the libraries the picker offers no PDFs, and one that is picked anyway is refused by openPdf.
  d.input.accept = `${ACCEPT_TEXT},${ACCEPT_PDF},${ACCEPT_IMAGE}`;
  void pdfInstalled().then((installed) => {
    if (installed) return;
    d.input.accept = `${ACCEPT_TEXT},${ACCEPT_IMAGE}`;
    d.button.title = NOT_INSTALLED;
  });

  return {
    setBusy(b) {
      busy = b;
      d.button.setAttribute("aria-disabled", String(b));
      d.pages.disabled = b;
    },
    deselect() {
      d.pages.selected = null;
    },
  };
}
