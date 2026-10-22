// The sentences of a group of text (`text-groups.ts`), for marking the one the pointer is over
// (`sentence-hover.ts`). Positions are UTF-16 units of the group's text. Where its sentences end is the
// sentence model's answer for the text (`POST /segment`) once there is one, else `Intl.Segmenter`'s.
// Pure, and generic over what a text node is, so that it needs no DOM.

import type { SegmentedText } from "../src/api.ts";
import { modelProbabilities } from "./speech-text.ts";

/** One piece of a group's text, in a node of type `N`: the group's text from `start` to `end`. */
export interface Run<N> {
  node: N;
  start: number;
  end: number;
}

/**
 * The node and offset where position `offset` of the group's text begins (`edge` "start") or ends
 * ("end") a range: a newline written for a `<br>` has no node, so a range starts after it and ends before it.
 */
export function locate<N>(runs: Run<N>[], offset: number, edge: "start" | "end"): { node: N; offset: number } | null {
  if (edge === "start") {
    const run = runs.find((r) => r.end > offset);
    return run ? { node: run.node, offset: Math.max(0, offset - run.start) } : null;
  }
  const run = runs.findLast((r) => r.start < offset);
  return run ? { node: run.node, offset: Math.min(run.end - run.start, offset - run.start) } : null;
}

/** A sentence ends where the model says it more likely than not does (the cut `sat-native.test.ts` uses). */
export const SENTENCE_END_PROBABILITY = 0.5;

/** [from, to) without the white space at either end; none when nothing else is left. */
function trimmed(text: string, from: number, to: number): [number, number] | null {
  const piece = text.slice(from, to);
  const start = from + (piece.length - piece.trimStart().length);
  const end = from + piece.trimEnd().length;
  return end > start ? [start, end] : null;
}

/** The sentences of `text` by `Intl.Segmenter`, as [start, end) in UTF-16 units, without the white space around them. */
function intlSpans(text: string, lang: string | undefined): [number, number][] {
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(lang || undefined, { granularity: "sentence" });
  } catch {
    // A language tag the browser does not know.
    segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  }
  // A line break inside a paragraph does not end its sentence, which the segmenter would take it for
  // (the same length, so positions stay).
  return Array.from(segmenter.segment(text.replaceAll("\n", " ")))
    .map(({ index, segment }) => trimmed(text, index, index + segment.length))
    .filter((span) => span !== null);
}

/** The sentences of `text` by what the sentence model says, read as reading aloud reads it. */
function modelSpans(text: string, lang: string, answer: SegmentedText): [number, number][] {
  const p = modelProbabilities(text, lang, answer);
  const spans: [number, number][] = [];
  let from = 0;
  for (let k = 0; k < p.length; k++) {
    // Not between the halves of a surrogate pair, which a Chinese answer may name.
    if (p[k]! >= SENTENCE_END_PROBABILITY && !(isHighSurrogate(text, k) && isLowSurrogate(text, k + 1))) {
      const span = trimmed(text, from, k + 1);
      if (span) {
        spans.push(span);
      }
      from = k + 1;
    }
  }
  const last = trimmed(text, from, text.length);
  return last ? [...spans, last] : spans;
}

const isHighSurrogate = (text: string, k: number) => /[\uD800-\uDBFF]/.test(text[k] ?? "");
const isLowSurrogate = (text: string, k: number) => /[\uDC00-\uDFFF]/.test(text[k] ?? "");

/**
 * The sentences of `text` (in language `lang`), as [start, end) in UTF-16 units, without the white space
 * around them: those the sentence model's `answer` gives when there is one, else `Intl.Segmenter`'s. The
 * answer is read by the language (no cut inside a word, but in Chinese and Japanese), so without one it is
 * not used: a Chinese text read as English would have no cut at all.
 */
export function sentenceSpans(text: string, lang: string | undefined, answer?: SegmentedText): [number, number][] {
  return answer && lang ? modelSpans(text, lang, answer) : intlSpans(text, lang);
}

/**
 * The sentences a caret at `offset` may mean, best first: the one it is inside, then the one it follows
 * (a caret on the right half of a sentence's last character sits at its end).
 */
export function spansAt(spans: [number, number][], offset: number): [number, number][] {
  const inside = spans.filter(([start, end]) => start <= offset && offset < end);
  const after = spans.filter(([, end]) => end === offset);
  return [...inside, ...after.filter((s) => !inside.includes(s))];
}
