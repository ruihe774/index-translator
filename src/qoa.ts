// TypeScript glue for the WebAssembly QOA codec (src/qoa.wat).
//
// Runtime-agnostic: only uses the WebAssembly JS API and standard ECMAScript,
// so it runs in browsers, workers, Node, Deno and Bun. The wasm binaries are
// embedded (base64) by scripts/build.ts, or can be supplied by the caller.

import { QOA_WASM_RELAXED, QOA_WASM_SIMD } from "./qoa_wasm.ts";

/** Samples per channel in a full frame (256 slices x 20 samples). */
export const QOA_FRAME_LEN = 5120;
/** Samples per channel in a slice. */
export const QOA_SLICE_LEN = 20;
export const QOA_MAX_CHANNELS = 31;
export const QOA_MAX_SAMPLERATE = 0xffffff;

/** Decoded PCM audio. `samples` is interleaved int16, `samples.length / channels` per channel. */
export interface QoaAudio {
  channels: number;
  sampleRate: number;
  samples: Int16Array;
}

export interface QoaEncodeOptions {
  /** Write 0 as the total sample count, marking the file as a stream. */
  streaming?: boolean;
}

/** Error thrown for invalid arguments or malformed QOA data. */
export class QoaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QoaError";
  }
}

interface QoaExports {
  memory: WebAssembly.Memory;
  heap_base: WebAssembly.Global;
  encoder_state: WebAssembly.Global;
  encoder_state_size: WebAssembly.Global;
  frame_channels: WebAssembly.Global;
  frame_samplerate: WebAssembly.Global;
  frame_samples: WebAssembly.Global;
  encode_init(channels: number): void;
  encode_frame(src: number, channels: number, sampleRate: number, frameLen: number, dst: number): number;
  decode_frame(src: number, avail: number, dst: number): number;
}

/** Which wasm build a {@link Qoa} instance runs. */
export type QoaBackend = "relaxed-simd" | "simd" | "custom";

export type QoaSource = BufferSource | WebAssembly.Module;

const DECODE_ERRORS: Record<number, string> = {
  [-1]: "truncated frame header",
  [-2]: "invalid frame header",
  [-3]: "frame size does not match frame header",
  [-4]: "truncated frame",
};

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (fromBase64) return fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let builtin: { bytes: Uint8Array<ArrayBuffer>; backend: QoaBackend } | undefined;

function builtinBinary(): { bytes: Uint8Array<ArrayBuffer>; backend: QoaBackend } {
  if (!builtin) {
    const relaxed = base64ToBytes(QOA_WASM_RELAXED);
    if (WebAssembly.validate(relaxed)) {
      builtin = { bytes: relaxed, backend: "relaxed-simd" };
    } else {
      const simd = base64ToBytes(QOA_WASM_SIMD);
      if (!WebAssembly.validate(simd)) throw new QoaError("this WebAssembly engine does not support SIMD");
      builtin = { bytes: simd, backend: "simd" };
    }
  }
  return builtin;
}

function frameCount(samples: number): number {
  return Math.ceil(samples / QOA_FRAME_LEN);
}

/** Exact size in bytes of a QOA file holding `samples` samples per channel. */
export function qoaEncodedSize(samples: number, channels: number): number {
  const frames = frameCount(samples);
  const slices = Math.ceil(samples / QOA_SLICE_LEN); // the last frame's partial slice is counted once
  return 8 + frames * (8 + 16 * channels) + slices * channels * 8;
}

function checkFormat(channels: number, sampleRate: number): void {
  if (!Number.isInteger(channels) || channels < 1 || channels > QOA_MAX_CHANNELS)
    throw new QoaError(`channels must be an integer in 1..${QOA_MAX_CHANNELS}`);
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > QOA_MAX_SAMPLERATE)
    throw new QoaError(`sampleRate must be an integer in 1..${QOA_MAX_SAMPLERATE}`);
}

/** A QOA frame as returned by {@link Qoa.decodeFrames}. */
export interface QoaFrame extends QoaAudio {
  /** Byte offset of the frame in the input. */
  offset: number;
}

