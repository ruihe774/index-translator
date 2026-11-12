// libllama as a sentence encoder, through bun:ffi: LaBSE (a BERT with CLS pooling) on the processor. Used by the
// segmentation worker only (src/segment-worker.ts), a thread other than the chat engine's; each thread opens the
// libraries itself and `shim_init` (src/llama-shim.c) sets them up once for the process. Every call blocks.

import { dlopen, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";

import { cstr, once } from "./ffi-util";
import { libraryPath } from "./llama-ffi";

/** Sequences in one `Embedder.embed` call. */
export const MAX_SEQUENCES = 16;
/** The longest sequence it takes: LaBSE's 512 positions. */
export const MAX_SEQUENCE_TOKENS = 512;

function bind(dir: string) {
  if (!existsSync(libraryPath(dir))) {
    throw new Error(`libllama not found in ${dir}; run: bun scripts/zigbuild_llamacpp.ts`);
  }
  // libllama's own calls and the shim's, one library
  const lib = dlopen(libraryPath(dir), {
    llama_model_free: { args: ["ptr"], returns: "void" },
    llama_free: { args: ["ptr"], returns: "void" },
    llama_model_n_embd: { args: ["ptr"], returns: "i32" },
    shim_init: { args: ["ptr"], returns: "void" },
    shim_load_model: { args: ["ptr", "i32", "bool"], returns: "ptr" },
    shim_new_embed_context: { args: ["ptr", "u32", "u32", "i32"], returns: "ptr" },
    shim_embed: { args: ["ptr", "ptr", "ptr", "i32", "ptr", "i32"], returns: "i32" },
  }).symbols;
  lib.shim_init(cstr(dir));
  return lib;
}

const llama = once("libllama", bind);

type Handle = Pointer | bigint;

export class Embedder {
  private constructor(
    private readonly lib: ReturnType<typeof bind>,
    private model: Handle | undefined,
    private ctx: Handle | undefined,
    /** Floats per embedding. */
    readonly dimensions: number,
  ) {}

  /** Loads the GGUF at `file` on the processor with `threads` threads; throws when it is not an encoder with `dimensions`. */
  static load(dir: string, file: string, threads: number, dimensions: number): Embedder {
    const lib = llama.open(dir);
    const model = lib.shim_load_model(cstr(file), 0, false);
    if (!model) {
      throw new Error(`could not load ${file}`);
    }
    const n = lib.llama_model_n_embd(model);
    if (n !== dimensions) {
      lib.llama_model_free(model);
      throw new Error(`${file} embeds in ${n} dimensions, not ${dimensions}`);
    }
    const ctx = lib.shim_new_embed_context(model, MAX_SEQUENCES * MAX_SEQUENCE_TOKENS, MAX_SEQUENCES, threads);
    if (!ctx) {
      lib.llama_model_free(model);
      throw new Error(`could not create a context for ${file}`);
    }
    return new Embedder(lib, model, ctx, dimensions);
  }

  /** The first token's state of each sequence (token ids, [CLS] first), `dimensions` floats a row. */
  embed(sequences: number[][]): Float32Array {
    if (!this.ctx) {
      throw new Error("the model is freed");
    }
    const lens = Int32Array.from(sequences, (s) => s.length);
    const tokens = Int32Array.from(sequences.flat());
    const out = new Float32Array(sequences.length * this.dimensions);
    const status = this.lib.shim_embed(this.ctx, tokens, lens, sequences.length, out, this.dimensions);
    if (status !== 0) {
      throw new Error(`llama.cpp failed to embed (status ${status})`);
    }
    return out;
  }

  free(): void {
    if (this.ctx) {
      this.lib.llama_free(this.ctx);
    }
    if (this.model) {
      this.lib.llama_model_free(this.model);
    }
    this.ctx = undefined;
    this.model = undefined;
  }
}
