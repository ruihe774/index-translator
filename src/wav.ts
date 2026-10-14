// WAV files in and out of the speech engine, which takes and returns float samples: voice
// recordings are decoded here, and what it synthesizes is written as 16-bit PCM.

export interface Pcm {
  /** Interleaved, -1 to 1. */
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xff_fe;

type Reader = (view: DataView, at: number) => number;

function sampleReader(format: number, bits: number): Reader | undefined {
  if (format === FORMAT_FLOAT) {
    if (bits === 32) {
      return (v, at) => v.getFloat32(at, true);
    }
    if (bits === 64) {
      return (v, at) => v.getFloat64(at, true);
    }
  } else if (format === FORMAT_PCM) {
    if (bits === 8) {
      return (v, at) => (v.getUint8(at) - 128) / 128;
    }
    if (bits === 16) {
      return (v, at) => v.getInt16(at, true) / 0x80_00;
    }
    if (bits === 24) {
      return (v, at) => ((v.getInt8(at + 2) << 16) | v.getUint16(at, true)) / 0x80_00_00;
    }
    if (bits === 32) {
      return (v, at) => v.getInt32(at, true) / 0x80_00_00_00;
    }
  }
  return undefined;
}

/**
 * Decodes a RIFF/WAVE file with integer PCM (8, 16, 24 or 32 bits) or float (32 or 64 bits)
 * samples. Throws an Error that says what is wrong with the file.
 */
export function readWav(bytes: Uint8Array): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("not a WAV file");
  }

  let read: Reader | undefined;
  let encoding = "";
  let channels = 0;
  let sampleRate = 0;
  let width = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (tag(at) === "fmt " && body + 16 <= bytes.length) {
      let format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      // The real format is the first field of the sub-format GUID.
      const extensible = format === FORMAT_EXTENSIBLE && size >= 26 && body + 26 <= bytes.length;
      if (extensible) {
        format = view.getUint16(body + 24, true);
      }
      read = sampleReader(format, bits);
      encoding = `format ${format}, ${bits} bits`;
      width = bits / 8;
    } else if (tag(at) === "data") {
      if (!encoding) {
        throw new Error("the WAV file has no format before its audio");
      }
      if (!read) {
        throw new Error(`the WAV encoding is not supported (${encoding})`);
      }
      if (channels < 1 || sampleRate < 1) {
        throw new Error("the WAV file has no channels or no sample rate");
      }
      // A recorder that could not seek back leaves the size at zero or all ones: take what is there.
      const end = Math.min(body + size, bytes.length);
      const count = Math.floor((end - body) / width / channels) * channels;
      if (count < 1) {
        throw new Error("the WAV file has no audio");
      }
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        samples[i] = read(view, body + i * width);
      }
      return { samples, sampleRate, channels };
    }
    at = body + size + (size & 1);
  }
  throw new Error("the WAV file has no audio");
}

/** Zero crossings of the interpolation kernel on each side of a sample; more is sharper and slower. */
const KERNEL_LOBES = 16;
/** Points of the tabulated kernel per input sample. */
const KERNEL_STEPS = 256;

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/**
 * `pcm` at `sampleRate` Hz (windowed-sinc interpolation, low-passed below the lower of the two
 * rates' Nyquist limits, so downsampling does not alias), and with `channels` channels when that is
 * fewer than it has: the extra channels are averaged into the last one kept.
 */
export function resample(pcm: Pcm, sampleRate: number, channels = pcm.channels): Pcm {
  const kept = Math.min(channels, pcm.channels);
  const frames = pcm.samples.length / pcm.channels;
  // One mono-or-stereo planar copy, with the channels beyond `kept` mixed into the last one.
  const planar = Array.from({ length: kept }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < pcm.channels; c++) {
      planar[Math.min(c, kept - 1)]![i]! += pcm.samples[i * pcm.channels + c]!;
    }
  }
  const folded = pcm.channels - kept + 1;
  if (folded > 1) {
    for (let i = 0; i < frames; i++) {
      planar[kept - 1]![i]! /= folded;
    }
  }

  const ratio = sampleRate / pcm.sampleRate;
  const outFrames = Math.max(1, Math.round(frames * ratio));
  const cutoff = Math.min(1, ratio);
  // Kernel half-width in input samples: the lobes of the low-passed sinc, which are wider when downsampling.
  const half = Math.ceil(KERNEL_LOBES / cutoff);
  // The kernel (Hann-windowed over its width) tabulated at KERNEL_STEPS points per input sample, and
  // linearly interpolated, which is far faster than evaluating it for every tap.
  const table = new Float32Array(2 * half * KERNEL_STEPS + 2);
  for (let k = 0; k < table.length; k++) {
    const d = k / KERNEL_STEPS - half;
    table[k] = Math.abs(d) >= half ? 0 : cutoff * sinc(d * cutoff) * (0.5 + 0.5 * Math.cos((Math.PI * d) / half));
  }
  const out = new Float32Array(outFrames * kept);
  for (let o = 0; o < outFrames; o++) {
    const at = o / ratio;
    const first = Math.max(0, Math.ceil(at - half));
    const last = Math.min(frames - 1, Math.floor(at + half));
    for (let c = 0; c < kept; c++) {
      const channel = planar[c]!;
      let sum = 0;
      for (let i = first; i <= last; i++) {
        const x = (i - at + half) * KERNEL_STEPS;
        const k = Math.floor(x);
        sum += channel[i]! * (table[k]! + (table[k + 1]! - table[k]!) * (x - k));
      }
      out[o * kept + c] = sum;
    }
  }
  return { samples: out, sampleRate, channels: kept };
}

/** RMS the voice is brought to, over its non-silent samples (-20 dBFS). */
const TARGET_RMS = 0.1;
/** Samples below this (-40 dBFS) are pauses and noise floor, not counted in the loudness. */
const SILENCE_GATE = 0.01;
const PEAK_LIMIT = 0.98;

/**
 * Simple loudness normalization: scales the samples so that the RMS of those above the silence
 * gate is TARGET_RMS, but never so far that the peak passes PEAK_LIMIT. Not a standard (no
 * K-weighting, no integration windows); a recording with no sound above the gate is unchanged.
 */
export function normalizeLoudness(pcm: Pcm): Pcm {
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (const x of pcm.samples) {
    const a = Math.abs(x);
    if (a > peak) {
      peak = a;
    }
    if (a > SILENCE_GATE) {
      sum += x * x;
      count++;
    }
  }
  if (count === 0) {
    return pcm;
  }
  const gain = Math.min(TARGET_RMS / Math.sqrt(sum / count), PEAK_LIMIT / peak);
  return { ...pcm, samples: pcm.samples.map((x) => x * gain) };
}

/** A WAV file with 16-bit PCM samples. */
export function writeWav(pcm: Pcm): ArrayBuffer {
  const bytes = pcm.samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(at + i, s.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, pcm.channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * pcm.channels * 2, true);
  view.setUint16(32, pcm.channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, bytes, true);
  for (let i = 0; i < pcm.samples.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm.samples[i]!));
    view.setInt16(44 + i * 2, Math.round(s * 0x7f_ff), true);
  }
  return view.buffer;
}