interface FrameInfo {
  offset: number;
  channels: number;
  sampleRate: number;
  samples: number;
  size: number;
}

/**
 * A QOA codec instance. Each instance owns one wasm instance (and its
 * memory); it is not reentrant but instances are cheap.
 */
export class Qoa {
  readonly backend: QoaBackend;
  #ex: QoaExports;
  #heap: number;

  private constructor(instance: WebAssembly.Instance, backend: QoaBackend) {
    this.#ex = instance.exports as unknown as QoaExports;
    this.#heap = this.#ex.heap_base.value as number;
    this.backend = backend;
  }

  /**
   * Instantiate the codec. Without `source` the embedded binary is used
   * (relaxed SIMD if the engine supports it, plain SIMD otherwise).
   */
  static async create(source?: QoaSource): Promise<Qoa> {
    if (source instanceof WebAssembly.Module) return new Qoa(await WebAssembly.instantiate(source), "custom");
    if (source) return new Qoa((await WebAssembly.instantiate(source)).instance, "custom");
    const { bytes, backend } = builtinBinary();
    return new Qoa((await WebAssembly.instantiate(bytes)).instance, backend);
  }

  /**
   * Synchronous variant of {@link Qoa.create}. Note that some browsers refuse
   * to compile wasm synchronously on the main thread.
   */
  static createSync(source?: QoaSource): Qoa {
    if (source instanceof WebAssembly.Module) return new Qoa(new WebAssembly.Instance(source), "custom");
    if (source) return new Qoa(new WebAssembly.Instance(new WebAssembly.Module(source)), "custom");
    const { bytes, backend } = builtinBinary();
    return new Qoa(new WebAssembly.Instance(new WebAssembly.Module(bytes)), backend);
  }

