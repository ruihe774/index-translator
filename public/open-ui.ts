// The Open button: a text or Markdown file goes into the source box, a PDF is shown as a strip of
// page thumbnails (elements/pdf-pages.ts) and the page that is clicked goes into the box as
// Markdown. Nothing is translated by opening. The page (app.ts) supplies how a text is put in the
// box; open-file.ts holds the rules and the wording, pdf.ts the libraries.
//
// Everything happens in this browser: no request carries the file or says that one was opened.

import type { PdfPages } from "./elements/pdf-pages.js";
import { ACCEPT_PDF, ACCEPT_TEXT, decodeText, fileKind, pageNote, refusal } from "./open-file.js";
import { openPdf, type PdfDocument, PdfError, pdfInstalled } from "./pdf.js";

export interface OpenUiDeps {
  button: HTMLElement;
  input: HTMLInputElement;
  pages: PdfPages;
  /** The line under the source's button row that says what was opened, or why not. */
  note: HTMLElement;
  /** Puts `text` in the source box in place of what is there and drops the translation of the old text. */
  load: (text: string) => void;
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

  function closePdf() {
    pdf?.doc.close();
    pdf = null;
    d.pages.clear();
  }

  async function openText(file: File, mine: number) {
    const text = decodeText(new Uint8Array(await file.arrayBuffer()));
    if (mine !== turn || busy) return;
    if (text === null) {
      say(`${file.name} was not opened: it is not text in UTF-8.`, "error");
      return;
    }
    closePdf();
    d.load(text);
    say(`Opened ${file.name}.`);
  }

  async function openDocument(file: File, mine: number) {
    say(`Opening ${file.name}…`);
    let doc: PdfDocument;
    try {
      doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      if (mine !== turn) return;
      if (!(e instanceof PdfError)) console.error(e);
      say(`${file.name} was not opened. ${e instanceof PdfError ? e.message : "It could not be read."}`, "error");
      return;
    }
    if (mine !== turn) {
      doc.close();
      return;
    }
    closePdf();
    pdf = { name: file.name, doc };
    d.pages.show(doc);
    const pages = doc.pageCount === 1 ? "1 page" : `${doc.pageCount} pages`;
    say(`${file.name}: ${pages}. Select a page to put its text in the box.`);
  }

  function open(file: File) {
    const mine = ++turn;
    d.pages.busy = null;
    const kind = fileKind(file.name, file.type);
    const problem = refusal(file.name, kind, file.size);
    if (problem !== null) say(problem, "error");
    else if (kind === "pdf") void openDocument(file, mine);
    else void openText(file, mine);
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
        d.load(result.markdown);
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
    if (d.button.getAttribute("aria-disabled") !== "true") d.input.click();
  });
  d.input.addEventListener("change", () => {
    const file = d.input.files?.[0];
    d.input.value = ""; // so picking the same file again is a change
    if (file && !busy) open(file);
  });
  d.pages.addEventListener("page", (e) => void takePage((e as CustomEvent<number>).detail));
  d.pages.addEventListener("close", () => {
    turn++;
    closePdf();
    say("");
    d.button.focus();
  });

  // Without the libraries the picker offers no PDFs, and one that is picked anyway is refused by openPdf.
  d.input.accept = `${ACCEPT_TEXT},${ACCEPT_PDF}`;
  void pdfInstalled().then((installed) => {
    if (installed) return;
    d.input.accept = ACCEPT_TEXT;
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
