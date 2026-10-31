// Decoded audio on its way to the server when a recording is re-encoded (transcode.ts): samples read
// from PCM bytes, channels mixed down, a streaming resampler, a WAV writer, and `PcmTimeline`, which puts
// each decoded chunk where its timestamp says. Pure (no DOM, no WebCodecs), so tested by bun test
// (test/pcm.test.ts).

/** Planar samples: one array per channel, all of one length. */
export type Planes = Float32Array<ArrayBuffer>[];

const HALF = Math.SQRT1_2;

/**
 * What each channel adds to (left, right), by channel count, in the order WAV, Chromium's decoders and
 * ffmpeg give: L R C LFE, then the surrounds (back before side in 7.1; 6.1 has one back centre). The
 * centre and the surrounds come in at -3 dB, the LFE not at all (ITU-R BS.775).
 */
const STEREO_MIX: Record<number, [number, number][]> = {
  3: [
    [1, 0],
    [0, 1],
    [HALF, HALF],
  ],
  4: [
    [1, 0],
    [0, 1],
    [HALF, 0],
    [0, HALF],
  ],
  5: [
    [1, 0],
    [0, 1],
    [HALF, HALF],
    [HALF, 0],
    [0, HALF],
  ],
  6: [
    [1, 0],
    [0, 1],
    [HALF, HALF],
    [0, 0],
    [HALF, 0],
    [0, HALF],
  ],
  7: [
    [1, 0],
    [0, 1],
    [HALF, HALF],
    [0, 0],
    [0.5, 0.5],
    [HALF, 0],
    [0, HALF],
  ],
  8: [
    [1, 0],
    [0, 1],
    [HALF, HALF],
    [0, 0],
    [HALF, 0],
    [0, HALF],
    [HALF, 0],
    [0, HALF],
  ],
};

/** The most channels `mixDownPlanes` mixes. */
export const MAX_CHANNELS = 8;

/**
 * `planes` as mono or stereo. Stereo from more channels by STEREO_MIX, scaled so that nothing clips;
 * mono is the mean of the channels (of the stereo mix, from more than two); mono to stereo copies.
 */
export function mixDownPlanes(planes: Planes, channels: 1 | 2): Planes {
  const n = planes.length;
  if (n === channels) {
    return planes;
  }
  const length = planes[0]?.length ?? 0;
  if (n === 1) {
    return [planes[0]!, planes[0]!];
  }
  let stereo = planes;
  if (n > 2) {
    const mix = STEREO_MIX[n];
    if (!mix) {
      throw new Error(`cannot mix down ${n} channels`);
    }
    const scale = 1 / mix.reduce((sum, [l]) => sum + l, 0);
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    mix.forEach(([l, r], c) => {
      const p = planes[c]!;
      for (let i = 0; i < length; i++) {
        left[i]! += p[i]! * l * scale;
        right[i]! += p[i]! * r * scale;
      }
    });
    stereo = [left, right];
  }
  if (channels === 2) {
    return stereo;
  }
  const mono = new Float32Array(length);
  const [left, right] = stereo as [Float32Array, Float32Array];
  for (let i = 0; i < length; i++) {
    mono[i] = (left[i]! + right[i]!) / 2;
  }
  return [mono];
}

/** Zero crossings of the windowed sinc on each side, at the narrower of the two rates. */
const ZERO_CROSSINGS = 8;
/** Kaiser window's β: about 60 dB of stopband, plenty for speech. */
const KAISER_BETA = 6;
/** Steps of the kernel table per input sample; a tap's phase is rounded to one. */
const TABLE_STEPS = 512;
/** Of the lower Nyquist frequency, where the passband ends. */
const CUTOFF = 0.94;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/**
 * A streaming band-limited resampler (windowed sinc, Kaiser window) for any pair of rates: `push` takes
 * planes at `from` and returns what can be computed so far at `to`; `flush` returns the rest. The output
 * is exactly round(input × to / from) frames long and starts at the same instant.
 */
