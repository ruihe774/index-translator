// Worker thread that owns the embedding model, a second user of libllama beside the engine thread
// (src/llama-worker.ts). FFI calls block, so they run here. Loads, unloads and embeddings run in
// arrival order; a batch of texts returns to the event loop after each one, which is when a
// cancellation is seen.

import { EmbeddingModel, type EmbeddingOptions } from "./llama-ffi";

export type EmbedWorkerRequest =
  | { type: "load"; req: number; options: EmbeddingOptions }
  | { type: "unload"; req: number }
  | { type: "embed"; req: number; texts: string[] }
  | { type: "cancel"; req: number };

export type EmbedWorkerReply =
  | { type: "ok"; req: number }
  /** `vectors` holds one row of `dim` floats per text, in order. */
  | { type: "vectors"; req: number; dim: number; vectors: Float32Array }
  | { type: "error"; req: number; message: string };

declare var self: Worker;

const post = (reply: EmbedWorkerReply, transfer: ArrayBuffer[] = []) => self.postMessage(reply, transfer);
const tick = () => new Promise<void>((resolve) => void setImmediate(resolve));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

let model: EmbeddingModel | undefined;
/** Loads, unloads and embeddings, in arrival order. */
let chain: Promise<void> = Promise.resolve();
/** Embeddings that are queued or running, and the ones among them nobody waits for any more. */
const active = new Set<number>();
const cancelled = new Set<number>();

function exclusive(req: number, fn: () => void | Promise<void>): void {
  chain = chain.then(fn).catch((e) => post({ type: "error", req, message: messageOf(e) }));
}

self.onmessage = (event: MessageEvent<EmbedWorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case "load": {
      exclusive(msg.req, () => {
        model?.free();
        model = undefined;
        model = EmbeddingModel.load(msg.options);
        post({ type: "ok", req: msg.req });
      });
      break;
    }
    case "unload": {
      exclusive(msg.req, () => {
        model?.free();
        model = undefined;
        post({ type: "ok", req: msg.req });
      });
      break;
    }
    case "embed": {
      active.add(msg.req);
      exclusive(msg.req, async () => {
        try {
          if (cancelled.has(msg.req)) {
            return;
          }
          if (!model) {
            throw new Error("the embedding model is not loaded");
          }
          const vectors = new Float32Array(msg.texts.length * model.dim);
          for (const [i, text] of msg.texts.entries()) {
            vectors.set(model.embed(text), i * model.dim);
            await tick();
            if (cancelled.has(msg.req)) {
              return;
            }
          }
          post({ type: "vectors", req: msg.req, dim: model.dim, vectors }, [vectors.buffer]);
        } finally {
          active.delete(msg.req);
          cancelled.delete(msg.req);
        }
      });
      break;
    }
    case "cancel": {
      if (active.has(msg.req)) {
        cancelled.add(msg.req);
      }
      break;
    }
  }
};
