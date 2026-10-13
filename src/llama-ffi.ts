// libllama through bun:ffi: the synchronous calls the engine worker needs to load a model, build
// its chat prompt, tokenize, decode and sample. Every call here blocks its thread, so this module
// is only used from src/llama-worker.ts.

import { CString, dlopen, type Pointer, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Most tokens one llama_decode call accepts. */
const BATCH_SIZE = 512;
/** Prompt tokens per decode without a GPU, where a full batch would block the thread for seconds. */
const CPU_PROMPT_STEP = 64;

const cstr = (s: string) => new TextEncoder().encode(`${s}\0`);

const libName = (name: string) => (process.platform === "win32" ? `${name}.${suffix}` : `lib${name}.${suffix}`);

export const libraryPath = (dir: string) => join(dir, libName("llama"));
/** src/llama-shim.c as scripts/build_llama.ts compiled it, against the headers of the libllama beside it. */
export const shimPath = (dir: string) => join(dir, libName("llama-shim"));
/** llama.cpp's library for image input, from the same build. */
export const mtmdPath = (dir: string) => join(dir, libName("mtmd"));

function bind(dir: string) {
  if (!existsSync(libraryPath(dir)) || !existsSync(shimPath(dir))) {
    throw new Error(`libllama and its shim not found in ${dir}; run: bun scripts/build_llama.ts`);
  }
  if (!existsSync(mtmdPath(dir))) {
    throw new Error(`libmtmd not found in ${dir} (a build from before image input); run: bun scripts/build_llama.ts`);
  }
  const llama = dlopen(libraryPath(dir), {
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
  const shim = dlopen(shimPath(dir), {
    shim_init: { args: ["ptr"], returns: "void" },
    shim_devices: { args: ["ptr", "i32"], returns: "i32" },
    shim_load_model: { args: ["ptr", "i32"], returns: "ptr" },
    shim_new_context: { args: ["ptr", "u32", "u32", "i32"], returns: "ptr" },
    shim_decode: { args: ["ptr", "ptr", "i32"], returns: "i32" },
    shim_decode_at: { args: ["ptr", "ptr", "i32", "i32"], returns: "i32" },
    shim_mtmd_load: { args: ["ptr", "ptr", "bool", "i32"], returns: "ptr" },
    shim_mtmd_bitmap: { args: ["ptr", "usize"], returns: "ptr" },
    shim_mtmd_tokenize: { args: ["ptr", "ptr", "usize", "ptr", "ptr", "usize"], returns: "ptr" },
    shim_mtmd_eval_chunk: { args: ["ptr", "ptr", "ptr", "i32", "i32", "ptr"], returns: "i32" },
  }).symbols;
  // libmtmd (tools/mtmd/mtmd.h, mtmd-helper.h): the calls that need no struct. The shim links it.
  const mtmd = dlopen(mtmdPath(dir), {
    mtmd_free: { args: ["ptr"], returns: "void" },
    mtmd_bitmap_free: { args: ["ptr"], returns: "void" },
    mtmd_input_chunks_size: { args: ["ptr"], returns: "usize" },
    mtmd_input_chunks_free: { args: ["ptr"], returns: "void" },
    mtmd_helper_get_n_tokens: { args: ["ptr"], returns: "usize" },
  }).symbols;
  shim.shim_init(cstr(dir));
  return { ...llama, ...shim, ...mtmd };
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

export interface Device {
  /** ggml's device type; a model is offloaded to the `gpu` and `igpu` ones. */
  type: "cpu" | "gpu" | "igpu" | "accel" | "meta" | "other";
  /** Name and description, e.g. "Vulkan0: AMD Radeon RX 9070 (RADV GFX1201)". */
  label: string;
}

/**
 * What the backends in `dir` can compute on: no `gpu` without a working Vulkan driver, no `cpu` when
 * no CPU backend could be loaded. Opens the libraries, so it is for the engine thread or a process
 * of its own.
 */
export function devices(dir: string): Device[] {
  const text = new Uint8Array(8192);
  open(dir).shim_devices(text, text.length);
  const end = text.indexOf(0);
  const lines = new TextDecoder()
    .decode(text.subarray(0, Math.max(end, 0)))
    .split("\n")
    .filter(Boolean);
  return lines.map((line) => {
    const space = line.indexOf(" ");
    return { type: line.slice(0, space) as Device["type"], label: line.slice(space + 1) };
  });
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

/**
 * The same prompt for a user message of `content` followed by one image, as what stands before the
 * image and what stands after it. The template writes the image as `<|vision_start|>`, its
 * embeddings, `<|vision_end|>`, which libmtmd puts between the two.
 */
export function imageChatPrompt(content: string, emptyThink: boolean): [before: string, after: string] {
  const whole = chatPrompt(`${content}\0`, emptyThink);
  // The last one: nothing after the content holds a NUL, the content might.
  const at = whole.lastIndexOf("\0");
  return [whole.slice(0, at), whole.slice(at + 1)];
}

export interface ModelOptions {
  /** Directory with libllama, its backends and the shim. */
  dir: string;
  path: string;
  /** Layers to offload; negative means all. */
  gpuLayers: number;
  ctxSize: number;
  /** 0 keeps the library default. */
  threads: number;
  /** The model's image encoder and projector (its mmproj GGUF); loaded when the first image arrives. */
  mmproj?: string;
}

/** An image the model cannot take: not a readable image file, or the model has no encoder for one. */
export class ImageError extends Error {}

/** A prompt with an image, tokenized and preprocessed for one evaluation. `free()` must be called. */
export class ImagePrompt {
  private freed = false;

  constructor(
    private lib: Lib,
    /** libmtmd's chunks: text, the image, text. */
    readonly handle: Handle,
  ) {}

  /** Tokens the prompt occupies in the context, the image's embeddings included. */
  get tokens(): number {
    return Number(this.lib.mtmd_helper_get_n_tokens(this.handle));
  }

  /** Pieces to hand to `Model.evalChunk` in order. */
  get chunks(): number {
    return Number(this.lib.mtmd_input_chunks_size(this.handle));
  }

  free(): void {
    if (!this.freed) this.lib.mtmd_input_chunks_free(this.handle);
    this.freed = true;
  }
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
  /** The image encoder, once an image has asked for it. */
  private vision?: Handle;
  /** Where the next token goes after a prompt with an image, which only libmtmd can tell; -1 while libllama counts. */
  private nextPos = -1;
  private posBuf = new Int32Array(1);
  private pieceBuf = new Uint8Array(256);
  private freed = false;

  private constructor(
    private lib: Lib,
    private model: Handle,
    private ctx: Handle,
    private onGpu: boolean,
    private threads: number,
    private mmproj: string | undefined,
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
    return new Model(lib, model, ctx, opts.gpuLayers !== 0, opts.threads, opts.mmproj);
  }

  /** Tokens of the whole prompt for a user message with this content. Special tokens written out in the content are parsed as such. */
  tokenize(content: string): Int32Array {
    const text = new TextEncoder().encode(chatPrompt(content, this.emptyThink));
    // A token covers at least one byte; the slack is for special tokens the vocabulary may add.
    const tokens = new Int32Array(text.length + 8);
    const n = this.lib.llama_tokenize(this.vocab, text, text.length, tokens, tokens.length, true, true);
    if (n < 0) throw new Error("llama_tokenize failed");
    return tokens.subarray(0, n);
  }

  /**
   * The prompt for a user message of `content` followed by the image in `file` (a PNG; anything
   * else stb_image reads would do). The image is decoded and scaled to what the encoder takes here;
   * encoding it is left to `evalChunk`. The first call loads the encoder. Throws ImageError when the
   * file is not an image or the model takes none.
   */
  imagePrompt(content: string, file: Uint8Array): ImagePrompt {
    if (!this.mmproj) throw new ImageError("this model does not take images");
    if (!this.vision) {
      const vision = this.lib.shim_mtmd_load(cstr(this.mmproj), this.model, this.onGpu, this.threads);
      if (!vision) throw new Error(`llama.cpp could not load the image encoder ${this.mmproj}`);
      this.vision = vision;
    }
    const bitmap = this.lib.shim_mtmd_bitmap(file, file.length);
    if (!bitmap) throw new ImageError("the image could not be decoded");
    const [before, after] = imageChatPrompt(content, this.emptyThink).map((s) => new TextEncoder().encode(s)) as [
      Uint8Array,
      Uint8Array,
    ];
    const chunks = this.lib.shim_mtmd_tokenize(this.vision, before, before.length, bitmap, after, after.length);
    // The chunks hold the preprocessed image; the decoded one is not needed again.
    this.lib.mtmd_bitmap_free(bitmap);
    if (!chunks) throw new ImageError("the image could not be prepared for the model");
    return new ImagePrompt(this.lib, chunks);
  }

  /**
   * Evaluates piece `index` of an image prompt after what the context already holds, starting with
   * 0 on an empty context. The image's piece runs the encoder and decodes its embeddings in one
   * blocking call.
   */
  evalChunk(prompt: ImagePrompt, index: number): void {
    if (index === 0) this.posBuf[0] = 0;
    const status = this.lib.shim_mtmd_eval_chunk(this.vision!, this.ctx, prompt.handle, index, BATCH_SIZE, this.posBuf);
    if (status !== 0) throw new Error(`evaluating the image prompt failed with status ${status}`);
    this.nextPos = this.posBuf[0]!;
  }

  /** Empties the context so the next prompt starts from position 0. */
  reset(): void {
    this.lib.llama_memory_clear(this.lib.llama_get_memory(this.ctx), true);
    this.nextPos = -1;
  }

  /** Evaluates up to `promptStep` tokens after what the context already holds. */
  decode(tokens: Int32Array): void {
    let status: number;
    if (this.nextPos < 0) {
      status = this.lib.shim_decode(this.ctx, tokens, tokens.length);
    } else {
      status = this.lib.shim_decode_at(this.ctx, tokens, tokens.length, this.nextPos);
      this.nextPos += tokens.length;
    }
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
    if (this.vision) this.lib.mtmd_free(this.vision);
    this.lib.llama_free(this.ctx);
    this.lib.llama_model_free(this.model);
  }
}
