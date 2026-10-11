// libaudiocpp (audio.cpp's C API, include/audiocpp.h) through bun:ffi: the synchronous calls the
// speech worker needs to load a text-to-speech model and synthesize with it. Every call here
// blocks its thread, so this module is only used from src/speech-worker.ts.
//
// The library must be the build of scripts/build_audiocpp.ts, which has its own ggml linked in and
// hidden. audio.cpp's ggml is a fork with the same library name as llama.cpp's; a libaudiocpp that
// looked for a shared libggml would be handed the one libllama has loaded, and fail.

import { CString, dlopen, type Pointer, ptr, suffix, toArrayBuffer } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Pcm } from "./wav";

/** The major version of the C API these declarations were written against (`audiocpp.h`, 0.2). */
const ABI_MAJOR = 0;

const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");

export const libraryPath = (dir: string) =>
  join(dir, process.platform === "win32" ? `audiocpp.${suffix}` : `libaudiocpp.${suffix}`);

function bind(dir: string) {
  const libPath = libraryPath(dir);
  if (!existsSync(libPath)) throw new Error(`libaudiocpp not found in ${dir}; run: bun scripts/build_audiocpp.ts`);
  const lib = dlopen(libPath, {
    audiocpp_abi_version: { args: [], returns: "u32" },
    audiocpp_build_version: { args: [], returns: "ptr" },
    audiocpp_last_error: { args: [], returns: "ptr" },
    audiocpp_registry_create: { args: ["ptr", "ptr"], returns: "i32" },
    audiocpp_registry_free: { args: ["ptr"], returns: "void" },
    audiocpp_model_load: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    audiocpp_model_free: { args: ["ptr"], returns: "void" },
    audiocpp_session_create: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    audiocpp_session_free: { args: ["ptr"], returns: "void" },
    audiocpp_session_run: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    audiocpp_request_create: { args: [], returns: "ptr" },
    audiocpp_request_free: { args: ["ptr"], returns: "void" },
    audiocpp_request_set_text: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    audiocpp_request_set_voice_audio: { args: ["ptr", "ptr", "usize", "i32", "i32"], returns: "i32" },
    audiocpp_request_set_option: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    audiocpp_result_free: { args: ["ptr"], returns: "void" },
    audiocpp_result_audio: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  }).symbols;
  const abi = lib.audiocpp_abi_version();
  if (abi >> 16 !== ABI_MAJOR) {
    throw new Error(`libaudiocpp in ${dir} has C API version ${abi >> 16}.${(abi >> 8) & 0xff}, not ${ABI_MAJOR}.x`);
  }
  return lib;
}

type Lib = ReturnType<typeof bind>;

let lib: Lib | undefined;
let libDir = "";

/** Opens the library in `dir`, once per process. */
function open(dir: string): Lib {
  if (lib && libDir !== dir) throw new Error(`libaudiocpp is already loaded from ${libDir}`);
  lib ??= bind(dir);
  libDir = dir;
  return lib;
}

/** The C API version and audio.cpp's own version of the library in `dir`. */
export function libraryVersion(dir: string): { abi: string; build: string } {
  const lib = open(dir);
  const abi = lib.audiocpp_abi_version();
  const build = lib.audiocpp_build_version();
  return { abi: `${abi >> 16}.${(abi >> 8) & 0xff}.${abi & 0xff}`, build: build ? new CString(build).toString() : "" };
}

/** Status codes are `audiocpp_status`; anything but 0 leaves its detail in `audiocpp_last_error()`. */
function check(lib: Lib, status: number, what: string): void {
  if (status === 0) return;
  const detail = lib.audiocpp_last_error();
  throw new Error((detail ? new CString(detail).toString() : "") || `${what} failed with status ${status}`);
}

/**
 * A zeroed C struct of `size` bytes whose first field is a `const char *` to `text`. The string
 * follows the struct in the same buffer, so it lives as long as the struct does.
 */
function structWithString(text: string, size: number): Buffer {
  const bytes = cstr(text);
  const struct = Buffer.alloc(size + bytes.length);
  bytes.copy(struct, size);
  struct.writeBigUInt64LE(BigInt(ptr(struct)) + BigInt(size), 0);
  return struct;
}

