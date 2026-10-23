// The worker that turns PDF pages into Markdown with pdf-inspector's WebAssembly build
// (public/vendor/pdf-inspector, see scripts/fetch_web_libs.ts). A worker because the library is
// synchronous, which would freeze the page. One worker holds one document; pdf.ts starts and ends it.
// The file is parsed once, by the first page asked for, and kept as a `PdfDocument`: `processPdf`
// parsed it again for every call, about 80 ms for a page of a 2.6 MB report (2 ms now).
//
// Messages in: `{ id, open }` with the file's bytes (kept), then `{ id, page }` (1-based).
// Out: `{ id, ok: true }`, `{ id, markdown, needsOcr }`, or `{ id, error }`.

import type { PageText } from "./open-file.ts";

export type WorkerRequest = { id: number; open: ArrayBuffer } | { id: number; page: number };
export type WorkerReply = { id: number } & ({ ok: true } | PageText | { error: string });

/** The part of pdf-inspector's module that is used (its `pdf_inspector_wasm.d.ts`). */
interface Inspector {
  default(input: { module_or_path: string }): Promise<unknown>;
  PdfDocument: new (data: Uint8Array) => InspectedPdf;
}

interface InspectedPdf {
  readonly pageCount: number;
  processPages(options: { pages: number[] }): { markdown?: string; pagesNeedingOcr: number[] };
  free(): void;
}

const DIR = "/vendor/pdf-inspector";

let inspector: Inspector | undefined;
let pdf: Uint8Array | undefined;
let inspected: InspectedPdf | undefined;

async function answer(request: WorkerRequest): Promise<WorkerReply> {
  const { id } = request;
  try {
    if ("open" in request) {
      if (!inspector) {
        const module = (await import(`${DIR}/pdf_inspector_wasm.js`)) as Inspector;
        await module.default({ module_or_path: `${DIR}/pdf_inspector_wasm_bg.wasm` });
        inspector = module;
      }
      inspected?.free();
      inspected = undefined;
      pdf = new Uint8Array(request.open);
      return { id, ok: true };
    }
    if (!inspector || !pdf) {
      throw new Error("no document is open");
    }
    // Not in `open`: a file this library cannot read still opens for its thumbnails, and each page says so.
    inspected ??= new inspector.PdfDocument(pdf);
    if (request.page < 1 || request.page > inspected.pageCount) {
      throw new Error(`there is no page ${request.page}`);
    }
    const result = inspected.processPages({ pages: [request.page] });
    return { id, markdown: result.markdown ?? "", needsOcr: result.pagesNeedingOcr.includes(request.page) };
  } catch (e) {
    return { id, error: e instanceof Error ? e.message : String(e) };
  }
}

// Answered in arrival order: `open` is awaited before the pages that follow it.
let last: Promise<void> = Promise.resolve();
self.addEventListener(
  "message",
  (event: MessageEvent<WorkerRequest>) =>
    void (last = last.then(async () => self.postMessage(await answer(event.data)))),
);