  /** Make room for `bytes` bytes at the heap base. */
  #reserve(bytes: number): void {
    const mem = this.#ex.memory;
    const need = this.#heap + bytes;
    if (need > 0xffffffff) throw new QoaError("input too large for 32-bit wasm memory");
    if (need > mem.buffer.byteLength) mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
  }

  /**
   * Encode interleaved int16 PCM into a complete QOA file.
   * @param samples interleaved samples, `samples.length / channels` per channel
   */
  encode(samples: Int16Array, channels: number, sampleRate: number, options: QoaEncodeOptions = {}): Uint8Array {
    checkFormat(channels, sampleRate);
    if (samples.length % channels !== 0) throw new QoaError("samples.length must be a multiple of channels");
    const n = samples.length / channels;
    if (n < 1) throw new QoaError("QOA requires at least one sample");
    if (n > 0xffffffff) throw new QoaError("too many samples for a QOA file");

    return this.#encodeFrames(samples, channels, sampleRate, null, options.streaming ? 0 : n);
  }

  /** Create an incremental encoder producing a streaming QOA file. */
  createEncoder(channels: number, sampleRate: number): QoaStreamEncoder {
    return new QoaStreamEncoder(this, channels, sampleRate);
  }

  /**
   * Encode `samples` (n >= 1 per channel) as frames. `state` holds the encoder
   * state to continue from (null: fresh state) and receives the final state.
   * With `header` set, a file header announcing that many samples is prepended.
   */
  #encodeFrames(samples: Int16Array, channels: number, sampleRate: number,
                state: Uint8Array | null, header?: number): Uint8Array {
    const ex = this.#ex;
    const n = samples.length / channels;
    const inBytes = samples.length * 2;
    const src = this.#heap;
    const dst = src + ((inBytes + 15) & ~15);
    this.#reserve(dst - src + qoaEncodedSize(n, channels));
    const buf = ex.memory.buffer;
    new Int16Array(buf, src, samples.length).set(samples);
    const stateAt = ex.encoder_state.value as number;
    const stateSize = ex.encoder_state_size.value as number;
    if (state) new Uint8Array(buf, stateAt, stateSize).set(state);
    else ex.encode_init(channels);
    let o = dst;
    if (header !== undefined) {
      const view = new DataView(buf, dst, 8);
      view.setUint32(0, 0x716f6166); // "qoaf"
      view.setUint32(4, header);
      o += 8;
    }
    for (let pos = 0; pos < n; pos += QOA_FRAME_LEN) {
      const flen = Math.min(QOA_FRAME_LEN, n - pos);
      o += ex.encode_frame(src + pos * channels * 2, channels, sampleRate, flen, o);
    }
    if (state) state.set(new Uint8Array(buf, stateAt, stateSize));
    return new Uint8Array(buf, dst, o - dst).slice();
  }

  /** @internal */
  _encodeStream(samples: Int16Array, channels: number, sampleRate: number, state: Uint8Array): Uint8Array {
    return this.#encodeFrames(samples, channels, sampleRate, state);
  }

  /** @internal */
  _newEncoderState(channels: number): Uint8Array {
    const ex = this.#ex;
    ex.encode_init(channels);
    const at = ex.encoder_state.value as number;
    return new Uint8Array(ex.memory.buffer, at, ex.encoder_state_size.value as number).slice();
  }

  /** Parse the file header and frame headers without decoding. */
  static probe(data: Uint8Array): { samples: number; frames: FrameInfo[] } {
    if (data.length < 8) throw new QoaError("not a QOA file: too short");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0) !== 0x716f6166) throw new QoaError("not a QOA file: bad magic");
    const samples = view.getUint32(4);
    const frames: FrameInfo[] = [];
    let offset = 8;
    while (offset < data.length) {
      if (data.length - offset < 8) throw new QoaError(`${DECODE_ERRORS[-1]} at byte ${offset}`);
      const channels = view.getUint8(offset);
      const sampleRate = view.getUint32(offset) & 0xffffff;
      const fsamples = view.getUint16(offset + 4);
      const size = view.getUint16(offset + 6);
      if (channels === 0 || sampleRate === 0 || fsamples === 0 || fsamples > QOA_FRAME_LEN)
        throw new QoaError(`${DECODE_ERRORS[-2]} at byte ${offset}`);
      if (size !== 8 + 16 * channels + Math.ceil(fsamples / QOA_SLICE_LEN) * channels * 8)
        throw new QoaError(`${DECODE_ERRORS[-3]} at byte ${offset}`);
      if (size > data.length - offset) throw new QoaError(`${DECODE_ERRORS[-4]} at byte ${offset}`);
      frames.push({ offset, channels, sampleRate, samples: fsamples, size });
      offset += size;
    }
    if (frames.length === 0) throw new QoaError("QOA file contains no frames");
    return { samples, frames };
  }

  #decodeInto(data: Uint8Array, frames: FrameInfo[], outBytes: number, each?: (f: FrameInfo, ptr: number) => void): number {
    const src = this.#heap;
    const dst = src + ((data.length + 15) & ~15);
    this.#reserve(dst - src + outBytes);
    const ex = this.#ex;
    new Uint8Array(ex.memory.buffer, src, data.length).set(data);
    let o = dst;
    for (const f of frames) {
      const r = ex.decode_frame(src + f.offset, data.length - f.offset, o);
      if (r < 0) throw new QoaError(`${DECODE_ERRORS[r] ?? "decode error"} at byte ${f.offset}`);
      each?.(f, o);
      o += f.samples * f.channels * 2;
    }
    return dst;
  }

  /**
   * Decode a complete QOA file. All frames must share the same channel count
   * and samplerate (always true for static files); use
   * {@link Qoa.decodeFrames} for streams whose format changes.
   */
  decode(data: Uint8Array): QoaAudio {
    const { samples, frames } = Qoa.probe(data);
    const { channels, sampleRate } = frames[0];
    let total = 0;
    for (const f of frames) {
      if (f.channels !== channels || f.sampleRate !== sampleRate)
        throw new QoaError("channel count or samplerate changes between frames; use decodeFrames()");
      total += f.samples;
    }
    if (samples !== 0 && samples !== total)
      throw new QoaError(`file header announces ${samples} samples but frames contain ${total}`);
    const dst = this.#decodeInto(data, frames, total * channels * 2);
    return { channels, sampleRate, samples: new Int16Array(this.#ex.memory.buffer, dst, total * channels).slice() };
  }

  /** Decode a QOA file frame by frame, preserving per-frame format changes. */
  decodeFrames(data: Uint8Array): QoaFrame[] {
    const { frames } = Qoa.probe(data);
    let outBytes = 0;
    for (const f of frames) outBytes += f.samples * f.channels * 2;
    const out: QoaFrame[] = [];
    this.#decodeInto(data, frames, outBytes, (f, ptr) => {
      out.push({
        offset: f.offset,
        channels: f.channels,
        sampleRate: f.sampleRate,
        samples: new Int16Array(this.#ex.memory.buffer, ptr, f.samples * f.channels).slice(),
      });
    });
    return out;
  }
}

