// Worker thread that owns the models of sentence work: SaT (sentence ends, on ONNX Runtime) and LaBSE (sentence
// embeddings, for alignment, on libllama). Running a model blocks, so it runs here and the server thread stays free
// to answer requests. Every message is handled to its end before the next one. A request is run in
// batches, and between two batches this thread looks at memory it shares with the server thread to see
// whether the client has gone.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { alignSentences, lengthOf, openings, translatedLengths } from "./align";
import type { AlignedPair, AlignUnit, SegmentedText } from "./api";
import { type Dense, DIMENSIONS, embed, readDense, WordPieceTokenizer } from "./labse";
import { Embedder } from "./llama-embed-ffi";
import { loadRuntime, type Runtime, type Session } from "./onnxruntime-ffi";
import { findBoundaries, type TokenizerJson, XlmrTokenizer } from "./sat";
import { abortFlag, isAborted, serve } from "./worker-rpc";

/** `sat`: `model.onnx` and `tokenizer.json`; `labse`: `model.gguf`, `vocab.txt` and `dense.safetensors`. */
export type SegmentModel = "sat" | "labse";

export interface SegmentModelOptions {
  /** Directory with the model's engine: ONNX Runtime for `sat`, libllama for `labse`. */
  libraryDir: string;
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
let labse: { encoder: Embedder; tokenizer: WordPieceTokenizer; dense: Dense } | undefined;

function unload(model: SegmentModel): void {
  if (model === "sat") {
    sat?.session.close();
    sat = undefined;
  } else {
    labse?.encoder.free();
    labse = undefined;
  }
}

function load(model: SegmentModel, options: SegmentModelOptions): void {
  unload(model);
  const file = (name: string) => join(options.modelDir, name);
  if (model === "sat") {
    runtime ??= loadRuntime(options.libraryDir);
    const tokenizer = new XlmrTokenizer(JSON.parse(readFileSync(file("tokenizer.json"), "utf8")) as TokenizerJson);
    const signature = { inputs: ["input_ids", "attention_mask"], output: "logits" };
    sat = { session: runtime.open(file("model.onnx"), options.threads, signature), tokenizer };
  } else {
    const tokenizer = new WordPieceTokenizer(readFileSync(file("vocab.txt"), "utf8"));
    const dense = readDense(readFileSync(file("dense.safetensors")));
    const encoder = Embedder.load(options.libraryDir, file("model.gguf"), options.threads, DIMENSIONS);
    labse = { encoder, tokenizer, dense };
  }
}

serve<SegmentProtocol>({
  load: (msg) => {
    load(msg.model, msg.options);
    return { type: "ok", version: msg.model === "sat" ? runtime!.version : undefined };
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
    const abort = abortFlag(msg.abort);
    const texts = findBoundaries(
      tokenizer,
      msg.texts,
      (ids, mask, rows, width) => session.run([ids, mask], rows, width, 1),
      msg.minProbability,
      () => isAborted(abort),
    );
    return texts ? { type: "boundaries", texts } : { type: "aborted" };
  },
  align: (msg) => {
    if (!labse) {
      throw new Error("the alignment model is not loaded");
    }
    const { encoder, tokenizer, dense } = labse;
    const abort = abortFlag(msg.abort);
    // A paragraph is read by its opening and weighed by its whole length.
    const read = msg.unit === "paragraphs" ? openings(msg.source, msg.target) : msg;
    const embeddings = embed(
      tokenizer,
      dense,
      [...read.source, ...read.target],
      (sequences) => encoder.embed(sequences),
      () => isAborted(abort),
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
