// Word documents (.docx) in the browser: the text as Markdown by undoc (in docx-worker.ts). The
// library is a file of this server (public/vendor/undoc, put there by scripts/fetch_web_libs.ts)
// and is loaded the first time a document is opened, never before. It may be missing (a checkout
// where the script was not run): `docxInstalled` says so up front, and `readDocx` fails with a
// `DocxError` whose message can be shown.
//
// The file's bytes stay in this browser; nothing here talks to the API.

import type { DocxReply, DocxRequest } from "./docx-worker.ts";
import { docxFailure } from "./open-file.ts";
import { workerClient } from "./worker-client.ts";

const UNDOC = "/vendor/undoc";

/** A failure with a message for the user. */
export class DocxError extends Error {
  override name = "DocxError";
}

const NOT_LOADED = "Word support could not be loaded.";

/** Whether the library is on the server: its stamp file is written last by the fetch script. */
export async function docxInstalled(): Promise<boolean> {
  try {
    return (await fetch(`${UNDOC}/VERSION`, { cache: "no-cache" })).ok;
  } catch {
    return false;
  }
}

/** The text of a .docx file as Markdown. The buffer is given up to the worker (transferred). */
export function readDocx(bytes: ArrayBuffer): Promise<string> {
  const worker = new Worker("/docx-worker.ts", { type: "module" });
  const client = workerClient<string>();
  // One request per worker, so the reply carries no id: it answers the first.
  worker.addEventListener("message", (event: MessageEvent<DocxReply>) => {
    const reply = event.data;
    const pending = client.take(0);
    if ("markdown" in reply) {
      pending?.resolve(reply.markdown);
    } else {
      console.error(reply.error);
      pending?.reject(new DocxError(reply.kind === undefined ? NOT_LOADED : docxFailure(reply.kind)));
    }
  });
  // The worker's own script did not load or threw outside the request.
  worker.addEventListener("error", () => client.fail(new DocxError(NOT_LOADED)));
  return client
    .request(() => worker.postMessage({ bytes } satisfies DocxRequest, [bytes]))
    .finally(() => worker.terminate());
}
