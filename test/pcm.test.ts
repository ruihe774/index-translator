import { describe, expect, test } from "bun:test";

import {
  mixDownPlanes,
  PcmTimeline,
  type Planes,
  readPcm,
  Resampler,
  type TimelineOptions,
  WavWriter,
} from "../public/pcm";
import { readWav } from "../src/wav";

const sine = (hz: number, rate: number, frames: number, from = 0) =>
  Float32Array.from({ length: frames }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * (from + i)) / rate));

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

/** The largest difference between `a` and a sine of `hz` at `rate`, away from both ends. */
function sineError(a: Float32Array, hz: number, rate: number, margin: number) {
  let worst = 0;
  for (let i = margin; i < a.length - margin; i++) {
    worst = Math.max(worst, Math.abs(a[i]! - 0.5 * Math.sin((2 * Math.PI * hz * i) / rate)));
  }
  return worst;
}

function resampleAll(r: Resampler, input: Float32Array, piece: number): Float32Array {
  const out: number[] = [];
  for (let at = 0; at < input.length; at += piece) {
    out.push(...r.push([input.slice(at, at + piece)])[0]!);
  }
  out.push(...r.flush()[0]!);
  return Float32Array.from(out);
}

describe("Resampler", () => {
  test("44.1 to 48 kHz keeps a tone's frequency, level and timing, whatever the pieces", () => {
    const input = sine(1000, 44_100, 44_100);
    const whole = resampleAll(new Resampler(1, 44_100, 48_000), input, input.length);
    expect(whole).toHaveLength(48_000);
    expect(sineError(whole, 1000, 48_000, 100)).toBeLessThan(2e-3);
    const pieces = resampleAll(new Resampler(1, 44_100, 48_000), input, 997);
    expect(pieces).toStrictEqual(whole);
  });

  test("down to 16 kHz takes out what is above the new Nyquist frequency", () => {
    const kept = resampleAll(new Resampler(1, 48_000, 16_000), sine(1000, 48_000, 48_000), 4800);
    expect(kept).toHaveLength(16_000);
    expect(sineError(kept, 1000, 16_000, 100)).toBeLessThan(2e-3);
    const alias = resampleAll(new Resampler(1, 48_000, 16_000), sine(12_000, 48_000, 48_000), 4800);
    expect(rms(alias.subarray(100, -100))).toBeLessThan(0.01);
  });

  test("the same rate passes the samples through; channels stay apart", () => {
    const a = sine(440, 48_000, 1000);
    expect(new Resampler(1, 48_000, 48_000).push([a])[0]).toBe(a);
    const r = new Resampler(2, 22_050, 44_100);
    const [left, right] = r.push([sine(440, 22_050, 22_050), new Float32Array(22_050)]);
    const rest = r.flush();
    expect(left!.length + rest[0]!.length).toBe(44_100);
    expect(rms(left!)).toBeGreaterThan(0.3);
    expect(rms(right!)).toBe(0);
  });

  test("a rate that is not whole hertz is refused", () => {
    expect(() => new Resampler(1, 44_100.5, 48_000)).toThrow(RangeError);
  });
});

describe("mixDownPlanes", () => {
  const one = (n: number) => new Float32Array([n]);

  test("5.1 to stereo: centre and surrounds at -3 dB, no LFE, nothing clips", () => {
    // L R C LFE BL BR, all at full scale.
    const [l, r] = mixDownPlanes([one(1), one(0), one(1), one(1), one(1), one(0)], 2);
    expect(l![0]).toBeCloseTo(1, 5);
    expect(r![0]).toBeCloseTo(Math.SQRT1_2 / (1 + 2 * Math.SQRT1_2), 5);
  });

  test("stereo to mono is the mean; mono to stereo copies; same count passes through", () => {
    expect(mixDownPlanes([one(1), one(0)], 1)[0]![0]).toBe(0.5);
    const mono = [one(0.25)];
    expect(mixDownPlanes(mono, 2)).toStrictEqual([one(0.25), one(0.25)]);
    expect(mixDownPlanes(mono, 1)).toBe(mono);
  });

  test("more than eight channels are refused", () => {
    expect(() =>
      mixDownPlanes(
        Array.from({ length: 9 }, () => one(0)),
        2,
      ),
    ).toThrow("9 channels");
  });
});

