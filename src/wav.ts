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

/** What a WAV file holds, from its header: the audio is `frames` × `channels` samples from byte `body`. */
export interface WavInfo {
  sampleRate: number;
  channels: number;
  frames: number;
}

/** The header of a WAV file and how to read its samples. Throws an Error that says what is wrong with the file. */
function parseWav(bytes: Uint8Array): WavInfo & { read: Reader; width: number; body: number } {
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
      const frames = Math.floor((end - body) / width / channels);
      if (frames < 1) {
        throw new Error("the WAV file has no audio");
      }
      return { sampleRate, channels, frames, read, width, body };
    }
    at = body + size + (size & 1);
  }
  throw new Error("the WAV file has no audio");
}

/** The format and length of a WAV file without decoding its audio. Throws as `readWav` does. */
export function readWavInfo(bytes: Uint8Array): WavInfo {
  const { sampleRate, channels, frames } = parseWav(bytes);
  return { sampleRate, channels, frames };
}

/**
 * Decodes a RIFF/WAVE file with integer PCM (8, 16, 24 or 32 bits) or float (32 or 64 bits)
 * samples. Throws an Error that says what is wrong with the file.
 */
export function readWav(bytes: Uint8Array): Pcm {
  const { sampleRate, channels, frames, read, width, body } = parseWav(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(frames * channels);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = read(view, body + i * width);
  }
  return { samples, sampleRate, channels };
}

/** RMS the voice is brought to, over its non-silent samples (-20 dBFS). */
const TARGET_RMS = 0.1;
/** Samples below this (-40 dBFS) are pauses and noise floor, not counted in the loudness. */
const SILENCE_GATE = 0.01;
const PEAK_LIMIT = 0.98;

/** With `relative`, the gate is this far under the recording's peak instead (-40 dB). */
const RELATIVE_GATE = 0.01;

/**
 * Simple loudness normalization: scales the samples so that the RMS of those above the silence
 * gate is TARGET_RMS, but never so far that the peak passes PEAK_LIMIT. Not a standard (no
 * K-weighting, no integration windows); a recording with no sound above the gate is unchanged.
 * `relative` puts the gate 40 dB under the recording's peak, so one recorded far under -40 dBFS is
 * brought up too (for speech recognition; a voice sample that quiet is noise).
 */
export function normalizeLoudness(pcm: Pcm, relative = false): Pcm {
  let peak = 0;
  for (const x of pcm.samples) {
    peak = Math.max(peak, Math.abs(x));
  }
  const gate = relative ? peak * RELATIVE_GATE : SILENCE_GATE;
  let sum = 0;
  let count = 0;
  for (const x of pcm.samples) {
    if (Math.abs(x) > gate) {
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

/** A float sample (clamped to -1 to 1) as a 16-bit one, rounded. */
export const floatToInt16 = (s: number): number => Math.round(Math.max(-1, Math.min(1, s)) * 0x7f_ff);

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
    view.setInt16(44 + i * 2, floatToInt16(pcm.samples[i]!), true);
  }
  return view.buffer;
}