/**
 * Incremental encoder. Feed interleaved samples with {@link write}; each call
 * returns the bytes that are ready (the file header and any complete frames).
 * {@link end} flushes the final partial frame. The concatenated output is a
 * streaming QOA file (sample count 0 in the header).
 */
export class QoaStreamEncoder {
  readonly channels: number;
  readonly sampleRate: number;
  #qoa: Qoa;
  #pending: Int16Array;
  #pendingLen = 0;
  #started = false;
  #ended = false;
  #wroteFrame = false;
  #state: Uint8Array;

  constructor(qoa: Qoa, channels: number, sampleRate: number) {
    checkFormat(channels, sampleRate);
    this.#qoa = qoa;
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.#pending = new Int16Array(QOA_FRAME_LEN * channels);
    this.#state = qoa._newEncoderState(channels);
  }

  write(samples: Int16Array): Uint8Array {
    if (this.#ended) throw new QoaError("encoder already ended");
    if (samples.length % this.channels !== 0) throw new QoaError("samples.length must be a multiple of channels");
    const chunks: Uint8Array[] = [];
    if (!this.#started) {
      this.#started = true;
      chunks.push(new Uint8Array([0x71, 0x6f, 0x61, 0x66, 0, 0, 0, 0]));
    }
    const frameSamples = this.#pending.length;
    let pos = 0;
    // top up a partially filled frame first
    if (this.#pendingLen > 0) {
      const take = Math.min(frameSamples - this.#pendingLen, samples.length);
      this.#pending.set(samples.subarray(0, take), this.#pendingLen);
      this.#pendingLen += take;
      pos = take;
      if (this.#pendingLen === frameSamples) {
        chunks.push(this.#frames(this.#pending));
        this.#pendingLen = 0;
      }
    }
    // then encode all whole frames straight from the input
    const whole = Math.floor((samples.length - pos) / frameSamples) * frameSamples;
    if (whole > 0) {
      chunks.push(this.#frames(samples.subarray(pos, pos + whole)));
      pos += whole;
    }
    if (pos < samples.length) {
      this.#pending.set(samples.subarray(pos), this.#pendingLen);
      this.#pendingLen += samples.length - pos;
    }
    return concat(chunks);
  }

  end(): Uint8Array {
    if (this.#ended) throw new QoaError("encoder already ended");
    const chunks: Uint8Array[] = [];
    if (!this.#started) chunks.push(this.write(new Int16Array(0)));
    if (this.#pendingLen > 0) chunks.push(this.#frames(this.#pending.subarray(0, this.#pendingLen)));
    if (!this.#wroteFrame) throw new QoaError("QOA requires at least one sample");
    this.#ended = true;
    return concat(chunks);
  }

  #frames(samples: Int16Array): Uint8Array {
    const out = this.#qoa._encodeStream(samples, this.channels, this.sampleRate, this.#state);
    this.#wroteFrame = true;
    return out;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  n = 0;
  for (const c of chunks) {
    out.set(c, n);
    n += c.length;
  }
  return out;
}