export class Resampler {
  /** Input samples per channel kept from before; index 0 is input frame `base`. */
  private buffer: Float32Array<ArrayBuffer>[];
  private base: number;
  /** Input frames given so far. */
  private received = 0;
  /** Output frames given so far. */
  private produced = 0;
  /** Input samples on each side of an output sample that it reads. */
  private readonly reach: number;
  /** The kernel at 0, 1/TABLE_STEPS, … input samples from its centre. */
  private readonly kernel: Float32Array;
  private readonly weights: Float64Array;

  /** Rates in whole hertz. */
  constructor(
    readonly channels: number,
    readonly from: number,
    readonly to: number,
  ) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) {
      throw new RangeError(`cannot resample from ${from} to ${to} Hz`);
    }
    const band = CUTOFF * Math.min(1, to / from);
    this.reach = Math.ceil(ZERO_CROSSINGS / band);
    this.kernel = new Float32Array(this.reach * TABLE_STEPS + 1);
    const norm = besselI0(KAISER_BETA);
    for (let i = 0; i < this.kernel.length; i++) {
      const t = i / TABLE_STEPS;
      const x = t / this.reach;
      const window = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - x * x))) / norm;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * band * t) / (Math.PI * band * t);
      this.kernel[i] = band * sinc * window;
    }
    this.weights = new Float64Array(2 * this.reach);
    // The input before the first sample is silence.
    this.buffer = Array.from({ length: channels }, () => new Float32Array(this.reach));
    this.base = -this.reach;
  }

  push(planes: Planes): Planes {
    if (this.from === this.to) {
      return planes;
    }
    const added = planes[0]?.length ?? 0;
    this.buffer = this.buffer.map((b, c) => {
      const grown = new Float32Array(b.length + added);
      grown.set(b);
      grown.set(planes[c]!, b.length);
      return grown;
    });
    this.received += added;
    return this.run(this.base + this.buffer[0]!.length);
  }

  flush(): Planes {
    if (this.from === this.to) {
      return Array.from({ length: this.channels }, () => new Float32Array(0));
    }
    // The input after the last sample is silence too.
    this.buffer = this.buffer.map((b) => {
      const grown = new Float32Array(b.length + this.reach);
      grown.set(b);
      return grown;
    });
    const total = Math.round((this.received * this.to) / this.from);
    return this.run(this.base + this.buffer[0]!.length, total);
  }

  /** Output frames whose taps all lie before input frame `end`, up to `limit` frames in all. */
  private run(end: number, limit = Infinity): Planes {
    const { from, to, reach, kernel, weights } = this;
    // Output frame k sits at input position k × from / to and reads up to floor(that) + reach, which
    // must be before `end`: k × from < (end - reach) × to.
    const ready = Math.floor(((end - reach) * to - 1) / from) + 1;
    const count = Math.max(0, Math.min(ready, limit) - this.produced);
    const out = Array.from({ length: this.channels }, () => new Float32Array(count));
    for (let o = 0; o < count; o++) {
      const k = this.produced + o;
      const position = (k * from) / to;
      const centre = Math.floor(position);
      const frac = position - centre;
      let sum = 0;
      for (let m = 0; m < 2 * reach; m++) {
        // Tap m reads input frame centre - reach + 1 + m, at distance |frac + reach - 1 - m| from the position.
        const d = Math.abs(frac + reach - 1 - m);
        const w = kernel[Math.round(d * TABLE_STEPS)] ?? 0;
        weights[m] = w;
        sum += w;
      }
      const first = centre - reach + 1 - this.base;
      for (let c = 0; c < this.channels; c++) {
        const b = this.buffer[c]!;
        let acc = 0;
        for (let m = 0; m < 2 * reach; m++) {
          acc += (b[first + m] ?? 0) * weights[m]!;
        }
        out[c]![o] = sum > 0 ? acc / sum : 0;
      }
    }
    this.produced += count;
    // Keep only what later output still reads.
    const keepFrom = Math.floor((this.produced * from) / to) - reach + 1;
    const drop = Math.max(0, Math.min(keepFrom - this.base, this.buffer[0]!.length));
    if (drop > 0) {
      this.buffer = this.buffer.map((b) => b.slice(drop));
      this.base += drop;
    }
    return out;
  }
}

