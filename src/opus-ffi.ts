// libopus (include/opus.h) through bun:ffi: the encoder of the speech stream (src/opus-stream.ts) and the
// decoder of uploaded Ogg Opus recordings (src/opus-file.ts), which the tests also read that stream back with.
// The library is the build of scripts/build_libopus.ts, beside the engine directory, opened by its full path so
// an Opus installed on the system is never used. The encoder and a voice sample's decoder run on the main
// thread (encoding a minute of speech takes about a tenth of a second); a recording to transcribe, up to 30
// minutes, is decoded on the speech worker.

import { CString, dlopen } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { libraryFile, once } from "./ffi-util";

/** Where scripts/build_libopus.ts puts libopus, beside the engine directory `audioDir`. */
export const opusDir = (audioDir: string) => join(audioDir, "..", "opus");

/** The library's SONAME on Linux, `opus.dll` on Windows. */
export const opusLibraryPath = (dir: string) => libraryFile(dir, "opus", 0);

// opus_defines.h
const OPUS_SET_BITRATE_REQUEST = 4002;
const OPUS_SET_BANDWIDTH_REQUEST = 4008;
const OPUS_SET_COMPLEXITY_REQUEST = 4010;
const OPUS_GET_LOOKAHEAD_REQUEST = 4027;
/** CELT only (libopus 1.6): no SILK or hybrid frames whatever the bitrate or complexity, and no SILK state. */
const OPUS_APPLICATION_RESTRICTED_CELT = 2053;

/**
 * The largest packet `opus_encode_float` is given room for: libopus's own recommendation (opus.h), far above
 * what one 20 ms frame at the speech stream's bitrate takes.
 */
const MAX_PACKET = 4000;
/** The longest frame a packet can hold: 120 ms at 48 kHz. */
const MAX_FRAME = 5760;

function bind(dir: string) {
  const path = opusLibraryPath(dir);
  if (!existsSync(path)) {
    throw new Error(`libopus not found in ${dir}; run: bun scripts/build_libopus.ts`);
  }
  const lib = dlopen(path, {
    opus_get_version_string: { args: [], returns: "ptr" },
    opus_strerror: { args: ["i32"], returns: "ptr" },
    opus_encoder_create: { args: ["i32", "i32", "i32", "ptr"], returns: "ptr" },
    opus_encoder_ctl: { args: ["ptr", "i32", "i32"], returns: "i32" },
    opus_encode_float: { args: ["ptr", "ptr", "i32", "ptr", "i32"], returns: "i32" },
    opus_encoder_destroy: { args: ["ptr"], returns: "void" },
    opus_decoder_create: { args: ["i32", "i32", "ptr"], returns: "ptr" },
    opus_decode_float: { args: ["ptr", "ptr", "i32", "ptr", "i32", "i32"], returns: "i32" },
    opus_decoder_destroy: { args: ["ptr"], returns: "void" },
  });
  // opus_encoder_ctl is variadic, which bun:ffi does not declare. Its one extra argument is an int or a pointer,
  // and on x86-64 (System V and Windows) and on Linux's aarch64 a variadic argument of either is passed where a
  // fixed one would be, so the same function is bound once for each: above with an int, here with a pointer
  // (a second handle of the library, which the loader counts and does not load again).
  const out = dlopen(path, { opus_encoder_ctl: { args: ["ptr", "i32", "ptr"], returns: "i32" } });
  return { ...lib.symbols, opus_encoder_ctl_out: out.symbols.opus_encoder_ctl };
}

type Lib = ReturnType<typeof bind>;
type Encoder = NonNullable<ReturnType<Lib["opus_encoder_create"]>>;
type Decoder = NonNullable<ReturnType<Lib["opus_decoder_create"]>>;

const library = once("libopus", bind);

function check(lib: Lib, what: string, status: number): number {
  if (status < 0) {
    const message = lib.opus_strerror(status);
    throw new Error(`${what}: ${message ? new CString(message) : status}`);
  }
  return status;
}

/** The version of the libopus in `dir`, as the library names itself (`libopus 1.6.1`). */
export function opusVersion(dir: string): string {
  const version = library.open(dir).opus_get_version_string();
  return version ? new CString(version) : "";
}

