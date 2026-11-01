// A transcript's cues timed for reading, as subtitle timers time them. The constants were measured
// against the Japanese tracks of two fansub teams (six anime episodes, 716 lines matched to MOSS's
// segments): MOSS starts a segment on its speech but ends it about 0.13 s after, which is where the timers
// end their lines too, so only the start is moved earlier. With a video, an edge near a cut moves onto it
// (timers snap to keyframes), and lines a hair apart are joined. Pure: tested by bun test
// (test/cue-timing.test.ts).
//
// - A cue starts LEAD earlier; its end stays.
// - A start moves back onto a cut up to START_SNAP before the segment's start, never later than it.
// - An end moves onto a cut from END_SNAP_BEFORE before the segment's end to END_SNAP_AFTER after it, but
//   not onto one that leaves the cue shorter than MIN_SNAPPED.
// - Two cues less than LINK_GAP apart after that meet: on a cut between the segments, else halfway
//   between them. Segments that overlap (two speakers) are left as they are. (One team joined lines up to
//   about 0.2 s apart, the other up to 0.4 s: the smaller is kept.)
// - A keyframe is taken for a cut unless it ends an interval of the file's longest length, when that
//   length comes at least FORCED_RUNS times: encoders force one there (x265 every 10 s), and a file with
//   keyframes at fixed intervals has nothing but those, so nothing to snap to.
// - Edges on a cut are written half a frame before it, as Aegisub writes them, so that rounding to
//   milliseconds never moves one onto the frame before or after.

/** A cue's times in seconds. */
export interface Span {
  start: number;
  end: number;
}

export const LEAD = 0.075;
export const START_SNAP = 0.17;
export const END_SNAP_BEFORE = 0.17;
export const END_SNAP_AFTER = 0.2;
export const MIN_SNAPPED = 0.3;
export const LINK_GAP = 0.15;
export const FORCED_RUNS = 3;
/** Where a cut is written before its keyframe when the file does not say how long a frame is. */
const UNKNOWN_FRAME_SHIFT = 0.001;

/**
 * Where the cuts are, as cue times: the keyframes (seconds, any order) that are not forced, each moved
 * half a frame (`frameSeconds`) earlier. Sorted.
 */
export function cutsOf(keyframes: readonly number[], frameSeconds?: number): number[] {
  const times = [...new Set(keyframes)].sort((a, b) => a - b);
  // Intervals that differ by less than half a frame hold as many frames (timestamps are rounded).
  const tolerance = frameSeconds === undefined ? 0.002 : frameSeconds / 2;
  const intervals = times.slice(1).map((t, i) => t - times[i]!);
  const longest = Math.max(...intervals);
  const forced = (i: number) => longest - intervals[i]! < tolerance;
  const recurs = intervals.filter((_, i) => forced(i)).length >= FORCED_RUNS;
  const shift = frameSeconds === undefined ? UNKNOWN_FRAME_SHIFT : frameSeconds / 2;
  return times.filter((_, i) => i === 0 || !recurs || !forced(i - 1)).map((t) => t - shift);
}

/** The cut in [lo, hi] nearest to `aim`, if any; `cuts` sorted. */
function cutNear(cuts: readonly number[], lo: number, hi: number, aim: number): number | undefined {
  let best: number | undefined;
  for (const c of cuts) {
    if (c > hi) {
      break;
    }
    if (c >= lo && (best === undefined || Math.abs(c - aim) < Math.abs(best - aim))) {
      best = c;
    }
  }
  return best;
}

/** The segments' spans (in their order) timed for reading; `cuts` from `cutsOf`, empty without a video. */
export function timeCues(spans: readonly Span[], cuts: readonly number[]): Span[] {
  const out = spans.map((r) => {
    const padded = Math.max(0, r.start - LEAD);
    const start = cutNear(cuts, r.start - START_SNAP, r.start, padded) ?? padded;
    const end = cutNear(cuts, Math.max(r.end - END_SNAP_BEFORE, r.start + MIN_SNAPPED), r.end + END_SNAP_AFTER, r.end);
    return { start, end: Math.max(end ?? r.end, start) };
  });
  for (let i = 0; i + 1 < spans.length; i++) {
    const a = spans[i]!;
    const b = spans[i + 1]!;
    if (b.start < a.end || out[i + 1]!.start - out[i]!.end >= LINK_GAP) {
      continue;
    }
    const aim = (a.end + b.start) / 2;
    const at = cutNear(cuts, a.end, b.start, aim) ?? aim;
    out[i]!.end = at;
    out[i + 1]!.start = at;
  }
  return out;
}