test("readPcm reads every layout to [-1, 1]", () => {
  const le16 = new Uint8Array([0x00, 0x80, 0xff, 0x7f]);
  expect(readPcm(le16, { channels: 1, bits: 16, float: false, bigEndian: false })[0]).toStrictEqual(
    new Float32Array([-1, 0x7f_ff / 0x80_00]),
  );
  const be24 = new Uint8Array([0x80, 0x00, 0x00, 0x40, 0x00, 0x00]);
  expect(readPcm(be24, { channels: 2, bits: 24, float: false, bigEndian: true })).toStrictEqual([
    new Float32Array([-1]),
    new Float32Array([0.5]),
  ]);
  expect(
    readPcm(new Uint8Array([0, 128, 255]), { channels: 1, bits: 8, float: false, bigEndian: false })[0],
  ).toStrictEqual(new Float32Array([-1, 0, 127 / 128]));
  const f32 = new Uint8Array(new Float32Array([0.25, -0.5]).buffer);
  expect(readPcm(f32, { channels: 1, bits: 32, float: true, bigEndian: false })[0]).toStrictEqual(
    new Float32Array([0.25, -0.5]),
  );
});

describe("PcmTimeline", () => {
  const RATE = 16_000;
  function timeline(o: Partial<TimelineOptions> = {}) {
    return new PcmTimeline({
      keepSeconds: 1800,
      leadLimitSeconds: 10,
      output: () => new WavWriter(1, RATE),
      ...o,
    });
  }
  const ones = (frames: number): Planes => [new Float32Array(frames).fill(0.5)];
  const samples = async (t: PcmTimeline) => {
    const r = await t.finish();
    return { ...r, wav: readWav(new Uint8Array(await r.body.arrayBuffer())) };
  };

  test("priming before 0 is dropped, a gap is filled, a short jitter is not", async () => {
    const t = timeline();
    // 0.1 s, of which the first 0.05 s is before 0.
    await expect(t.add(-50_000, ones(1600), RATE)).resolves.toBe(true);
    // 2 ms late: rounding, appended.
    await t.add(52_000, ones(800), RATE);
    // A 0.2 s gap.
    await t.add(300_000, ones(800), RATE);
    const { seconds, wav, offset, cut, type } = await samples(t);
    expect(type).toBe("audio/wav");
    expect(offset).toBe(0);
    expect(cut).toBe(false);
    expect(seconds).toBeCloseTo(0.35, 5);
    expect(wav.samples).toHaveLength(5600);
    expect(wav.samples[1599]).toBeCloseTo(0.5, 3);
    expect(wav.samples[1600]).toBe(0);
    expect(wav.samples[4799]).toBe(0);
    expect(wav.samples[4800]).toBeCloseTo(0.5, 3);
  });

  test("a late start is filled up to the limit and becomes the offset beyond it", async () => {
    const soon = timeline();
    await soon.add(1_500_000, ones(1600), RATE);
    const filled = await samples(soon);
    expect(filled.offset).toBe(0);
    expect(filled.wav.samples).toHaveLength(1.6 * RATE);

    const late = timeline();
    await late.add(20_000_000, ones(1600), RATE);
    await late.add(20_100_000, ones(1600), RATE);
    const offset = await samples(late);
    expect(offset.offset).toBe(20);
    expect(offset.wav.samples).toHaveLength(3200);
  });

  test("stops at keepSeconds, saying it was cut only when there was more", async () => {
    const t = timeline({ keepSeconds: 0.25 });
    await expect(t.add(0, ones(3200), RATE)).resolves.toBe(true);
    await expect(t.add(200_000, ones(3200), RATE)).resolves.toBe(false);
    const r = await samples(t);
    expect(r.cut).toBe(true);
    expect(r.wav.samples).toHaveLength(4000);

    const exact = timeline({ keepSeconds: 0.2 });
    await expect(exact.add(0, ones(3200), RATE)).resolves.toBe(false);
    expect((await exact.finish()).cut).toBe(false);
  });

  test("mixes down and resamples to what the output takes", async () => {
    const asked: number[] = [];
    const t = timeline({
      output: (channels) => {
        asked.push(channels);
        return new WavWriter(1, 44_100);
      },
    });
    const six = Array.from({ length: 6 }, (_, c) => new Float32Array(48_000).fill(c === 2 ? 0.5 : 0));
    await t.add(0, six, 48_000);
    const r = await samples(t);
    expect(asked).toStrictEqual([6]);
    expect(r.wav.sampleRate).toBe(44_100);
    expect(r.wav.channels).toBe(1);
    expect(r.wav.samples).toHaveLength(44_100);
    // Only the centre, at -3 dB into each side and scaled so a full mix does not clip.
    expect(r.wav.samples[22_050]).toBeCloseTo((0.5 * Math.SQRT1_2) / (1 + 2 * Math.SQRT1_2), 3);
  });
});