export interface OpusEncoderOptions {
  sampleRate: 8000 | 12_000 | 16_000 | 24_000 | 48_000;
  channels: 1 | 2;
  bitrate: number;
  complexity: number;
  /** An `OPUS_BANDWIDTH_*`: the widest band coded. */
  bandwidth: number;
}

/** One libopus encoder; `destroy` frees it, and the encoder cannot be used after. */
export class OpusEncoder {
  /** The samples the encoder delays its output by, which a decoder drops (Ogg's pre-skip). */
  readonly lookahead: number;
  private readonly lib: Lib;
  private encoder: Encoder | null;
  private readonly packet = new Uint8Array(MAX_PACKET);
  private readonly channels: number;

  constructor(dir: string, options: OpusEncoderOptions) {
    const lib = library.open(dir);
    this.lib = lib;
    this.channels = options.channels;
    const error = new Int32Array(1);
    this.encoder = lib.opus_encoder_create(
      options.sampleRate,
      options.channels,
      OPUS_APPLICATION_RESTRICTED_CELT,
      error,
    );
    check(lib, "opus_encoder_create", error[0]!);
    if (!this.encoder) {
      throw new Error("opus_encoder_create returned no encoder");
    }
    try {
      this.set(OPUS_SET_BITRATE_REQUEST, options.bitrate);
      this.set(OPUS_SET_COMPLEXITY_REQUEST, options.complexity);
      this.set(OPUS_SET_BANDWIDTH_REQUEST, options.bandwidth);
      const lookahead = new Int32Array(1);
      check(lib, "OPUS_GET_LOOKAHEAD", lib.opus_encoder_ctl_out(this.encoder, OPUS_GET_LOOKAHEAD_REQUEST, lookahead));
      this.lookahead = lookahead[0]!;
    } catch (e) {
      this.destroy();
      throw e;
    }
  }

  private live(): Encoder {
    if (!this.encoder) {
      throw new Error("the Opus encoder was destroyed");
    }
    return this.encoder;
  }

  private set(request: number, value: number): void {
    check(this.lib, `opus_encoder_ctl(${request})`, this.lib.opus_encoder_ctl(this.live(), request, value));
  }

  /** One packet of `frame`: interleaved samples in -1 to 1, a frame size Opus allows (2.5 to 120 ms). */
  encode(frame: Float32Array): Uint8Array {
    const samples = frame.length / this.channels;
    const length = check(
      this.lib,
      "opus_encode_float",
      this.lib.opus_encode_float(this.live(), frame, samples, this.packet, MAX_PACKET),
    );
    return this.packet.slice(0, length);
  }

  destroy(): void {
    if (this.encoder) {
      this.lib.opus_encoder_destroy(this.encoder);
      this.encoder = null;
    }
  }
}

/** One libopus decoder; `destroy` frees it, and the decoder cannot be used after. */
export class OpusDecoder {
  private readonly lib: Lib;
  private decoder: Decoder | null;
  private readonly channels: number;
  private readonly pcm: Float32Array;

  constructor(dir: string, sampleRate: OpusEncoderOptions["sampleRate"], channels: 1 | 2) {
    const lib = library.open(dir);
    this.lib = lib;
    this.channels = channels;
    this.pcm = new Float32Array(MAX_FRAME * channels);
    const error = new Int32Array(1);
    this.decoder = lib.opus_decoder_create(sampleRate, channels, error);
    check(lib, "opus_decoder_create", error[0]!);
    if (!this.decoder) {
      throw new Error("opus_decoder_create returned no decoder");
    }
  }

  /** The interleaved samples of one packet. */
  decode(packet: Uint8Array): Float32Array {
    if (!this.decoder) {
      throw new Error("the Opus decoder was destroyed");
    }
    const samples = check(
      this.lib,
      "opus_decode_float",
      this.lib.opus_decode_float(this.decoder, packet, packet.length, this.pcm, MAX_FRAME, 0),
    );
    return this.pcm.slice(0, samples * this.channels);
  }

  destroy(): void {
    if (this.decoder) {
      this.lib.opus_decoder_destroy(this.decoder);
      this.decoder = null;
    }
  }
}
