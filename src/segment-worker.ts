// Worker thread that owns ONNX Runtime and its two models: SaT (sentence ends) and LaBSE (sentence
// embeddings, for alignment). Running a model blocks, so it runs here and the server thread stays free
// to answer requests. Every message is handled to its end before the next one. A request is run in
// batches, and between two batches this thread looks at memory it shares with the server thread to see
// whether the client has gone.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { alignSentences, lengthOf, openings, translatedLengths } from "./align";
import type { AlignedPair, AlignUnit, SegmentedText } from "./api";
import { type Dense, DIMENSIONS, embed, readDense, WordPieceTokenizer } from "./labse";
import { loadRuntime, type Runtime, type Session } from "./onnxruntime-ffi";
import { findBoundaries, type TokenizerJson, XlmrTokenizer } from "./sat";
import { serve } from "./worker-rpc";

/** `sat`: `model.onnx` and `tokenizer.json`; `labse`: `model.onnx`, `vocab.txt` and `dense.safetensors`. */
export type SegmentModel = "sat" | "labse";

export interface SegmentModelOptions {
  /** Directory with the ONNX Runtime library. */
  runtimeDir: string;
  /** Directory with the model's files. */
  modelDir: string;
  threads: number;
}

/** The request was given up because its `abort` was set. */
interface Aborted {
  type: "aborted";
}

// `abort` holds one Int32 that the server thread makes non-zero when nobody wants the answer any more.
export interface SegmentProtocol {
  load: { request: { model: SegmentModel; options: SegmentModelOptions }; reply: { type: "ok"; version?: string } };
  unload: { request: { model: SegmentModel }; reply: { type: "ok" } };
  segment: {
    request: { texts: string[]; minProbability: number; abort: SharedArrayBuffer };
    reply: { type: "boundaries"; texts: SegmentedText[] } | Aborted;
  };
  align: {
    request: { unit: AlignUnit; source: string[]; target: string[]; abort: SharedArrayBuffer };
    reply: { type: "alignment"; pairs: AlignedPair[] } | Aborted;
  };
}

/** The runtime stays loaded once opened (closing and reopening a library buys nothing); the models do not. */
let runtime: Runtime | undefined;
let sat: { session: Session; tokenizer: XlmrTokenizer } | undefined;
let labse: { session: Session; tokenizer: WordPieceTokenizer; dense: Dense } | undefined;

function unload(model: SegmentModel): void {
  if (model === "sat") {
    sat?.session.close();
    sat = undefined;
  } else {
    labse?.session.close();
    labse = undefined;
  }
}

function load(model: SegmentModel, options: SegmentModelOptions): void {
  unload(model);
  runtime ??= loadRuntime(options.runtimeDir);
  const file = (name: string) => join(options.modelDir, name);
  if (model === "sat") {
    const tokenizer = new XlmrTokenizer(JSON.parse(readFileSync(file("tokenizer.json"), "utf8")) as TokenizerJson);
    const signature = { inputs: ["input_ids", "attention_mask"], output: "logits" };
    sat = { session: runtime.open(file("model.onnx"), options.threads, signature), tokenizer };
  } else {
    const tokenizer = new WordPieceTokenizer(readFileSync(file("vocab.txt"), "utf8"));
    const dense = readDense(readFileSync(file("dense.safetensors")));
    const signature = { inputs: ["input_ids", "attention_mask", "token_type_ids"], output: "last_hidden_state" };
    labse = { session: runtime.open(file("model.onnx"), options.threads, signature), tokenizer, dense };
  }
}

serve<SegmentProtocol>({
  load: (msg) => {
    load(msg.model, msg.options);
    return { type: "ok", version: runtime!.version };
  },
  unload: (msg) => {
    unload(msg.model);
    return { type: "ok" };
  },
  segment: (msg) => {
    if (!sat) {
      throw new Error("the segmentation model is not loaded");
    }
    const { session, tokenizer } = sat;
    const abort = new Int32Array(msg.abort);
    const texts = findBoundaries(
      tokenizer,
      msg.texts,
      (ids, mask, rows, width) => session.run([ids, mask], rows, width, 1),
      msg.minProbability,
      () => Atomics.load(abort, 0) !== 0,
    );
    return texts ? { type: "boundaries", texts } : { type: "aborted" };
  },
  align: (msg) => {
    if (!labse) {
      throw new Error("the alignment model is not loaded");
    }
    const { session, tokenizer, dense } = labse;
    const abort = new Int32Array(msg.abort);
    // A paragraph is read by its opening and weighed by its whole length.
    const read = msg.unit === "paragraphs" ? openings(msg.source, msg.target) : msg;
    const embeddings = embed(
      tokenizer,
      dense,
      [...read.source, ...read.target],
      // BERT's segment ids: every token is of the first segment.
      (ids, mask, rows, width) => session.run([ids, mask, new BigInt64Array(ids.length)], rows, width, DIMENSIONS),
      () => Atomics.load(abort, 0) !== 0,
    );
    if (!embeddings) {
      return { type: "aborted" };
    }
    const lengths =
      msg.unit === "paragraphs"
        ? translatedLengths(msg.source, msg.target)
        : { source: msg.source.map(lengthOf), target: msg.target.map(lengthOf) };
    const pairs = alignSentences(
      { embeddings: embeddings.slice(0, msg.source.length), lengths: lengths.source },
      { embeddings: embeddings.slice(msg.source.length), lengths: lengths.target },
      msg.unit,
    );
    return { type: "alignment", pairs };
  },
});
