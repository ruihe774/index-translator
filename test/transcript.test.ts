// The engine-free parts of a transcription (src/transcript.ts): cutting silence, mapping times back,
// reading MOSS's output as it is written, and the loop guard.

import { describe, expect, test } from "bun:test";

import {
  cutAudio,
  cutPlan,
  LoopGuard,
  maxTokens,
  musicRegions,
  musicWindows,
  SegmentReader,
  splice,
  toOriginal,
} from "../src/transcript";

const RATE = 100;

describe("cutPlan", () => {
  test("a recording that is mostly speech is transcribed whole", () => {
    // 30% silence is not more than TRIM_SILENCE_SHARE.
    expect(cutPlan([[0, 700]], 1000, RATE)).toBeUndefined();
  });

  test("one where Silero heard nothing is transcribed whole too (it may miss singing)", () => {
    expect(cutPlan([], 1000, RATE)).toBeUndefined();
  });

  test("long silences are cut out: speech padded by 0.2 s, joined by 0.5 s", () => {
    expect(
      cutPlan(
        [
          [100, 200],
          [1000, 1100],
        ],
        2000,
        RATE,
      ),
    ).toStrictEqual([
      { from: 80, to: 220, at: 0 },
      { from: 980, to: 1120, at: 190 },
    ]);
  });

  test("stretches closer than the joining silence stay one piece, gap and all", () => {
    expect(
      cutPlan(
        [
          [100, 200],
          [250, 300],
          [1800, 1900],
        ],
        2000,
        RATE,
      ),
    ).toStrictEqual([
      { from: 80, to: 320, at: 0 },
      { from: 1780, to: 1920, at: 290 },
    ]);
  });
});

describe("cutAudio and toOriginal", () => {
  const plan = [
    { from: 80, to: 220, at: 0 },
    { from: 980, to: 1120, at: 190 },
  ];

  test("the pieces are laid out with silence between them", () => {
    const samples = Float32Array.from({ length: 2000 }, (_, i) => i);
    const cut = cutAudio(samples, plan);
    expect(cut).toHaveLength(330);
    expect([cut[0], cut[139], cut[140], cut[189], cut[190], cut[329]]).toStrictEqual([80, 219, 0, 0, 980, 1119]);
  });

  test("times inside a piece map back; times in a joining silence go to the nearer edge", () => {
    expect(toOriginal(0, plan, RATE)).toBe(0.8);
    expect(toOriginal(1, plan, RATE)).toBe(1.8);
    expect(toOriginal(1.45, plan, RATE)).toBe(2.2);
    expect(toOriginal(1.85, plan, RATE)).toBe(9.8);
    expect(toOriginal(2, plan, RATE)).toBe(9.9);
    expect(toOriginal(5, plan, RATE)).toBe(11.2);
    expect(toOriginal(3, [], RATE)).toBe(3);
  });
});

describe("SegmentReader", () => {
  test("a segment is answered once the next one begins, or at the end", () => {
    const reader = new SegmentReader();
    const text = "[0.00][S01]Hello there.[1.52][1.60][S02]こんにちは[3.00]";
    // A piece at a time, cut wherever: here every UTF-16 unit, as MOSS's pieces are cut anywhere.
    const got = Array.from({ length: text.length }, (_, i) => reader.push(text.charAt(i))).flat();
    expect(got).toStrictEqual([{ start: 0, end: 1.52, speaker: "S01", text: "Hello there." }]);
    expect(reader.end()).toStrictEqual([{ start: 1.6, end: 3, speaker: "S02", text: "こんにちは" }]);
    expect(reader.end()).toStrictEqual([]);
  });

  test("an empty or backwards segment is dropped", () => {
    const reader = new SegmentReader();
    reader.push("[1.0][S01] [2.0][3.0][S01]x[2.5][4][S02]ok[5]");
    expect(reader.end()).toStrictEqual([{ start: 4, end: 5, speaker: "S02", text: "ok" }]);
  });
});

describe("SegmentReader runaway", () => {
  test("a segment still open after 1,000 characters never ends", () => {
    const reader = new SegmentReader();
    reader.push(`[0.00][S01]${"x".repeat(50)}[3.00][3.10][S02]ひ`);
    expect(reader.runaway).toBe(false);
    reader.push("ー".repeat(1000));
    expect(reader.runaway).toBe(true);
  });
});

