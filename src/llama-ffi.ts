// libllama through bun:ffi: the synchronous calls the engine worker needs to load a model, build
// its chat prompt, tokenize, decode and sample. Every call here blocks its thread, so this module
// is only used from src/llama-worker.ts.

import { CString, dlopen, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";

import { cstr, libraryFile, once } from "./ffi-util";

/** Most tokens one llama_decode call accepts. */
const BATCH_SIZE = 512;
/** Prompt tokens per decode without a GPU, where a full batch would block the thread for seconds. */
const CPU_PROMPT_STEP = 64;
/**
 * Tokens the MTP layer drafts per step. With Index-Translate-9B (Q8_0, GB10) 2 decoded 1.65 times as fast as without
 * MTP, 1 1.53 times and 3 1.57 times: the layer is trained one token ahead, and a second draft is kept about half the time.
 */
const MTP_DRAFT = 2;
/**
 * GPU memory (all GPUs, as the backend reports it) that MTP needs: it adds about 0.65 GiB (the layer, its KV cache,
 * two more copies of the recurrent state). A 16 GiB card reports a little under that (15.9 GiB on an RX 9070), so the
 * limit sits below it: measured there, the chat model, an image and reading aloud still load with MTP on (reading
 * aloud takes what is left), and text decodes about 1.4 times as fast.
 */
const MTP_MIN_GPU_BYTES = 15.5 * 2 ** 30;

export const libraryPath = (dir: string) => libraryFile(dir, "llama");
/** src/llama-shim.c as scripts/build_llama.ts compiled it, against the headers of the libllama beside it. */
export const shimPath = (dir: string) => libraryFile(dir, "llama-shim");
/** llama.cpp's library for image input, from the same build. */
const mtmdPath = (dir: string) => libraryFile(dir, "mtmd");

/** Opens libllama, libmtmd and the shim (which links the other two) in `dir`, and registers the backends. */
function bind(dir: string) {
  if (![libraryPath(dir), shimPath(dir), mtmdPath(dir)].every((path) => existsSync(path))) {
    throw new Error(`libllama, libmtmd or the shim not found in ${dir}; run: bun scripts/build_llama.ts`);
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
  // libmtmd (tools/mtmd/mtmd.h, mtmd-helper.h): the calls that need no struct.
  const mtmd = dlopen(mtmdPath(dir), {
    mtmd_free: { args: ["ptr"], returns: "void" },
    mtmd_bitmap_free: { args: ["ptr"], returns: "void" },
    mtmd_input_chunks_size: { args: ["ptr"], returns: "usize" },
    mtmd_input_chunks_free: { args: ["ptr"], returns: "void" },
    mtmd_helper_get_n_tokens: { args: ["ptr"], returns: "usize" },
  }).symbols;
  // src/llama-shim.c and src/llama-shim-ext.cpp.
  const shim = dlopen(shimPath(dir), {
    shim_init: { args: ["ptr"], returns: "void" },
    shim_devices: { args: ["ptr", "i32"], returns: "i32" },
    shim_gpu_memory: { args: ["ptr", "ptr"], returns: "i32" },
    shim_load_model: { args: ["ptr", "i32", "bool"], returns: "ptr" },
    shim_new_context: { args: ["ptr", "u32", "u32", "i32", "u32"], returns: "ptr" },
    shim_decode_at: { args: ["ptr", "ptr", "i32", "i32"], returns: "i32" },
    shim_mtmd_load: { args: ["ptr", "ptr", "bool", "i32"], returns: "ptr" },
    shim_mtmd_bitmap: { args: ["ptr", "usize"], returns: "ptr" },
    shim_mtmd_tokenize: { args: ["ptr", "ptr", "usize", "ptr", "usize", "ptr", "ptr", "usize"], returns: "ptr" },
    shim_mtmd_eval_chunk: { args: ["ptr", "ptr", "ptr", "i32", "i32", "ptr"], returns: "i32" },
    shim_mtp_new: { args: ["ptr", "ptr", "u32", "u32", "i32", "i32"], returns: "ptr" },
    shim_mtp_free: { args: ["ptr"], returns: "void" },
    shim_mtp_reset: { args: ["ptr"], returns: "void" },
    shim_mtp_catch_up: { args: ["ptr", "ptr", "i32", "i32"], returns: "i32" },
    shim_mtp_step: { args: ["ptr", "ptr", "i32", "i32", "i32", "ptr"], returns: "i32" },
  }).symbols;
  shim.shim_init(cstr(dir));
  return { ...llama, ...shim, ...mtmd };
}

type Lib = ReturnType<typeof bind>;
/** A non-null pointer returned by the library (bun:ffi types a `ptr` result as either; it cannot be narrowed). */
type Handle = Pointer | bigint;

/** The libraries, opened once per process. */
const llama = once("libllama", bind);

interface Device {
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
  llama.open(dir).shim_devices(text, text.length);
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

/** Bytes of GPU memory, as the backend reports them for the whole device. */
export interface GpuMemory {
  free: number;
  total: number;
}

/**
 * The GPUs' memory summed, or undefined without a GPU. With `dir` it opens the libraries there if they are not open
 * yet; without it, the answer is undefined before they are.
 */
export function gpuMemory(dir?: string): GpuMemory | undefined {
  const lib = dir === undefined ? llama.loaded : llama.open(dir);
  if (!lib) {
    return undefined;
  }
  const out = new BigUint64Array(2);
  if (lib.shim_gpu_memory(out.subarray(0, 1), out.subarray(1)) === 0) {
    return undefined;
  }
  return { free: Number(out[0]), total: Number(out[1]) };
}

const PROMPT_HEAD = "<|im_start|>user\n";
const promptTail = (emptyThink: boolean) =>
  `<|im_end|>\n<|im_start|>assistant\n${emptyThink ? "<think>\n\n</think>\n\n" : ""}`;

/**
 * The prompt for one user message in three pieces: what the template writes before the content, the
 * trimmed content, and what it writes after. Only the first and the last are tokenized with special
 * tokens parsed; the content is the user's text, in which `<|im_start|>` and the like are just text.
 */
export function chatPromptParts(content: string, emptyThink: boolean): [head: string, body: string, tail: string] {
  return [PROMPT_HEAD, content.replaceAll(/^[ \t\n\r]+|[ \t\n\r]+$/g, ""), promptTail(emptyThink)];
}

/**
 * The prompt for one user message, as the models' ChatML Jinja template renders it with
 * `enable_thinking=false`: the content is trimmed, and a template that knows about thinking gets
 * an empty think block so the answer starts right away.
 */
export function chatPrompt(content: string, emptyThink: boolean): string {
  return chatPromptParts(content, emptyThink).join("");
}

/** The pieces of `chatPromptParts` for a user message followed by one image: the content keeps its trailing whitespace. */
function imagePromptParts(content: string, emptyThink: boolean): [head: string, body: string, tail: string] {
  return [PROMPT_HEAD, content.replace(/^[ \t\n\r]+/, ""), promptTail(emptyThink)];
}

/**
 * The same prompt for a user message of `content` followed by one image, as what stands before the
 * image and what stands after it. The template writes the image as `<|vision_start|>`, its
 * embeddings, `<|vision_end|>`, which libmtmd puts between the two.
 */
export function imageChatPrompt(content: string, emptyThink: boolean): [before: string, after: string] {
  const [head, body, tail] = imagePromptParts(content, emptyThink);
  return [head + body, tail];
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
  /**
   * Draft with the model's MTP layer (multi-token prediction) where it has one, every layer is on the GPU and the GPU
   * has MTP_MIN_GPU_BYTES. Text prompts only: after an image the model decodes one token at a time.
   */
  mtp: boolean;
}

/**
 * Whether a loaded model decodes with multi-token prediction: `off` when the options did not ask for it,
 * `ineligible` when they did but not every layer is on the GPU or the GPU is under MTP_MIN_GPU_BYTES, `no-layer` when
 * the model has no MTP layer (or its context could not be created), `on` otherwise.
 */
type MtpStatus = "off" | "ineligible" | "no-layer" | "on";

/** An image the model cannot take: not a readable image file, or the model has no encoder for one. */
export class ImageError extends Error {}

/** A prompt with an image, tokenized and preprocessed for one evaluation. `free()` must be called. */
export class ImagePrompt {
  private freed = false;

  constructor(
    private readonly lib: Lib,
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
    if (!this.freed) {
      this.lib.mtmd_input_chunks_free(this.handle);
    }
    this.freed = true;
  }
}

/** What the model has loaded, for the constructor. */
interface Loaded {
  lib: Lib;
  model: Handle;
  ctx: Handle;
  emptyThink: boolean;
  onGpu: boolean;
  threads: number;
  mmproj: string | undefined;
  /** The MTP drafter, when the model decodes with multi-token prediction. */
  mtp: Handle | null;
}

/** One model with one context. Not thread-safe; `free()` must be called to release its memory. */
export class Model {
  /** Context window in tokens, as the library allocated it. */
  readonly ctxSize: number;
  /** Tokens to hand to one decode() call: the prompt is fed in pieces so the caller can stop between them. */
  readonly promptStep: number;

  private readonly lib: Lib;
  private readonly model: Handle;
  private readonly ctx: Handle;
  private readonly vocab: Handle;
  private readonly sampler: Handle;
  private readonly emptyThink: boolean;
  private readonly onGpu: boolean;
  private readonly threads: number;
  private readonly mmproj: string | undefined;
  private readonly mtp: Handle | null;
  /** The image encoder, once an image has asked for it. */
  private vision?: Handle;
  /** Where the next token goes: the tokens the context holds, or after an image what libmtmd made of it. */
  private pos = 0;
  /** What the context holds. Only after a text prompt does the MTP layer draft; M-RoPE counts an image's positions its own way. */
  private prompt: "text" | "image" = "text";
  /** `evalChunk`'s position, which libmtmd reads and advances. */
  private posBuf = new Int32Array(1);
  private readonly one = new Int32Array(1);
  /** What the MTP step writes the target's choices to. */
  private readonly chosen = new Int32Array(MTP_DRAFT + 1);
  private pieceBuf = new Uint8Array(256);
  private freed = false;

  private constructor(m: Loaded) {
    this.lib = m.lib;
    this.model = m.model;
    this.ctx = m.ctx;
    this.emptyThink = m.emptyThink;
    this.onGpu = m.onGpu;
    this.threads = m.threads;
    this.mmproj = m.mmproj;
    this.mtp = m.mtp;
    this.promptStep = m.onGpu ? BATCH_SIZE : CPU_PROMPT_STEP;
    this.ctxSize = m.lib.llama_n_ctx(m.ctx);
    this.vocab = m.lib.llama_model_get_vocab(m.model)!;
    this.sampler = m.lib.llama_sampler_init_greedy()!;
  }

  /**
   * Loads the model in `opts.dir`, which opens the libraries on the first call. `gpuTotal` is the GPUs' memory in
   * bytes (0 without one), which decides whether MTP is on; the outcome is logged unless it was not asked for.
   */
  static load(opts: ModelOptions, gpuTotal: number): Model {
    const lib = llama.open(opts.dir);
    const eligible = opts.gpuLayers < 0 && gpuTotal >= MTP_MIN_GPU_BYTES;
    const useMtp = opts.mtp && eligible;
    const model = lib.shim_load_model(cstr(opts.path), opts.gpuLayers, useMtp);
    if (!model) {
      throw new Error(`llama.cpp could not load ${opts.path}`);
    }
    const template = lib.llama_model_chat_template(model, null);
    const templateText = template ? new CString(template) : "";
    if (!templateText.includes("<|im_start|>")) {
      lib.llama_model_free(model);
      throw new Error("the model's chat template is not ChatML, which is the only format this engine writes");
    }
    // Rejected drafts are taken back out of the recurrent layers, which keep a copy of their state per draft token.
    const ctx = lib.shim_new_context(model, opts.ctxSize, BATCH_SIZE, opts.threads, useMtp ? MTP_DRAFT : 0);
    if (!ctx) {
      lib.llama_model_free(model);
      throw new Error(`llama.cpp could not create a ${opts.ctxSize}-token context (out of memory?)`);
    }
    const mtp = useMtp ? lib.shim_mtp_new(model, ctx, opts.ctxSize, BATCH_SIZE, opts.threads, MTP_DRAFT) : null;
    const mtpStatus: MtpStatus = !opts.mtp ? "off" : !eligible ? "ineligible" : mtp ? "on" : "no-layer";
    const messages: Record<MtpStatus, string> = {
      off: "",
      ineligible: "no multi-token prediction: not every layer is on the GPU, or the GPU has too little memory",
      "no-layer": "no multi-token prediction: the model has no MTP layer, or its context could not be created",
      on: `multi-token prediction: ${MTP_DRAFT} draft tokens per step`,
    };
    if (mtpStatus !== "off") {
      console.error(`[engine] ${messages[mtpStatus]}`);
    }
    return new Model({
      lib,
      model,
      ctx,
      emptyThink: templateText.includes("enable_thinking"),
      onGpu: opts.gpuLayers !== 0,
      threads: opts.threads,
      mmproj: opts.mmproj,
      mtp,
    });
  }

  /** Tokens of the whole prompt for a user message with this content. Special tokens written out in the content are plain text. */
  tokenize(content: string): Int32Array {
    const encoder = new TextEncoder();
    const out: number[] = [];
    // Only the template's pieces (head, tail) parse special tokens; the vocabulary's BOS, if any, goes first.
    for (const [i, piece] of chatPromptParts(content, this.emptyThink).entries()) {
      const text = encoder.encode(piece);
      if (text.length === 0) {
        continue;
      }
      // A token covers at least one byte; the slack is for special tokens the vocabulary may add.
      const tokens = new Int32Array(text.length + 8);
      const n = this.lib.llama_tokenize(this.vocab, text, text.length, tokens, tokens.length, i === 0, i !== 1);
      if (n < 0) {
        throw new Error("llama_tokenize failed");
      }
      for (let k = 0; k < n; k++) {
        out.push(tokens[k]!);
      }
    }
    return Int32Array.from(out);
  }

  /**
   * The prompt for a user message of `content` followed by the image in `file` (a PNG; anything
   * else stb_image reads would do). The image is decoded and scaled to what the encoder takes here;
   * encoding it is left to `evalChunk`. The first call loads the encoder. Throws ImageError when the
   * file is not an image or the model takes none.
   */
  imagePrompt(content: string, file: Uint8Array): ImagePrompt {
    if (!this.mmproj) {
      throw new ImageError("this model does not take images");
    }
    if (!this.vision) {
      const vision = this.lib.shim_mtmd_load(cstr(this.mmproj), this.model, this.onGpu, this.threads);
      if (!vision) {
        throw new Error(`llama.cpp could not load the image encoder ${this.mmproj}`);
      }
      this.vision = vision;
    }
    const bitmap = this.lib.shim_mtmd_bitmap(file, file.length);
    if (!bitmap) {
      throw new ImageError("the image could not be decoded");
    }
    const [head, body, tail] = imagePromptParts(content, this.emptyThink).map((s) => new TextEncoder().encode(s)) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    const chunks = this.lib.shim_mtmd_tokenize(
      this.vision,
      head,
      head.length,
      body,
      body.length,
      bitmap,
      tail,
      tail.length,
    );
    // The chunks hold the preprocessed image; the decoded one is not needed again.
    this.lib.mtmd_bitmap_free(bitmap);
    if (!chunks) {
      throw new ImageError("the image could not be prepared for the model");
    }
    return new ImagePrompt(this.lib, chunks);
  }

  /**
   * Evaluates piece `index` of an image prompt after what the context already holds, starting with
   * 0 on an emptied context (`reset`). The image's piece runs the encoder and decodes its embeddings
   * in one blocking call.
   */
  evalChunk(prompt: ImagePrompt, index: number): void {
    this.posBuf[0] = this.pos;
    const status = this.lib.shim_mtmd_eval_chunk(this.vision!, this.ctx, prompt.handle, index, BATCH_SIZE, this.posBuf);
    if (status !== 0) {
      throw new Error(`evaluating the image prompt failed with status ${status}`);
    }
    this.pos = this.posBuf[0]!;
    this.prompt = "image";
  }

  /** Empties the context so the next prompt starts from position 0. */
  reset(): void {
    this.lib.llama_memory_clear(this.lib.llama_get_memory(this.ctx), true);
    if (this.mtp) {
      this.lib.shim_mtp_reset(this.mtp);
    }
    this.pos = 0;
    this.prompt = "text";
  }

  /** Evaluates up to `promptStep` tokens after what the context already holds. */
  decode(tokens: Int32Array): void {
    let status = this.lib.shim_decode_at(this.ctx, tokens, tokens.length, this.pos);
    // The MTP layer reads what the model computed for each token, so it follows every text decode.
    if (status === 0 && this.mtp && this.prompt === "text") {
      status = this.lib.shim_mtp_catch_up(this.mtp, tokens, tokens.length, this.pos);
    }
    if (status !== 0) {
      throw new Error(`llama_decode failed with status ${status}`);
    }
    this.pos += tokens.length;
  }

  /**
   * Decodes `token`, the last one chosen, and answers the most likely tokens after it: one, or with multi-token
   * prediction after a text prompt up to MTP_DRAFT + 1, the same the model would choose one at a time. At most
   * `most` (at least 1).
   */
  next(token: number, most: number): Int32Array {
    if (!this.mtp || this.prompt === "image") {
      this.one[0] = token;
      this.decode(this.one);
      return Int32Array.of(this.sample());
    }
    const draft = Math.max(0, Math.min(MTP_DRAFT, most - 1));
    const n = this.lib.shim_mtp_step(this.mtp, this.sampler, token, this.pos, draft, this.chosen);
    if (n < 1) {
      throw new Error("decoding with multi-token prediction failed");
    }
    this.pos += n;
    return this.chosen.slice(0, n);
  }

  /** The most likely next token after the last decode. */
  sample(): number {
    return this.lib.llama_sampler_sample(this.sampler, this.ctx, -1);
  }

  /** True for end-of-turn and end-of-text tokens. */
  isEnd(token: number): boolean {
    return this.lib.llama_vocab_is_eog(this.vocab, token);
  }

  /** The token's UTF-8 bytes, which may end inside a character. Control tokens render as nothing. */
  piece(token: number): Uint8Array {
    let n = this.lib.llama_token_to_piece(this.vocab, token, this.pieceBuf, this.pieceBuf.length, 0, false);
    if (n < 0) {
      this.pieceBuf = new Uint8Array(-n);
      n = this.lib.llama_token_to_piece(this.vocab, token, this.pieceBuf, this.pieceBuf.length, 0, false);
    }
    return this.pieceBuf.slice(0, Math.max(n, 0));
  }

  free(): void {
    if (this.freed) {
      return;
    }
    this.freed = true;
    this.lib.llama_sampler_free(this.sampler);
    if (this.vision) {
      this.lib.mtmd_free(this.vision);
    }
    if (this.mtp) {
      this.lib.shim_mtp_free(this.mtp);
    }
    this.lib.llama_free(this.ctx);
    this.lib.llama_model_free(this.model);
  }
}
