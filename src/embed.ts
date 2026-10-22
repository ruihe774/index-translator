// Sentence embeddings, for telling which block of a translation answers which block of its source.
// bge-m3 (Q8_0) runs on the processor through the same libllama as the translator, on a worker
// thread of its own (src/embed-worker.ts): the translator's engine thread holds one model at a time
// and swapping it out for this one would reload 9 GiB. The worker is started by the first request,
// never at startup, and keeps its model until `unload()`. The server-thread side is this file.

import { join } from "node:path";

import type { Config } from "./config";
import { inferenceThreads } from "./cpu";
import type { EmbedWorkerReply, EmbedWorkerRequest } from "./embed-worker";
import { EMBED_MODEL_FILE } from "./models";
import { fetchCommand } from "./preflight";

/**
 * Longest text, in tokens, the model reads; the rest is cut off. A block of a document is far shorter
 * (the longest paragraph of the test essays is 180 tokens), but a pair of blocks that may have been
 * merged is embedded as one text. Time grows faster than the length: a text of this length takes
 * about 1.3 s on six cores, twice that again takes 3.5 s, and the model's own limit of 8192 takes 30 s.
 */
export const EMBED_MAX_TOKENS = 1024;

export class EmbedError extends Error {}

/** Embeds texts, scaled to length 1 so that the dot product of two vectors is their cosine similarity. */
export interface Embedder {
  /** One vector per text, in order. Aborting rejects with the signal's reason and stops the work after the text in progress. */
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  /** Frees the model; the next `embed` loads it again. */
  unload(): Promise<void>;
}

type Send<T> = T extends unknown ? Omit<T, "req"> : never;

/** The embedding model through libllama on its own thread, which is started on first use. */
export class NativeEmbedder implements Embedder {
  private worker?: Worker;
  private readonly waiting = new Map<number, (reply: EmbedWorkerReply) => void>();
  private lastReq = 0;
  /** Set while the model is loading or loaded; cleared by a failed load, an unload and a lost thread. */
  private loaded?: Promise<void>;

  constructor(private readonly cfg: Pick<Config, "modelsDir" | "llamaDir" | "embedThreads">) {}

  private start(): Worker {
    // Not referenced: the server decides when the process ends, not an idle embedding thread.
    const worker = new Worker(new URL("embed-worker.ts", import.meta.url).href, { ref: false });
    worker.onmessage = (event: MessageEvent<EmbedWorkerReply>) => this.waiting.get(event.data.req)?.(event.data);
    const lost = (reason: string) => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.loaded = undefined;
      }
      for (const [req, deliver] of this.waiting) {
        deliver({ type: "error", req, message: reason });
      }
    };
    worker.onerror = (event) => lost(`the embedding thread failed: ${event.message}`);
    worker.addEventListener("close", () => lost("the embedding thread exited"));
    return worker;
  }

  private send(msg: Send<EmbedWorkerRequest>, deliver: (reply: EmbedWorkerReply) => void): number {
    if (!this.worker) {
      throw new EmbedError("the embedding thread is gone");
    }
    const req = ++this.lastReq;
    this.waiting.set(req, deliver);
    this.worker.postMessage({ ...msg, req });
    return req;
  }

  /** One request, one reply. */
  private call(msg: Send<EmbedWorkerRequest>): Promise<EmbedWorkerReply> {
    return new Promise((resolve, reject) => {
      const req = this.send(msg, (reply) => {
        this.waiting.delete(req);
        if (reply.type === "error") {
          reject(new EmbedError(reply.message));
        } else {
          resolve(reply);
        }
      });
    });
  }

  private async load(): Promise<void> {
    const path = join(this.cfg.modelsDir, EMBED_MODEL_FILE);
    if (!(await Bun.file(path).exists())) {
      throw new EmbedError(`the embedding model is not at ${path}; run: ${fetchCommand()}`);
    }
    this.worker ??= this.start();
    await this.call({
      type: "load",
      options: {
        dir: this.cfg.llamaDir,
        path,
        maxTokens: EMBED_MAX_TOKENS,
        threads: inferenceThreads(this.cfg.embedThreads),
      },
    });
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    signal?.throwIfAborted();
    if (texts.length === 0) {
      return [];
    }
    this.loaded ??= this.load().catch((e) => {
      this.loaded = undefined;
      throw e;
    });
    await this.loaded;
    signal?.throwIfAborted();
    const reply = await new Promise<EmbedWorkerReply>((resolve, reject) => {
      const onAbort = () => {
        this.waiting.delete(req);
        this.worker?.postMessage({ type: "cancel", req } satisfies EmbedWorkerRequest);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the reason is whatever the caller aborted with, as throwIfAborted throws it
        reject(signal!.reason);
      };
      const req = this.send({ type: "embed", texts }, (answer) => {
        this.waiting.delete(req);
        signal?.removeEventListener("abort", onAbort);
        resolve(answer);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (reply.type === "error") {
      throw new EmbedError(`embedding failed: ${reply.message}`);
    }
    if (reply.type !== "vectors") {
      throw new EmbedError(`unexpected ${reply.type} reply to an embedding request`);
    }
    return texts.map((_, i) => reply.vectors.subarray(i * reply.dim, (i + 1) * reply.dim));
  }

  async unload(): Promise<void> {
    const { loaded } = this;
    this.loaded = undefined;
    if (!this.worker) {
      return;
    }
    // A load still in flight finishes first, so that its model is the one freed.
    await loaded?.catch(() => {});
    if (this.worker) {
      await this.call({ type: "unload" });
    }
  }
}