describe("LoopGuard", () => {
  const s = (start: number, text = "la") => ({ start, end: start + 1, speaker: "S01", text });

  test("the same text six times in a row is a loop", () => {
    const guard = new LoopGuard(100);
    expect([1, 2, 3, 4, 5].map((t) => guard.looping(s(t)))).toStrictEqual([false, false, false, false, false]);
    expect(guard.looping(s(6))).toBe(true);
  });

  test("a different text in between starts the count again", () => {
    const guard = new LoopGuard(100);
    for (let t = 0; t < 5; t++) {
      expect(guard.looping(s(t))).toBe(false);
    }
    expect(guard.looping(s(5, "ah"))).toBe(false);
    expect(guard.looping(s(6))).toBe(false);
  });

  test("a segment starting well past the end of the recording is made up", () => {
    const guard = new LoopGuard(10);
    expect(guard.looping(s(11.5, "a"))).toBe(false);
    expect(guard.looping(s(12.5, "b"))).toBe(true);
  });
});

test("the token budget grows with the recording: about 20,300 for 30 minutes", () => {
  expect(maxTokens(0)).toBe(512);
  expect(maxTokens(1800)).toBe(20_312);
});

describe("music detection", () => {
  test("windows are 10 s every 5 s, the last one ending with the recording", () => {
    expect(musicWindows(23 * RATE, RATE)).toStrictEqual([
      [0, 1000],
      [500, 1500],
      [1000, 2000],
      [1300, 2300],
    ]);
    expect(musicWindows(20 * RATE, RATE)).toStrictEqual([
      [0, 1000],
      [500, 1500],
      [1000, 2000],
    ]);
    expect(musicWindows(1800 * RATE, RATE)).toHaveLength(359);
    // A short recording is one window of its own length; under a second, none.
    expect(musicWindows(4 * RATE, RATE)).toStrictEqual([[0, 400]]);
    expect(musicWindows(RATE - 1, RATE)).toStrictEqual([]);
  });

  const total = 600 * RATE;
  const windows = musicWindows(total, RATE);
  /** CED's scores with music in the windows starting at the given seconds. */
  const scored = (...starts: number[]) => windows.map(([s]) => (starts.includes(s / RATE) ? 0.6 : 0.05));

  test("no music, nothing separated; speech alone stays under the threshold", () => {
    expect(musicRegions(windows, scored(), total, RATE)).toStrictEqual([]);
    expect(
      musicRegions(
        windows,
        windows.map(() => 0.29),
        total,
        RATE,
      ),
    ).toStrictEqual([]);
  });

  test("windows with music are separated, padded by 2 s", () => {
    expect(musicRegions(windows, scored(100, 105), total, RATE)).toStrictEqual([[98 * RATE, 117 * RATE]]);
  });

  test("stretches less than 8 s apart are joined, farther ones kept apart", () => {
    // 98..112 and 118..132: 6 s apart.
    expect(musicRegions(windows, scored(100, 120), total, RATE)).toStrictEqual([[98 * RATE, 132 * RATE]]);
    expect(musicRegions(windows, scored(100, 200), total, RATE)).toStrictEqual([
      [98 * RATE, 112 * RATE],
      [198 * RATE, 212 * RATE],
    ]);
  });

  test("a short gap at either end of the recording is separated too", () => {
    expect(musicRegions(windows, scored(5, 590), total, RATE)).toStrictEqual([
      [0, 17 * RATE],
      [588 * RATE, total],
    ]);
  });

  test("music throughout is the whole recording", () => {
    expect(
      musicRegions(
        windows,
        windows.map(() => 0.7),
        total,
        RATE,
      ),
    ).toStrictEqual([[0, total]]);
  });
});

describe("splice", () => {
  test("the vocals replace the samples, faded in and out over 0.5 s inside the stretch", () => {
    const samples = new Float32Array(1000).fill(1);
    splice(samples, 200, new Float32Array(300), RATE);
    expect(samples[199]).toBe(1);
    expect(samples[200]).toBeCloseTo(0.99);
    expect(samples[224]).toBeCloseTo(0.51);
    expect(samples.subarray(250, 450).every((x) => x === 0)).toBe(true);
    expect(samples[499]).toBeCloseTo(0.99);
    expect(samples[500]).toBe(1);
  });

  test("no fade at the recording's own edges, and vocals past its end are dropped", () => {
    const samples = new Float32Array(100).fill(1);
    splice(samples, 0, new Float32Array(40), RATE);
    expect(samples[0]).toBe(0);
    splice(samples, 60, new Float32Array(80), RATE);
    expect(samples[99]).toBe(0);
    expect(samples[60]).toBeCloseTo(0.98);
  });
});
