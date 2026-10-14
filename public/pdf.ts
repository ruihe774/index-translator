// PDF files in the browser: page pictures by pdf.js, page text as Markdown by pdf-inspector (in
// pdf-worker.ts). Both libraries are files of this server (public/vendor/, put there by
// scripts/fetch_web_libs.ts) and are loaded the first time a PDF is opened, never before. They
// may be missing (a checkout where the script was not run): `pdfInstalled` says so up front, and
// `openPdf` fails with a `PdfError` whose message can be shown.
//
// The file's bytes stay in this browser; nothing here talks to the API.

import type { PageText } from "./open-file.ts";
import type { WorkerReply, WorkerRequest } from "./pdf-worker.ts";

const PDFJS = "/vendor/pdfjs";
const INSPECTOR = "/vendor/pdf-inspector";

/** A failure with a message for the user. */
export class PdfError extends Error {}

const NOT_LOADED = "PDF support could not be loaded";

// ---- the part of pdf.js that is used (pdfjs-dist's types/src/display/api.d.ts) ----------------

interface PdfJsViewport {
  width: number;
  height: number;
}

interface PdfJsPage {
  getViewport(options: { scale: number }): PdfJsViewport;
  render(options: { canvas: HTMLCanvasElement; viewport: PdfJsViewport }): { promise: Promise<void> };
  cleanup(): boolean;
}

interface PdfJsDocument {
  numPages: number;
  getPage(page: number): Promise<PdfJsPage>;
}

interface PdfJsTask {
  promise: Promise<PdfJsDocument>;
  destroy(): Promise<void>;
}

interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(source: Record<string, unknown>): PdfJsTask;
}

let pdfjs: Promise<PdfJs> | undefined;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (import(`${PDFJS}/pdf.min.mjs`) as Promise<PdfJs>).then(
    (module) => {
      module.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
      return module;
    },
    (e) => {
      pdfjs = undefined; // the next PDF tries again
      console.error(e);
      throw new PdfError(`${NOT_LOADED}.`);
    },
  );
  return pdfjs;
}

/** Whether both libraries are on the server: their stamp files are written last by the fetch script. */
export async function pdfInstalled(): Promise<boolean> {
  try {
    const stamps = await Promise.all([PDFJS, INSPECTOR].map((dir) => fetch(`${dir}/VERSION`, { cache: "no-cache" })));
    return stamps.every((res) => res.ok);
  } catch {
    return false;
  }
}

// ---- the extraction worker -------------------------------------------------------------------

type Reply = { ok: true } | PageText;
type Ask = { open: ArrayBuffer } | { page: number };

interface Extractor {
  ask(request: Ask, transfer?: Transferable[]): Promise<Reply>;
  end(): void;
}

function startExtractor(): Extractor {
  const worker = new Worker("/pdf-worker.ts", { type: "module" });
  const waiting = new Map<number, { resolve: (reply: Reply) => void; reject: (e: Error) => void }>();
  let next = 0;
  let dead: Error | undefined;

  const fail = (e: Error) => {
    dead = e;
    for (const w of waiting.values()) {
      w.reject(e);
    }
    waiting.clear();
  };
  worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
    const { id, ...reply } = event.data;
    const w = waiting.get(id);
    waiting.delete(id);
    if (!w) {
      return;
    }
    if ("error" in reply) {
      w.reject(new PdfError(reply.error));
    } else {
      w.resolve(reply);
    }
  });
  // The worker's own script did not load or threw outside a request.
  worker.addEventListener("error", () => fail(new PdfError(`${NOT_LOADED}.`)));

  return {
    ask(request, transfer = []) {
      if (dead) {
        return Promise.reject(dead);
      }
      const id = next++;
      return new Promise<Reply>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id, ...request } satisfies WorkerRequest, transfer);
      });
    },
    end() {
      worker.terminate();
      fail(new PdfError("The PDF was closed."));
    },
  };
}

// ---- an open document ------------------------------------------------------------------------

/** Thumbnails are drawn for screens up to this many device pixels per CSS pixel. */
const MAX_PIXEL_RATIO = 2;

export interface PdfDocument {
  readonly pageCount: number;
  /** Draws page `page` (1-based) into `canvas`, sized for `cssWidth` CSS pixels across. */
  render(page: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>;
  /** The page's text as Markdown. Reads the whole file each time, so it takes as long for one page as for all. */
  extract(page: number): Promise<PageText>;
  /** Frees both libraries' copies of the file; what is still pending fails. */
  close(): void;
}

/** Opens a PDF from its bytes, which are given up to the libraries (the buffer is transferred). */
export async function openPdf(bytes: Uint8Array<ArrayBuffer>): Promise<PdfDocument> {
  const lib = await loadPdfJs();
  // Each library gets its own copy: pdf.js moves its one to its worker.
  const copy = bytes.slice().buffer;

  const task = lib.getDocument({
    data: bytes,
    cMapUrl: `${PDFJS}/cmaps/`,
    standardFontDataUrl: `${PDFJS}/standard_fonts/`,
    wasmUrl: `${PDFJS}/wasm/`,
    iccUrl: `${PDFJS}/iccs/`,
  });
  let doc: PdfJsDocument;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    const name = (e as { name?: string } | null)?.name;
    if (name === "PasswordException") {
      throw new PdfError("It is protected by a password.");
    }
    if (name === "InvalidPDFException" || name === "FormatError") {
      throw new PdfError("It is not a readable PDF.");
    }
    console.error(e);
    throw new PdfError(`${NOT_LOADED}, or the file is damaged.`);
  }

  const extractor = startExtractor();
  try {
    await extractor.ask({ open: copy }, [copy]);
  } catch (e) {
    extractor.end();
    void task.destroy();
    throw e;
  }

  return {
    pageCount: doc.numPages,
    async render(n, canvas, cssWidth) {
      const page = await doc.getPage(n);
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const viewport = page.getViewport({ scale: (cssWidth * ratio) / page.getViewport({ scale: 1 }).width });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      await page.render({ canvas, viewport }).promise;
      page.cleanup();
    },
    async extract(n) {
      return (await extractor.ask({ page: n })) as PageText;
    },
    close() {
      extractor.end();
      void task.destroy();
    },
  };
}
