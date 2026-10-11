// libllama through bun:ffi: the synchronous calls the engine worker needs to load a model, build
// its chat prompt, tokenize, decode and sample. Every call here blocks its thread, so this module
// is only used from src/llama-worker.ts.

import { CString, cc, dlopen, suffix, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Most tokens one llama_decode call accepts. */
const BATCH_SIZE = 512;
/** Prompt tokens per decode without a GPU, where a full batch would block the thread for seconds. */
const CPU_PROMPT_STEP = 64;

const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");

const libName = (name: string) => (process.platform === "win32" ? `${name}.${suffix}` : `lib${name}.${suffix}`);

function bind(dir: string) {
  const libPath = join(dir, libName("llama"));
  const include = join(dir, "include");
  if (!existsSync(libPath) || !existsSync(join(include, "llama.h"))) {
    throw new Error(`libllama not found in ${dir}; run: bun scripts/fetch_llama.ts`);
  }
  const llama = dlopen(libPath, {
    llama_model_free: { args: ["ptr"], returns: "void" },
    llama_free: { args: ["ptr"], returns: "void" },
    llama_model_get_vocab: { args: ["ptr"], returns: "ptr" },
    llama_model_chat_template: { args: ["ptr", "ptr"], returns: "ptr" },
    llama_n_ctx: { args: ["ptr"], returns: "u32" },
    llama_get_memory: { args: ["ptr"], returns: "ptr" },
    llama_memory_clear: { args: ["ptr", "bool"], returns: "void" },
    llama_tokenize: { args: ["ptr", "ptr", "i32", "ptr", "i32", "bool", "bool"], returns: "i32" },
    llama_token_to_piece: { args: ["ptr", "i32", "ptr", "i32", "i32", "bool"], returns: "i32" },
    llama_vocab_is_eog: { args: ["ptr", "i32"], returns: "bool" },
    llama_sampler_init_greedy: { args: [], returns: "ptr" },
    llama_sampler_sample: { args: ["ptr", "ptr", "i32"], returns: "i32" },
    llama_sampler_free: { args: ["ptr"], returns: "void" },
  }).symbols;
  const shim = cc({
    source: join(import.meta.dir, "llama-shim.c"),
    include: [include],
    library: ["llama", "ggml"],
    flags: [`-L${dir}`],
    symbols: {
      shim_init: { args: ["ptr"], returns: "void" },
      shim_load_model: { args: ["ptr", "i32"], returns: "ptr" },
      shim_new_context: { args: ["ptr", "u32", "u32", "i32"], returns: "ptr" },
      shim_decode: { args: ["ptr", "ptr", "i32"], returns: "i32" },
    },
  }).symbols;
  shim.shim_init(cstr(dir));
  return { ...llama, ...shim };
}

type Lib = ReturnType<typeof bind>;
/** A non-null pointer returned by the library. */
type Handle = Pointer | bigint;

let lib: Lib | undefined;
let libDir = "";

/** Opens the libraries in `dir` and registers the backends, once per process. */
function open(dir: string): Lib {
  if (lib && libDir !== dir) throw new Error(`libllama is already loaded from ${libDir}`);
  lib ??= bind(dir);
  libDir = dir;
  return lib;
}

/**
 * The prompt for one user message, as the models' ChatML Jinja template renders it with
 * `enable_thinking=false`: the content is trimmed, and a template that knows about thinking gets
 * an empty think block so the answer starts right away.
 */
export function chatPrompt(content: string, emptyThink: boolean): string {
  const trimmed = content.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  return `<|im_start|>user\n${trimmed}<|im_end|>\n<|im_start|>assistant\n${emptyThink ? "<think>\n\n</think>\n\n" : ""}`;
}

export interface ModelOptions {
  /** Directory with libllama, its backends and `include/llama.h`. */
  dir: string;
  path: string;
  /** Layers to offload; negative means all. */
  gpuLayers: number;
  ctxSize: number;
  /** 0 keeps the library default. */
  threads: number;
}

/** One model with one context. Not thread-safe; `free()` must be called to release its memory. */
export class Model {
  /** Context window in tokens, as the library allocated it. */
  readonly ctxSize: number;
  /** Tokens to hand to one decode() call: the prompt is fed in pieces so the caller can stop between them. */
  readonly promptStep: number;

  private vocab: Handle;
  private sampler: Handle;
  private emptyThink: boolean;
  private one = new Int32Array(1);
  private pieceBuf = new Uint8Array(256);
  private freed = false;

  private constructor(
    private lib: Lib,
    private model: Handle,
    private ctx: Handle,
    onGpu: boolean,
  ) {
    this.promptStep = onGpu ? BATCH_SIZE : CPU_PROMPT_STEP;
    this.ctxSize = lib.llama_n_ctx(ctx);
    this.vocab = lib.llama_model_get_vocab(model)!;
    this.sampler = lib.llama_sampler_init_greedy()!;
    const template = lib.llama_model_chat_template(model, null);
    const text = template ? new CString(template).toString() : "";
    if (!text.includes("<|im_start|>")) {
      this.free();
      throw new Error("the model's chat template is not ChatML, which is the only format this engine writes");
    }
    this.emptyThink = text.includes("enable_thinking");
  }

  static load(opts: ModelOptions): Model {
    const lib = open(opts.dir);
    const model = lib.shim_load_model(cstr(opts.path), opts.gpuLayers);
    if (!model) throw new Error(`llama.cpp could not load ${opts.path}`);
    const ctx = lib.shim_new_context(model, opts.ctxSize, BATCH_SIZE, opts.threads);
    if (!ctx) {
      lib.llama_model_free(model);
      throw new Error(`llama.cpp could not create a ${opts.ctxSize}-token context (out of memory?)`);
    }
    return new Model(lib, model, ctx, opts.gpuLayers !== 0);
  }

  /** Tokens of the whole prompt for a user message with this content. Special tokens written out in the content are parsed as such. */
  tokenize(content: string): Int32Array {
    const text = Buffer.from(chatPrompt(content, this.emptyThink), "utf8");
    // A token covers at least one byte; the slack is for special tokens the vocabulary may add.
    const tokens = new Int32Array(text.length + 8);
    const n = this.lib.llama_tokenize(this.vocab, text, text.length, tokens, tokens.length, true, true);
    if (n < 0) throw new Error("llama_tokenize failed");
    return tokens.subarray(0, n);
  }

  /** Empties the context so the next prompt starts from position 0. */
  reset(): void {
    this.lib.llama_memory_clear(this.lib.llama_get_memory(this.ctx), true);
  }

  /** Evaluates up to `promptStep` tokens after what the context already holds. */
  decode(tokens: Int32Array): void {
    const status = this.lib.shim_decode(this.ctx, tokens, tokens.length);
    if (status !== 0) throw new Error(`llama_decode failed with status ${status}`);
  }

  decodeOne(token: number): void {
    this.one[0] = token;
    this.decode(this.one);
  }

  /** The most likely next token after the last decode. */
  sample(): number {
    return this.lib.llama_sampler_sample(this.sampler, this.ctx, -1);
  }

  /** True for end-of-turn and end-of-text tokens. */
  isEnd(token: number): boolean {
    return this.lib.llama_vocab_is_eog(this.vocab, token);
  }

  /** The token's UTF-8 bytes, which may end inside a character. Control tokens render as nothing. The view is reused by the next call. */
  piece(token: number): Uint8Array {
    let n = this.lib.llama_token_to_piece(this.vocab, token, this.pieceBuf, this.pieceBuf.length, 0, false);
    if (n < 0) {
      this.pieceBuf = new Uint8Array(-n);
      n = this.lib.llama_token_to_piece(this.vocab, token, this.pieceBuf, this.pieceBuf.length, 0, false);
    }
    return this.pieceBuf.subarray(0, Math.max(n, 0));
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.lib.llama_sampler_free(this.sampler);
    this.lib.llama_free(this.ctx);
    this.lib.llama_model_free(this.model);
  }
}