/** How PCM bytes are laid out. */
export interface PcmFormat {
  channels: number;
  bits: number;
  float: boolean;
  bigEndian: boolean;
}

/** Interleaved PCM bytes (whole frames) as planes in [-1, 1]; 8-bit integer PCM is unsigned, wider is signed. */
export function readPcm(bytes: Uint8Array, f: PcmFormat): Planes {
  const width = f.bits / 8;
  const frames = Math.floor(bytes.length / (width * f.channels));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = !f.bigEndian;
  const planes = Array.from({ length: f.channels }, () => new Float32Array(frames));
  const read = (at: number): number => {
    if (f.float) {
      return width === 4 ? view.getFloat32(at, little) : view.getFloat64(at, little);
    }
    switch (width) {
      case 1: {
        return (view.getUint8(at) - 128) / 128;
      }
      case 2: {
        return view.getInt16(at, little) / 0x80_00;
      }
      case 3: {
        const [a, b, c] = little ? [at, at + 1, at + 2] : [at + 2, at + 1, at];
        const value = view.getUint8(a) | (view.getUint8(b) << 8) | (view.getInt8(c) << 16);
        return value / 0x80_00_00;
      }
      default: {
        return view.getInt32(at, little) / 0x80_00_00_00;
      }
    }
  };
  for (let i = 0, at = 0; i < frames; i++) {
    for (let c = 0; c < f.channels; c++, at += width) {
      planes[c]![i] = read(at);
    }
  }
  return planes;
}

/** Whether `readPcm` reads this layout. */
export const pcmReadable = (f: PcmFormat) =>
  f.channels >= 1 && (f.float ? f.bits === 32 || f.bits === 64 : [8, 16, 24, 32].includes(f.bits));

/** Where decoded audio goes: what it takes, and the body it makes. */
export interface PcmOutput {
  readonly channels: 1 | 2;
  readonly rate: number;
  /** The most seconds it can hold, when it has a limit. */
  readonly maxSeconds?: number;
  write(planes: Planes): void | Promise<void>;
  finish(): Promise<{ body: Blob; type: string }>;
}

/** A 16-bit PCM WAV file, written as it comes. */
export class WavWriter implements PcmOutput {
  private readonly parts: Uint8Array<ArrayBuffer>[] = [];
  private bytes = 0;
  readonly maxSeconds: number;

  /** `maxBytes`: the file's size at most, header included. */
  constructor(
    readonly channels: 1 | 2,
    readonly rate: number,
    maxBytes = Infinity,
  ) {
    this.maxSeconds = Math.floor((maxBytes - 44) / (channels * 2)) / rate;
  }

  write(planes: Planes) {
    const length = planes[0]?.length ?? 0;
    const out = new Int16Array(length * this.channels);
    for (let i = 0, at = 0; i < length; i++) {
      for (let c = 0; c < this.channels; c++, at++) {
        const s = Math.max(-1, Math.min(1, planes[c]![i]!));
        out[at] = Math.round(s < 0 ? s * 0x80_00 : s * 0x7f_ff);
      }
    }
    this.parts.push(new Uint8Array(out.buffer));
    this.bytes += out.byteLength;
  }

  finish() {
    const head = new Uint8Array(44);
    const view = new DataView(head.buffer);
    const ascii = (at: number, s: string) => {
      for (let i = 0; i < s.length; i++) {
        head[at + i] = s.charCodeAt(i);
      }
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + this.bytes, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, this.channels, true);
    view.setUint32(24, this.rate, true);
    view.setUint32(28, this.rate * this.channels * 2, true);
    view.setUint16(32, this.channels * 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, this.bytes, true);
    return Promise.resolve({ body: new Blob([head, ...this.parts], { type: "audio/wav" }), type: "audio/wav" });
  }
}

/** A gap in the timestamps at least this long is filled with silence; a shorter one is rounding. */
const GAP_US = 10_000;
/** Silence is written in pieces of at most this many frames. */
const SILENCE_PIECE = 48_000;

