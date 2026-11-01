import { describe, expect, test } from "bun:test";

import { cutsOf, type Span, timeCues } from "../public/cue-timing";

/** Spans in whole milliseconds, to compare without float noise. */
const ms = (spans: Span[]) => spans.map((s) => [Math.round(s.start * 1000), Math.round(s.end * 1000)]);
const at = (start: number, end: number): Span => ({ start, end });

describe("timeCues", () => {
  test("without a video: starts 75 ms early, ends as they were, never before 0", () => {
    expect(ms(timeCues([at(0.03, 1), at(3, 4.5)], []))).toStrictEqual([
      [0, 1000],
      [2925, 4500],
    ]);
  });

  test("a start moves back onto a cut up to 170 ms before it, never forward", () => {
    expect(ms(timeCues([at(10, 12)], [9.85]))).toStrictEqual([[9850, 12_000]]);
    expect(ms(timeCues([at(10, 12)], [9.95]))).toStrictEqual([[9950, 12_000]]);
    expect(ms(timeCues([at(10, 12)], [9.8]))).toStrictEqual([[9925, 12_000]]);
    expect(ms(timeCues([at(10, 12)], [10.04]))).toStrictEqual([[9925, 12_000]]);
  });

  test("an end moves onto a cut from 170 ms before it to 200 ms after, the nearest", () => {
    expect(ms(timeCues([at(10, 12)], [11.85]))).toStrictEqual([[9925, 11_850]]);
    expect(ms(timeCues([at(10, 12)], [12.19]))).toStrictEqual([[9925, 12_190]]);
    expect(ms(timeCues([at(10, 12)], [11.9, 12.05]))).toStrictEqual([[9925, 12_050]]);
    expect(ms(timeCues([at(10, 12)], [11.8, 12.25]))).toStrictEqual([[9925, 12_000]]);
  });

  test("an end does not move onto a cut that leaves the cue shorter than 300 ms", () => {
    expect(ms(timeCues([at(10, 10.4)], [10.25]))).toStrictEqual([[9925, 10_400]]);
    expect(ms(timeCues([at(10, 10.4)], [10.35]))).toStrictEqual([[9925, 10_350]]);
    // Later is always fine.
    expect(ms(timeCues([at(10, 10.2)], [10.3]))).toStrictEqual([[9925, 10_300]]);
  });

  test("cues less than 150 ms apart meet halfway between the segments, or on a cut between them", () => {
    // 150 ms apart: the second would start 75 ms after the first ends.
    expect(ms(timeCues([at(1, 2), at(2.15, 3)], []))).toStrictEqual([
      [925, 2075],
      [2075, 3000],
    ]);
    // 220 ms apart: 145 ms once the second starts early, so they still meet.
    expect(ms(timeCues([at(1, 2), at(2.22, 3)], []))).toStrictEqual([
      [925, 2110],
      [2110, 3000],
    ]);
    // 230 ms apart: 155 ms is left open.
    expect(ms(timeCues([at(1, 2), at(2.23, 3)], []))).toStrictEqual([
      [925, 2000],
      [2155, 3000],
    ]);
    // A cut between them is where they meet.
    expect(ms(timeCues([at(1, 2), at(2.15, 3)], [2.02]))).toStrictEqual([
      [925, 2020],
      [2020, 3000],
    ]);
  });

  test("an end snapped past the next start makes them meet; overlapping segments are left alone", () => {
    // The first end would go onto the cut at 2.48 s, past the second's start: they meet halfway instead.
    expect(ms(timeCues([at(1, 2.3), at(2.45, 3)], [2.48]))).toStrictEqual([
      [925, 2375],
      [2375, 3000],
    ]);
    expect(ms(timeCues([at(1, 2.5), at(2, 3)], []))).toStrictEqual([
      [925, 2500],
      [1925, 3000],
    ]);
  });
});

describe("cutsOf", () => {
  const frame = 1001 / 24_000;

  test("keyframes half a frame earlier, sorted, without duplicates", () => {
    expect(cutsOf([3.003, 0, 3.003, 1.5], frame).map((t) => Math.round(t * 1e4) / 1e4)).toStrictEqual([
      -0.0209, 1.4791, 2.9821,
    ]);
    // Without a frame duration, a millisecond.
    expect(cutsOf([2, 1])).toStrictEqual([0.999, 1.999]);
  });

  test("keyframes forced at the longest interval are not cuts; a fixed interval leaves none but the first", () => {
    // Cuts at 1.2 and 4 s; x265 forces one 10.01 s after the last (14.01), and again and again.
    const shift = (ts: number[]) => ts.map((t) => Math.round((t - frame / 2) * 1000) / 1000);
    const round = (ts: number[]) => ts.map((t) => Math.round(t * 1000) / 1000);
    expect(round(cutsOf([0, 1.2, 4, 14.01, 24.02, 34.03, 35.5], frame))).toStrictEqual(shift([0, 1.2, 4, 35.5]));
    // The longest only twice may be two long shots: kept.
    expect(round(cutsOf([0, 1.2, 4, 14.01, 24.02, 25], frame))).toStrictEqual(shift([0, 1.2, 4, 14.01, 24.02, 25]));
    // Every 2 s (timestamps in whole milliseconds): only the start of the file.
    expect(round(cutsOf([0, 2.002, 4.004, 6.006, 8.008], frame))).toStrictEqual(shift([0]));
  });

  test("one keyframe, or none", () => {
    expect(cutsOf([], frame)).toStrictEqual([]);
    expect(cutsOf([5])).toStrictEqual([4.999]);
  });
});
