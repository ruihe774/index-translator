// libaudiocpp (audio.cpp's C API, include/audiocpp.h) through bun:ffi: the synchronous calls the
// speech worker needs to load a text-to-speech model and synthesize with it, or to load a source
// separation model and take the vocals out of a recording. Every call here blocks its thread, so
// this module is only used from src/speech-worker.ts.
//
// The library must be the build of scripts/build_audiocpp.ts, which has its own ggml linked in and
// hidden. audio.cpp's ggml is a fork with the same library name as llama.cpp's; a libaudiocpp that
// looked for a shared libggml would be handed the one libllama has loaded, and fail.

import { CString, dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { existsSync } from "node:fs";

import { cstr, libraryFile, once, pointerOf, slot, soxrDir, soxrLibraryPath } from "./ffi-util";
import type { Pcm } from "./wav";
import { isAborted } from "./worker-rpc";

/** The major version of the C API these declarations were written against (`audiocpp.h`, 0.2). */
const ABI_MAJOR = 0;

export const libraryPath = (dir: string) => libraryFile(dir, "audiocpp");

/**
 * audio.cpp resamples with libsoxr when it can open one by name, and otherwise with resamplers of
 * its own that sound different. Opening ours first by its full path makes that lookup find it: both
 * the dynamic loader of Linux (by SONAME) and Windows (by file name) hand a library that is already
 * loaded to a later request for its name, ahead of any other that is installed.
 */
function openSoxr(dir: string) {
  const path = soxrLibraryPath(dir);
  if (!existsSync(path)) {
    throw new Error(`libsoxr not found in ${dir}; run: bun scripts/build_soxr.ts`);
  }
  return dlopen(path, { soxr_version: { args: [], returns: "ptr" } }).symbols;
}

/** The version of the libsoxr in `dir`. */
export function soxrVersion(dir: string): string {
  const version = openSoxr(dir).soxr_version();
  return version ? new CString(version) : "";
}

/** Opens libsoxr, then libaudiocpp (see `openSoxr`), and checks the C API version. */
function bind(dir: string) {
  const libPath = libraryPath(dir);
  if (!existsSync(libPath)) {
    throw new Error(`libaudiocpp not found in ${dir}; run: bun scripts/build_audiocpp.ts`);
  }
  openSoxr(soxrDir(dir));
  const lib = dlopen(libPath, {
    audiocpp_abi_version: { args: [], returns: "u32" },
    audiocpp_build_version: { args: [], returns: "ptr" },
    audiocpp_last_error: { args: [], returns: "ptr" },
    // Ours, not upstream's: scripts/patches/audiocpp-abort.patch.
    audiocpp_set_abort_flag: { args: ["ptr"], returns: "void" },
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
    audiocpp_request_set_audio: { args: ["ptr", "ptr", "usize", "i32", "i32"], returns: "i32" },
    audiocpp_request_set_voice_audio: { args: ["ptr", "ptr", "usize", "i32", "i32"], returns: "i32" },
    audiocpp_request_set_option: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    audiocpp_result_free: { args: ["ptr"], returns: "void" },
    audiocpp_result_audio: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    audiocpp_result_named_audio_count: { args: ["ptr"], returns: "usize" },
    audiocpp_result_named_audio: { args: ["ptr", "usize", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  }).symbols;
  const abi = lib.audiocpp_abi_version();
  if (abi >> 16 !== ABI_MAJOR) {
    throw new Error(`libaudiocpp in ${dir} has C API version ${abi >> 16}.${(abi >> 8) & 0xff}, not ${ABI_MAJOR}.x`);
  }
  return lib;
}

type Lib = ReturnType<typeof bind>;

/** The library, opened once per process. */
const audiocpp = once("libaudiocpp", bind);

/** The C API version and audio.cpp's own version of the library in `dir`. */
export function libraryVersion(dir: string): { abi: string; build: string } {
  const lib = audiocpp.open(dir);
  const abi = lib.audiocpp_abi_version();
  const build = lib.audiocpp_build_version();
  return { abi: `${abi >> 16}.${(abi >> 8) & 0xff}.${abi & 0xff}`, build: build ? new CString(build) : "" };
}

/** Status codes are `audiocpp_status`; anything but 0 leaves its detail in `audiocpp_last_error()`. */
function check(lib: Lib, status: number, what: string): void {
  if (status === 0) {
    return;
  }
  const detail = lib.audiocpp_last_error();
  throw new Error((detail ? new CString(detail) : "") || `${what} failed with status ${status}`);
}

/**
 * A zeroed C struct of `size` bytes whose first field is a `const char *` to `text`. The string
 * follows the struct in the same buffer, so it lives as long as the struct does.
 */
function structWithString(text: string, size: number): Uint8Array {
  const bytes = cstr(text);
  const struct = new Uint8Array(size + bytes.length);
  struct.set(bytes, size);
  new DataView(struct.buffer).setBigUint64(0, BigInt(ptr(struct)) + BigInt(size), true);
  return struct;
}

/** Runs `fn` with a new request, which is freed afterwards. */
function withRequest<T>(lib: Lib, fn: (request: NonNullable<ReturnType<Lib["audiocpp_request_create"]>>) => T): T {
  const request = lib.audiocpp_request_create();
  if (!request) {
    throw new Error("audio.cpp could not create a request (out of memory?)");
  }
  try {
    return fn(request);
  } finally {
    lib.audiocpp_request_free(request);
  }
}

/** Runs `fn` with a result, which is freed afterwards: what `fn` borrows from it must be copied. */
function withResult<T>(lib: Lib, result: Pointer, fn: () => T): T {
  try {
    return fn();
  } finally {
    lib.audiocpp_result_free(result);
  }
}

/** The out parameters of `audiocpp_result_audio` and `audiocpp_result_named_audio`. */
function audioSlots() {
  const samples = slot();
  const frames = slot();
  const sampleRate = new Int32Array(1);
  const channels = new Int32Array(1);
  return {
    samples,
    frames,
    sampleRate,
    channels,
    /** The audio the library wrote to the slots, copied out of the result's memory; `empty` is the error for none. */
    read(empty: string): Pcm {
      const count = Number(frames[0]) * channels[0]!;
      if (count < 1) {
        throw new Error(empty);
      }
      const borrowed = new Float32Array(toArrayBuffer(pointerOf(samples), 0, count * 4));
      return { samples: borrowed.slice(), sampleRate: sampleRate[0]!, channels: channels[0]! };
    },
  };
}

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

/** A loaded model with an offline session for one task; the handles `free()` releases. */
class Loaded {
  private freed = false;

  protected constructor(
    protected lib: Lib,
    private readonly registry: Pointer,
    private readonly model: Pointer,
    protected session: Pointer,
  ) {}

  /** Loads the model and creates its session for `task` (`tts`, `sep`, ...). */
  protected static open(opts: SpeechModelOptions, task: string): [Lib, Pointer, Pointer, Pointer] {
    const lib = audiocpp.open(opts.dir);
    const out = slot();
    check(lib, lib.audiocpp_registry_create(null, out), "audiocpp_registry_create");
    const registry = pointerOf(out);
    // Each handle is freed only once it exists, newest first. audiocpp.h keeps parents alive
    // internally, so the order is a courtesy, and freeing NULL would be a no-op anyway.
    let model: Pointer | null = null;
    let session: Pointer | null = null;
    try {
      // struct audiocpp_model_config { const char * family_hint, * config_id, * weight_id, * model_spec_override; }
      const config = structWithString(opts.family, 32);
      check(lib, lib.audiocpp_model_load(registry, cstr(opts.modelPath), config, null, out), "audiocpp_model_load");
      model = pointerOf(out);

      // struct audiocpp_backend_config { const char * backend; int device; int threads; }
      const backend = structWithString(opts.backend, 16);
      const fields = new DataView(backend.buffer);
      fields.setInt32(8, 0, true);
      fields.setInt32(12, opts.threads, true);
      check(
        lib,
        lib.audiocpp_session_create(model, cstr(task), cstr("offline"), backend, null, out),
        "audiocpp_session_create",
      );
      session = pointerOf(out);
      return [lib, registry, model, session];
    } catch (e) {
      if (session) {
        lib.audiocpp_session_free(session);
      }
      if (model) {
        lib.audiocpp_model_free(model);
      }
      lib.audiocpp_registry_free(registry);
      throw e;
    }
  }

  free(): void {
    if (this.freed) {
      return;
    }
    this.freed = true;
    this.lib.audiocpp_session_free(this.session);
    this.lib.audiocpp_model_free(this.model);
    this.lib.audiocpp_registry_free(this.registry);
  }
}

/** The utterance was given up because its abort flag was raised. */
export class AbortedError extends Error {
  constructor() {
    super("the utterance was aborted");
  }
}

/** One text-to-speech model with one session. Not thread-safe; `free()` must be called to release its memory. */
export class SpeechModel extends Loaded {
  static load(opts: SpeechModelOptions): SpeechModel {
    return new SpeechModel(...Loaded.open(opts, "tts"));
  }

  /**
   * One utterance in the voice of the recording `voice`. `options` are the family's request options
   * (`--request-option` of audiocpp_cli). Blocks until the whole utterance is synthesized, or until
   * another thread makes `abort[0]` non-zero: the library looks at it before every step of the
   * model, gives up, and this throws `AbortedError`. The model can be used again at once.
   */
  synthesize(text: string, lang: string, voice: Pcm, options: Record<string, string>, abort?: Int32Array): Pcm {
    const { lib } = this;
    const result = withRequest(lib, (request) => {
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
      const out = slot();
      let status: number;
      try {
        if (abort) {
          lib.audiocpp_set_abort_flag(abort);
        }
        status = lib.audiocpp_session_run(this.session, request, out);
      } finally {
        // The library must not keep a pointer to memory that may be collected.
        lib.audiocpp_set_abort_flag(null);
      }
      // A run that failed while the flag was up is taken to have failed because of it.
      if (status !== 0 && abort && isAborted(abort)) {
        throw new AbortedError();
      }
      check(lib, status, "audiocpp_session_run");
      return pointerOf(out);
    });

    return withResult(lib, result, () => {
      const audio = audioSlots();
      check(
        lib,
        lib.audiocpp_result_audio(result, audio.samples, audio.frames, audio.sampleRate, audio.channels),
        "audiocpp_result_audio",
      );
      return audio.read("audio.cpp returned no audio");
    });
  }
}

/** A source separation model (BS-RoFormer) with one session. Same rules as `SpeechModel`. */
export class VoiceSeparator extends Loaded {
  static load(opts: SpeechModelOptions): VoiceSeparator {
    return new VoiceSeparator(...Loaded.open(opts, "sep"));
  }

  /**
   * The vocals of `mixture`, which must have the model's sample rate (44.1 kHz) and one or two
   * channels, with the model's channel count. Blocks until the whole recording is done.
   */
  vocals(mixture: Pcm): Pcm {
    const { lib } = this;
    const result = withRequest(lib, (request) => {
      const frames = mixture.samples.length / mixture.channels;
      check(
        lib,
        lib.audiocpp_request_set_audio(request, mixture.samples, frames, mixture.sampleRate, mixture.channels),
        "audiocpp_request_set_audio",
      );
      const out = slot();
      check(lib, lib.audiocpp_session_run(this.session, request, out), "audiocpp_session_run");
      return pointerOf(out);
    });

    return withResult(lib, result, () => {
      // The stems come as named audio: "vocals" and "instrumental" (the mixture minus the vocals).
      const count = Number(lib.audiocpp_result_named_audio_count(result));
      for (let i = 0; i < count; i++) {
        const id = slot();
        const audio = audioSlots();
        check(
          lib,
          lib.audiocpp_result_named_audio(result, i, id, audio.samples, audio.frames, audio.sampleRate, audio.channels),
          "audiocpp_result_named_audio",
        );
        if (new CString(pointerOf(id)) === "vocals") {
          return audio.read("audio.cpp returned no vocals");
        }
      }
      throw new Error("audio.cpp returned no vocals stem");
    });
  }
}