export interface TimelineOptions {
  /** Seconds kept at most (the server's `max_seconds`; less when the output's `maxSeconds` is). */
  keepSeconds: number;
  /** A start at most this late is filled with silence; a later one becomes the `offset`. */
  leadLimitSeconds: number;
  /** Where the samples go, made once the first chunk says how many channels the audio has. */
  output(channels: number): PcmOutput;
}

/** What `PcmTimeline.finish` gives. */
export interface TimelineResult {
  body: Blob;
  type: string;
  /** Seconds of audio in it. */
  seconds: number;
  /** Cut short at `keepSeconds`. */
  cut: boolean;
  /** Seconds into the file at which it starts. */
  offset: number;
}

/**
 * Decoded audio put where its timestamps say: what comes before 0 (an encoder's priming) is dropped, a
 * late start or a gap of GAP_US or more is filled with silence (so the server's times are the file's), a
 * start later than `leadLimitSeconds` sets the offset instead, and the rest is mixed down, resampled and
 * written. Chunks must come in order and at one sample rate.
 */
export class PcmTimeline {
  private out: PcmOutput | null = null;
  private resampler: Resampler | null = null;
  private rate = 0;
  /** Frames at `rate` written, silence included. */
  private written = 0;
  /** Microseconds from the file's 0 to the output's. */
  private offsetUs: number | null = null;
  /** Set once `keepSeconds` is reached. */
  full = false;
  private cut = false;

  constructor(private readonly o: TimelineOptions) {}

  /** Adds a chunk of `planes` at `rate` that plays at `timestamp` µs. Returns false once full. */
  async add(timestamp: number, planes: Planes, rate: number): Promise<boolean> {
    if (this.full) {
      this.cut ||= (planes[0]?.length ?? 0) > 0;
      return false;
    }
    if (!this.out) {
      this.out = this.o.output(planes.length);
      this.rate = rate;
      this.resampler = new Resampler(this.out.channels, rate, this.out.rate);
    } else if (rate !== this.rate) {
      throw new Error(`the sample rate changes from ${this.rate} to ${rate} Hz`);
    }
    if (this.offsetUs === null) {
      const late = timestamp > 0 && timestamp > this.o.leadLimitSeconds * 1e6;
      this.offsetUs = late ? timestamp : 0;
    }
    let chunk = planes;
    const start = Math.round(((timestamp - this.offsetUs) * rate) / 1e6);
    if (start < 0) {
      // Before 0: what the decoder primes with.
      const drop = Math.min(-start, chunk[0]?.length ?? 0);
      chunk = chunk.map((p) => p.subarray(drop));
    } else if (((start - this.written) * 1e6) / rate >= GAP_US) {
      await this.silence(start - this.written);
    }
    await this.write(chunk);
    return !this.full;
  }

  async finish(): Promise<TimelineResult> {
    if (!this.out || this.written === 0) {
      throw new Error("no audio");
    }
    const rest = this.resampler!.flush();
    if ((rest[0]?.length ?? 0) > 0) {
      await this.out.write(rest);
    }
    const { body, type } = await this.out.finish();
    return {
      body,
      type,
      seconds: this.written / this.rate,
      cut: this.cut,
      offset: (this.offsetUs ?? 0) / 1e6,
    };
  }

  private async silence(frames: number) {
    const { channels } = this.out!;
    for (let left = frames; left > 0 && !this.full; left -= SILENCE_PIECE) {
      const n = Math.min(left, SILENCE_PIECE);
      await this.write(Array.from({ length: channels }, () => new Float32Array(n)));
    }
  }

  private async write(planes: Planes) {
    const keep = Math.floor(Math.min(this.o.keepSeconds, this.out!.maxSeconds ?? Infinity) * this.rate);
    let chunk = planes;
    const length = chunk[0]?.length ?? 0;
    if (this.written + length >= keep) {
      this.cut ||= this.written + length > keep;
      this.full = true;
      chunk = chunk.map((p) => p.subarray(0, keep - this.written));
    }
    const n = chunk[0]?.length ?? 0;
    if (n === 0) {
      return;
    }
    this.written += n;
    const resampled = this.resampler!.push(mixDownPlanes(chunk, this.out!.channels));
    if ((resampled[0]?.length ?? 0) > 0) {
      await this.out!.write(resampled);
    }
  }
}
