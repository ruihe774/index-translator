// The worker that turns a Word document (.docx) into Markdown with undoc's WebAssembly build
// (public/vendor/undoc, see scripts/fetch_web_libs.ts). A worker so that the page's script policy
// needs no `wasm-unsafe-eval` (as with pdf-worker.ts), and a large document does not freeze the
// page. undoc inflates the package's entries with the browser's DecompressionStream. One worker
// reads one document; docx.ts starts it and ends it after the answer.
//
// Message in: `{ bytes }`, the file. Out: `{ markdown }` or `{ error, kind }` (`kind` is undoc's
// reason, see `docxFailure` in open-file.ts; undefined when the library itself did not load).

export interface DocxRequest {
  bytes: ArrayBuffer;
}
export type DocxReply = { markdown: string } | { error: string; kind: number | undefined };

/** The part of undoc-wasm's module that is used (its `undoc_wasm.d.ts`). */
interface Undoc {
  default(input: { module_or_path: string }): Promise<unknown>;
  parse(data: Uint8Array): Promise<{ toMarkdown(): string; free(): void }>;
}

const DIR = "/vendor/undoc";

async function answer({ bytes }: DocxRequest): Promise<DocxReply> {
  let undoc: Undoc;
  try {
    undoc = (await import(`${DIR}/undoc_wasm.js`)) as Undoc;
    await undoc.default({ module_or_path: `${DIR}/undoc_wasm_bg.wasm` });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), kind: undefined };
  }
  try {
    const doc = await undoc.parse(new Uint8Array(bytes));
    try {
      return { markdown: doc.toMarkdown() };
    } finally {
      doc.free();
    }
  } catch (e) {
    const kind = (e as { kind?: unknown } | null)?.kind;
    return {
      error: e instanceof Error ? e.message : String(e),
      kind: typeof kind === "number" ? kind : 1, // undoc's "other"
    };
  }
}

self.addEventListener("message", (event: MessageEvent<DocxRequest>) => {
  void answer(event.data).then((reply) => self.postMessage(reply));
});
