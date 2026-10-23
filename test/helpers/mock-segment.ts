// Stands in for SaT (`POST /segment`) and for LaBSE with the aligner's DP (`POST /align`): punctuation
// decides, see `mockBoundaries` and `mockPairs`. Module state: restore it with resetMockSegment(),
// which also resets the aligner.

import type { AlignedPair, AlignUnit, SegmentedText } from "../../src/api";
import { SegmentError, type SegmentLauncher, type SegmentState } from "../../src/segment";
import { delay } from "./harness";

export const mockSegment = {
  /** What `state` reports; "unavailable" makes requests fail as when nothing is installed. */
  state: "stopped" as SegmentState,
  delayMs: 0,
  /** Makes a request fail as when the model cannot run. */
  failWith: undefined as string | undefined,
  /** Every request's texts. */
  requests: [] as string[][],
  aborted: 0,
};

export const mockAlign = {
  /** What the aligner's `state` reports; "unavailable" makes requests fail as when nothing is installed. */
  state: "stopped" as SegmentState,
  /** The answer to give instead of `mockPairs`. */
  pairs: undefined as AlignedPair[] | undefined,
  /** Every request's unit and items. */
  requests: [] as { unit: AlignUnit; source: string[]; target: string[] }[],
};

export function resetMockSegment(): void {
  mockSegment.state = "stopped";
  mockSegment.delayMs = 0;
  mockSegment.failWith = undefined;
  mockSegment.requests.length = 0;
  mockSegment.aborted = 0;
  mockAlign.state = "stopped";
  mockAlign.pairs = undefined;
  mockAlign.requests.length = 0;
}

/**
 * What the mock aligner answers: item i with item i, and what is left over of the longer side joined to
 * the last pair (sentences) or alone, with no counterpart (paragraphs, as the model leaves a dropped one).
 */
export function mockPairs(sourceCount: number, targetCount: number, unit: AlignUnit = "sentences"): AlignedPair[] {
  const shared = Math.min(sourceCount, targetCount);
  const pairs = Array.from({ length: shared }, (_, i) => ({ source: [i], target: [i], similarity: 0.8 }));
  if (unit === "paragraphs") {
    for (let i = shared; i < sourceCount; i++) {
      pairs.push({ source: [i], target: [], similarity: 0 });
    }
    for (let i = shared; i < targetCount; i++) {
      pairs.push({ source: [], target: [i], similarity: 0 });
    }
    return pairs;
  }
  const last = pairs.at(-1)!;
  for (let i = shared; i < sourceCount; i++) {
    last.source.push(i);
  }
  for (let i = shared; i < targetCount; i++) {
    last.target.push(i);
  }
  return pairs;
}

/** Sentence punctuation with what may close it, then a space or the end; and clause punctuation. */
const MOCK_SENTENCE_END = /[.!?。！？…]["'”’)）」』】]*(?=\s|$)/gu;
const MOCK_CLAUSE_END = /[,;:，、；：]/gu;

/**
 * What the mock model answers for one text: 0.95 after sentence punctuation, 0.01 after clause
 * punctuation, as SaT roughly does on punctuated text.
 */
export function mockBoundaries(text: string): SegmentedText {
  const found = new Map<number, number>();
  for (const m of text.matchAll(MOCK_CLAUSE_END)) {
    found.set(m.index + m[0].length, 0.01);
  }
  for (const m of text.matchAll(MOCK_SENTENCE_END)) {
    found.set(m.index + m[0].length, 0.95);
  }
  const offsets = [...found.keys()].sort((a, b) => a - b);
  return { offsets, probabilities: offsets.map((o) => found.get(o)!) };
}

export const segmentLauncher: SegmentLauncher = () => ({
  get state() {
    return mockSegment.state;
  },
  get error() {
    return mockSegment.state === "unavailable" ? "the segmentation model is not installed" : undefined;
  },
  async segment(texts, signal) {
    mockSegment.requests.push(texts);
    await delay(mockSegment.delayMs, signal);
    if (signal.aborted) {
      mockSegment.aborted++;
      signal.throwIfAborted();
    }
    if (mockSegment.failWith) {
      throw new SegmentError(mockSegment.failWith);
    }
    mockSegment.state = "ready";
    return texts.map(mockBoundaries);
  },
  aligner: {
    get state() {
      return mockAlign.state;
    },
    get error() {
      return mockAlign.state === "unavailable" ? "the alignment model is not installed" : undefined;
    },
  },
  async align(unit, source, target, signal) {
    mockAlign.requests.push({ unit, source, target });
    await delay(mockSegment.delayMs, signal);
    signal.throwIfAborted();
    if (mockSegment.failWith) {
      throw new SegmentError(mockSegment.failWith);
    }
    mockAlign.state = "ready";
    return mockAlign.pairs ?? mockPairs(source.length, target.length, unit);
  },
  async stop() {},
});
