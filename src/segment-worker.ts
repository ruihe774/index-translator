// Worker thread that owns ONNX Runtime and the SaT model. Running the model blocks, so it runs here
// and the server thread stays free to answer requests. Every message is handled to its end before
// the next one. A request is run in batches of windows, and between two batches this thread looks
// at memory it shares with the server thread to see whether the client has gone.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SegmentedText } from "./api";
import { loadRuntime, type Runtime, type Session } from "./onnxruntime-ffi";
import { findBoundaries, type TokenizerJson, XlmrTokenizer } from "./sat";

export interface SegmentModelOptions {
  /** Directory with the ONNX Runtime library. */
  runtimeDir: string;
  /** Directory with `model.onnx` and `tokenizer.json`. */
  modelDir: string;
  threads: number;
}

export type SegmentWorkerRequest =
  | { type: "load"; req: number; options: SegmentModelOptions }
  | { type: "unload"; req: number }
  // `abort` holds one Int32 that the server thread makes non-zero when nobody wants the answer any more.
  | { type: "segment"; req: number; texts: string[]; minProbability: number; abort: SharedArrayBuffer };

export type SegmentWorkerReply =
  | { type: "ok"; req: number; version?: string }
  | { type: "boundaries"; req: number; texts: SegmentedText[] }
  /** The request was given up because its `abort` was set. */
  | { type: "aborted"; req: number }
  | { type: "error"; req: number; message: string };

declare var self: Worker;

/** The runtime stays loaded once opened (closing and reopening a library buys nothing); the model does not. */
let runtime: Runtime | undefined;
let loaded: { session: Session; tokenizer: XlmrTokenizer } | undefined;

function unload(): void {
  loaded?.session.close();
  loaded = undefined;
}

function handle(msg: SegmentWorkerRequest): SegmentWorkerReply {
  switch (msg.type) {
    case "load": {
      unload();
      runtime ??= loadRuntime(msg.options.runtimeDir);
      const tokenizer = new XlmrTokenizer(
        JSON.parse(readFileSync(join(msg.options.modelDir, "tokenizer.json"), "utf8")) as TokenizerJson,
      );
      loaded = { session: runtime.open(join(msg.options.modelDir, "model.onnx"), msg.options.threads), tokenizer };
      return { type: "ok", req: msg.req, version: runtime.version };
    }
    case "unload": {
      unload();
      return { type: "ok", req: msg.req };
    }
    case "segment": {
      if (!loaded) {
        throw new Error("the segmentation model is not loaded");
      }
      const { session, tokenizer } = loaded;
      const abort = new Int32Array(msg.abort);
      const texts = findBoundaries(
        tokenizer,
        msg.texts,
        (ids, mask, rows, width) => session.run(ids, mask, rows, width),
        msg.minProbability,
        () => Atomics.load(abort, 0) !== 0,
      );
      return texts ? { type: "boundaries", req: msg.req, texts } : { type: "aborted", req: msg.req };
    }
  }
}

self.onmessage = (event: MessageEvent<SegmentWorkerRequest>) => {
  let reply: SegmentWorkerReply;
  try {
    reply = handle(event.data);
  } catch (e) {
    reply = { type: "error", req: event.data.req, message: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage(reply);
};
