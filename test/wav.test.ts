// Decoding voice recordings and writing synthesized speech (src/wav.ts).

import { describe, expect, test } from "bun:test";
import { normalizeLoudness, type Pcm, readWav, resample, writeWav } from "../src/wav";

describe("normalizeLoudness", () => {
  const tone = (amp: number, silence = 0): Pcm => {
    const samples = new Float32Array(8000 + silence);
    for (let i = 0; i < 8000; i++) samples[i] = amp * Math.sin(i * 0.1);
    return { samples, sampleRate: 8000, channels: 1 };
  };
  const rms = (p: Pcm) => Math.sqrt(p.samples.reduce((s, x) => s + x * x, 0) / p.samples.length);

  test("brings quiet and loud voices to the same level", () => {
    expect(rms(normalizeLoudness(tone(0.05)))).toBeCloseTo(0.1, 1);
    expect(rms(normalizeLoudness(tone(0.14)))).toBeCloseTo(0.1, 1);
  });

  test("pauses do not count and the peak stays below full scale", () => {
    const out = normalizeLoudness(tone(0.05, 8000));
    expect(Math.max(...out.samples.map(Math.abs))).toBeLessThanOrEqual(0.98 + 1e-6);
    expect(rms({ ...out, samples: out.samples.slice(0, 8000) })).toBeCloseTo(0.1, 1);
  });

  test("silence is left alone", () => {
    const silent: Pcm = { samples: new Float32Array(100), sampleRate: 8000, channels: 1 };
    expect(normalizeLoudness(silent)).toBe(silent);
  });
});

interface Format {
  format: number;
  bits: number;
  channels?: number;
  rate?: number;
  /** Chunks between `fmt ` and `data`, as recorders write them. */
  extra?: Uint8Array;
  /** Writes the format as WAVE_FORMAT_EXTENSIBLE. */
  extensible?: boolean;
  /** What the data chunk's size field says, when not the real size. */
  declaredSize?: number;
}

/** A WAV file around `data`, the bytes of the samples. */
function wav(data: Uint8Array, f: Format): Uint8Array {
  const { channels = 1, rate = 16000, extra = new Uint8Array(0) } = f;
  const fmtSize = f.extensible ? 40 : 16;
  const out = new Uint8Array(12 + 8 + fmtSize + extra.length + 8 + data.length);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => out.set(new TextEncoder().encode(s), at);
  ascii(0, "RIFF");
  view.setUint32(4, out.length - 8, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, f.extensible ? 0xfffe : f.format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, (rate * channels * f.bits) / 8, true);
  view.setUint16(32, (channels * f.bits) / 8, true);
  view.setUint16(34, f.bits, true);
  if (f.extensible) {
    view.setUint16(36, 22, true);
    view.setUint16(44, f.format, true);
  }
  let at = 20 + fmtSize;
  out.set(extra, at);
  at += extra.length;
  ascii(at, "data");
  view.setUint32(at + 4, f.declaredSize ?? data.length, true);
  out.set(data, at + 8);
  return out;
}

const bytesOf = (values: ArrayBufferView) => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);

describe("readWav", () => {
  test("16-bit PCM", () => {
    const pcm = readWav(wav(bytesOf(new Int16Array([0, 16384, -32768, 32767])), { format: 1, bits: 16 }));
    expect(pcm.sampleRate).toBe(16000);
    expect(pcm.channels).toBe(1);
    expect([...pcm.samples]).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  test("8-, 24- and 32-bit PCM", () => {
    expect([...readWav(wav(new Uint8Array([128, 0, 192]), { format: 1, bits: 8 })).samples]).toEqual([0, -1, 0.5]);
    const s24 = new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00, 0x80, 0xff, 0xff, 0xff]);
    expect([...readWav(wav(s24, { format: 1, bits: 24 })).samples]).toEqual([0.5, -1, -1 / 0x800000]);
    const s32 = bytesOf(new Int32Array([0x40000000, -0x80000000]));
    expect([...readWav(wav(s32, { format: 1, bits: 32 })).samples]).toEqual([0.5, -1]);
  });

  test("32- and 64-bit float, as the example voices are", () => {
    const f32 = readWav(wav(bytesOf(new Float32Array([0.25, -0.75])), { format: 3, bits: 32, rate: 48000 }));
    expect(f32.sampleRate).toBe(48000);
    expect([...f32.samples]).toEqual([0.25, -0.75]);
    expect([...readWav(wav(bytesOf(new Float64Array([0.25, -0.75])), { format: 3, bits: 64 })).samples]).toEqual([
      0.25, -0.75,
    ]);
  });

  test("stereo stays interleaved; an incomplete last frame is dropped", () => {
    const pcm = readWav(
      wav(bytesOf(new Int16Array([16384, -16384, 8192, -8192, 4096])), {
        format: 1,
        bits: 16,
        channels: 2,
      }),
    );
    expect(pcm.channels).toBe(2);
    expect([...pcm.samples]).toEqual([0.5, -0.5, 0.25, -0.25]);
  });

  test("the extensible format and chunks before the audio", () => {
    // An odd-sized chunk is followed by a padding byte.
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]);
    const pcm = readWav(wav(bytesOf(new Int16Array([16384])), { format: 1, bits: 16, extensible: true, extra: list }));
    expect([...pcm.samples]).toEqual([0.5]);
  });

  test("a data size the recorder never filled in means the rest of the file", () => {
    const data = bytesOf(new Int16Array([16384, -16384]));
    for (const declaredSize of [0xffffffff, data.length + 100]) {
      expect([...readWav(wav(data, { format: 1, bits: 16, declaredSize })).samples]).toEqual([0.5, -0.5]);
    }
  });

  test("says what is wrong with a file it cannot use", () => {
    expect(() => readWav(new Uint8Array(64))).toThrow("not a WAV file");
    expect(() => readWav(new TextEncoder().encode("RIFF"))).toThrow("not a WAV file");
    expect(() => readWav(wav(new Uint8Array(8), { format: 6, bits: 8 }))).toThrow("not supported (format 6, 8 bits)");
    expect(() => readWav(wav(new Uint8Array(0), { format: 1, bits: 16 }))).toThrow("no audio");
    expect(() => readWav(wav(new Uint8Array(4), { format: 1, bits: 16, channels: 0 }))).toThrow("no channels");
    expect(() => readWav(wav(new Uint8Array(4), { format: 1, bits: 16 }).subarray(0, 36))).toThrow("no audio");
  });
});