/** The handle a call wrote to its out parameter. */
const handle = (out: BigUint64Array) => Number(out[0]) as Pointer;

export interface SpeechModelOptions {
  /** Directory with libaudiocpp. */
  dir: string;
  /** Directory with the model's GGUF. */
  modelPath: string;
  /** audio.cpp's name for the model family, e.g. `index_tts2`. */
  family: string;
  /** `vulkan` or `cpu`. */
  backend: string;
  threads: number;
}

/** One text-to-speech model with one session. Not thread-safe; `free()` must be called to release its memory. */
export class SpeechModel {
  private freed = false;

  private constructor(
    private lib: Lib,
    private registry: Pointer,
    private model: Pointer,
    private session: Pointer,
  ) {}

  static load(opts: SpeechModelOptions): SpeechModel {
    const lib = open(opts.dir);
    const out = new BigUint64Array(1);
    check(lib, lib.audiocpp_registry_create(null, out), "audiocpp_registry_create");
    const registry = handle(out);
    let model: Pointer | null = null;
    try {
      // struct audiocpp_model_config { const char * family_hint, * config_id, * weight_id, * model_spec_override; }
      const config = structWithString(opts.family, 32);
      check(lib, lib.audiocpp_model_load(registry, cstr(opts.modelPath), config, null, out), "audiocpp_model_load");
      model = handle(out);

      // struct audiocpp_backend_config { const char * backend; int device; int threads; }
      const backend = structWithString(opts.backend, 16);
      backend.writeInt32LE(0, 8);
      backend.writeInt32LE(opts.threads, 12);
      check(
        lib,
        lib.audiocpp_session_create(model, cstr("tts"), cstr("offline"), backend, null, out),
        "audiocpp_session_create",
      );
      return new SpeechModel(lib, registry, model, handle(out));
    } catch (e) {
      lib.audiocpp_model_free(model);
      lib.audiocpp_registry_free(registry);
      throw e;
    }
  }

  /**
   * One utterance in the voice of the recording `voice`. `options` are the family's request options
   * (`--request-option` of audiocpp_cli). Blocks until the whole utterance is synthesized; the
   * library has no way to stop one.
   */
  synthesize(text: string, lang: string, voice: Pcm, options: Record<string, string>): Pcm {
    const lib = this.lib;
    const out = new BigUint64Array(1);
    const request = lib.audiocpp_request_create();
    if (!request) throw new Error("audio.cpp could not create a request (out of memory?)");
    try {
      check(lib, lib.audiocpp_request_set_text(request, cstr(text), cstr(lang)), "audiocpp_request_set_text");
      const frames = voice.samples.length / voice.channels;
      check(
        lib,
        lib.audiocpp_request_set_voice_audio(request, voice.samples, frames, voice.sampleRate, voice.channels),
        "audiocpp_request_set_voice_audio",
      );
      for (const [key, value] of Object.entries(options)) {
        check(lib, lib.audiocpp_request_set_option(request, cstr(key), cstr(value)), "audiocpp_request_set_option");
      }
      check(lib, lib.audiocpp_session_run(this.session, request, out), "audiocpp_session_run");
    } finally {
      lib.audiocpp_request_free(request);
    }

    const result = handle(out);
    try {
      const samples = new BigUint64Array(1);
      const frames = new BigUint64Array(1);
      const sampleRate = new Int32Array(1);
      const channels = new Int32Array(1);
      check(lib, lib.audiocpp_result_audio(result, samples, frames, sampleRate, channels), "audiocpp_result_audio");
      const count = Number(frames[0]) * channels[0]!;
      if (count < 1) throw new Error("audio.cpp returned no audio");
      // Borrowed until the result is freed, so it is copied.
      const borrowed = new Float32Array(toArrayBuffer(handle(samples), 0, count * 4));
      return { samples: borrowed.slice(), sampleRate: sampleRate[0]!, channels: channels[0]! };
    } finally {
      lib.audiocpp_result_free(result);
    }
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.lib.audiocpp_session_free(this.session);
    this.lib.audiocpp_model_free(this.model);
    this.lib.audiocpp_registry_free(this.registry);
  }
}