describe("writeWav", () => {
  test("16-bit PCM that reads back, clipped to the range", () => {
    const file = writeWav({ samples: new Float32Array([0, 0.5, -0.5, 2, -2]), sampleRate: 22050, channels: 1 });
    const view = new DataView(file);
    expect(file.byteLength).toBe(44 + 10);
    expect(view.getUint32(4, true)).toBe(file.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint32(28, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16);

    const back = readWav(new Uint8Array(file));
    expect(back.sampleRate).toBe(22050);
    expect(back.channels).toBe(1);
    expect([...back.samples].map((s) => Math.round(s * 1000) / 1000)).toEqual([0, 0.5, -0.5, 1, -1]);
  });
});

describe("resample", () => {
  /** `seconds` of a sine of `hz` in `channels` identical channels. */
  const sine = (hz: number, rate: number, seconds = 0.5, channels = 1): Pcm => {
    const frames = Math.round(rate * seconds);
    const samples = new Float32Array(frames * channels);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) samples[i * channels + c] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
    }
    return { samples, sampleRate: rate, channels };
  };
  /** Root mean square of the samples between the frames `from` and `to`, away from the edges. */
  const rms = (pcm: Pcm, from: number, to: number) => {
    let sum = 0;
    for (let i = from * pcm.channels; i < to * pcm.channels; i++) sum += pcm.samples[i]! ** 2;
    return Math.sqrt(sum / ((to - from) * pcm.channels));
  };

  test("keeps a tone's level and length when the rate changes", () => {
    for (const [from, to] of [
      [16000, 44100],
      [48000, 44100],
      [22050, 44100],
    ] as const) {
      const out = resample(sine(440, from), to);
      expect(out.sampleRate).toBe(to);
      expect(out.channels).toBe(1);
      expect(out.samples.length).toBe(Math.round(to * 0.5));
      // A sine of amplitude 0.5 has an RMS of 0.5 / sqrt(2).
      expect(rms(out, to * 0.1, to * 0.4)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    }
  });

  test("follows the waveform, not only its level", () => {
    const out = resample(sine(440, 16000), 44100);
    let worst = 0;
    for (let i = 4000; i < 18000; i++) {
      worst = Math.max(worst, Math.abs(out.samples[i]! - 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100)));
    }
    expect(worst).toBeLessThan(0.01);
  });

  test("removes what the lower rate cannot hold instead of folding it back", () => {
    // 15 kHz is above the 8 kHz Nyquist limit of the 16 kHz result.
    const out = resample(sine(15000, 44100), 16000);
    expect(rms(out, 3000, 5000)).toBeLessThan(0.01);
  });

  test("the same rate is a copy", () => {
    const pcm = sine(300, 44100, 0.1);
    const out = resample(pcm, 44100);
    expect(out.samples.length).toBe(pcm.samples.length);
    for (let i = 100; i < pcm.samples.length - 100; i++) expect(out.samples[i]).toBeCloseTo(pcm.samples[i]!, 3);
  });

  test("keeps stereo, or averages the extra channels into the last one kept", () => {
    const stereo = resample(sine(440, 16000, 0.2, 2), 44100, 2);
    expect(stereo.channels).toBe(2);
    expect(stereo.samples[2000 * 2]).toBeCloseTo(stereo.samples[2000 * 2 + 1]!, 5);

    // Three constant channels: the first is kept, the other two are averaged into the second.
    const three: Pcm = {
      samples: Float32Array.from({ length: 3 * 1000 }, (_, i) => [0.5, 0.2, 0.6][i % 3]!),
      sampleRate: 44100,
      channels: 3,
    };
    const folded = resample(three, 44100, 2);
    expect(folded.channels).toBe(2);
    expect(folded.samples[500 * 2]).toBeCloseTo(0.5, 3);
    expect(folded.samples[500 * 2 + 1]).toBeCloseTo(0.4, 3);
    expect(resample(sine(440, 44100, 0.1, 2), 44100, 1).channels).toBe(1);
    // More channels than the file has are not invented.
    expect(resample(sine(440, 44100, 0.1, 1), 44100, 2).channels).toBe(1);
  });
});
