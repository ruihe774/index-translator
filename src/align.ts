// Sentence alignment of a source and its translation, from their sentence embeddings: the dynamic
// programming step of AIlign as its paper describes it (Kraif, "Adaptative Bilingual Aligning Using
// Multilingual Sentence Embedding", 2024, arXiv:2403.11921, section 3.3). The paper's first step, anchor
// points found from the density of good matches, pays off over whole books; here the texts are one
// block and its translation, a few sentences each, so the search runs over the whole of them.
//
// A path is a sequence of groups: 1-0, 0-1, 1-1, 1-n and n-1 up to `MAX_GROUP`, and 2-2. A group's
// embedding is the sum of its sentences' (no sentence is encoded twice). A group pair's distance is
//   d = (1 - w) · (1 - cos + c · neighbours + p · size) + w · (1 - log2(1 + shorter / longer))
// times its size (the number of sentences in it), where `neighbours` is the mean cosine of each group
// with the sentences just before and after the other (a pair that matches its neighbours as well is
// less sure), and lengths are in characters, the source's scaled by the texts' ratio. An empty side
// costs 1 per sentence. The path with the least total distance wins.
//
// The same search matches the paragraphs of a document and its translation, each read by its opening
// (`openings`) and weighed by the length of what it translates (`translatedLengths`: its words, without
// those the other text has too). Length is then what tells a merged paragraph (its opening is the first
// one's, its length both) from a dropped one; an empty side costs less, 0.7: at 1 a paragraph the
// translation left out is joined to a neighbour, as a sentence is, and the neighbour is often the wrong
// one; and there is no 2-2 group. Measured with one paragraph dropped, merged, split or repeated, on 12
// machine translations of long prose (en to zh, ja, es, de, fr, ko, and zh to en) and on 32 of short
// Markdown documents with headings, tables, code and lists (en to zh, ja, fr, de): 97% and 84% of the
// cases matched exactly, and 99% and 98% put every group but at most one next to the damage right (a
// short paragraph left out is often told as merged into its neighbour); no clean translation flagged.
// Below 0.7 clean Markdown translations were flagged (8 of 32 at 0.6), above it fewer drops were found;
// whole lengths instead of translated ones made 66% exact on the Markdown documents, as did allowing 2-2
// (two short neighbours, a heading and its paragraph, came out as one 2-2 group in clean translations).

import type { AlignedPair, AlignUnit } from "./api";

/** The paper's settings. */
const MAX_GROUP = 4;
/** Weight of the neighbours' similarity (`c`). */
const NEIGHBOURS = 0.6;
/** Distance added per sentence in a group (`p`): cosine alone favours large groups. */
const PER_SENTENCE = 0.06;
/** Weight of the length distance (`w`). */
const LENGTH = 0.33;
/** Distance of an item matched with nothing, by unit. */
const UNMATCHED: Record<AlignUnit, number> = { sentences: 1, paragraphs: 0.7 };
/** Characters of a source paragraph's opening; the target's is scaled by the texts' length ratio. */
export const OPENING = 80;
/** Bounds of a target opening: a ratio far from 1 should not leave it a word or the whole paragraph. */
const OPENING_RANGE = [OPENING / 4, OPENING * 4] as const;

/**
 * The groups a step may take, [source items, target items], by unit. Paragraphs have no 2-2: a translation
 * rarely moves the boundary between two paragraphs, and two short ones (a heading and its paragraph) were
 * taken for one 2-2 group in clean translations, because each resembles its neighbour as much as itself.
 */
const SENTENCE_GROUPS: [number, number][] = [
  [0, 1],
  [1, 0],
  [1, 1],
  ...Array.from({ length: MAX_GROUP - 1 }, (_, k): [number, number][] => [
    [1, k + 2],
    [k + 2, 1],
  ]).flat(),
  [2, 2],
];
const GROUPS: Record<AlignUnit, [number, number][]> = {
  sentences: SENTENCE_GROUPS,
  paragraphs: SENTENCE_GROUPS.filter(([a, b]) => a !== 2 || b !== 2),
};

export interface Sentences {
  /** Unit vectors, one per sentence. */
  embeddings: Float32Array[];
  /** Length of each sentence in characters. */
  lengths: number[];
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, k) => from + k);

/** Length in characters (code points), as the search weighs it. */
export const lengthOf = (text: string) => Array.from(text.trim()).length;

/**
 * The first `n` characters of `text`, cut back to white space when that falls inside a word and there is
 * white space in the second half (so text without spaces, such as Chinese, is cut where it is).
 */
function opening(text: string, n: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= n) {
    return chars.join("");
  }
  const cut = chars.slice(0, n);
  if (/\s/u.test(chars[n]!)) {
    return cut.join("");
  }
  const space = cut.findLastIndex((c) => /\s/u.test(c));
  return (space > n / 2 ? cut.slice(0, space) : cut).join("");
}

/** A run of Latin letters and digits, or of letters of other scripts (so "在Linux上" holds "Linux"). */
const WORD = /[\p{Script=Latin}\p{N}]+|(?:(?!\p{Script=Latin})\p{L})+/gu;

/**
 * Each paragraph's length as the search weighs it: the characters of its words, without those the other
 * text has as well. What a translation copies (names, numbers, code, most of a table) is then left out
 * of both sides, so it does not make the length ratio of prose wrong for the paragraphs that hold it.
 */
export function translatedLengths(source: string[], target: string[]): { source: number[]; target: number[] } {
  const words = (texts: string[]) => texts.map((t) => t.match(WORD) ?? []);
  const [s, t] = [words(source), words(target)];
  const [inSource, inTarget] = [new Set(s.flat()), new Set(t.flat())];
  const length = (list: string[], other: Set<string>) =>
    list.filter((w) => !other.has(w)).reduce((n, w) => n + Array.from(w).length, 0);
  return { source: s.map((list) => length(list, inTarget)), target: t.map((list) => length(list, inSource)) };
}

/** What is embedded of each paragraph: the source's first `OPENING` characters, the target's as many as say as much. */
export function openings(source: string[], target: string[]): { source: string[]; target: string[] } {
  const total = (texts: string[]) => texts.reduce((n, t) => n + lengthOf(t), 0);
  const ratio = total(target) / (total(source) || 1) || 1;
  const n = Math.round(Math.min(Math.max(OPENING * ratio, OPENING_RANGE[0]), OPENING_RANGE[1]));
  return { source: source.map((t) => opening(t, OPENING)), target: target.map((t) => opening(t, n)) };
}

/** The sum of `count` vectors from `from`, normalized to length 1. */
function groupVector(vectors: Float32Array[], from: number, count: number): Float32Array {
  const out = new Float32Array(vectors[from]!.length);
  for (let k = from; k < from + count; k++) {
    const v = vectors[k]!;
    for (let d = 0; d < out.length; d++) {
      out[d]! += v[d]!;
    }
  }
  let norm = 0;
  for (const x of out) {
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < out.length; d++) {
    out[d]! /= norm;
  }
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let d = 0; d < a.length; d++) {
    sum += a[d]! * b[d]!;
  }
  return sum;
}

/** `1 - log2(1 + shorter / longer)`: 0 for equal lengths, 1 when one is empty. */
function lengthDistance(a: number, b: number): number {
  const longer = Math.max(a, b);
  return longer === 0 ? 0 : 1 - Math.log2(1 + Math.min(a, b) / longer);
}

/** The best path through both texts, in order; every item of each is in exactly one pair. */
export function alignSentences(source: Sentences, target: Sentences, unit: AlignUnit = "sentences"): AlignedPair[] {
  const unmatched = UNMATCHED[unit];
  const groups = GROUPS[unit];
  const n = source.embeddings.length;
  const m = target.embeddings.length;
  const sourceChars = source.lengths.reduce((a, b) => a + b, 0);
  const targetChars = target.lengths.reduce((a, b) => a + b, 0);
  const ratio = sourceChars > 0 && targetChars > 0 ? targetChars / sourceChars : 1;

  // Group vectors by size and first sentence, and the cosines of every pair of them a step can ask for:
  // the groups themselves, and a group with a single sentence beside the other.
  const vectors = (side: Sentences, count: number) =>
    range(0, Math.max(0, side.embeddings.length - count + 1)).map((i) => groupVector(side.embeddings, i, count));
  const sourceGroups = range(0, MAX_GROUP + 1).map((a) => (a === 0 ? [] : vectors(source, a)));
  const targetGroups = range(0, MAX_GROUP + 1).map((b) => (b === 0 ? [] : vectors(target, b)));
  const cosines = new Map<string, Float32Array>();
  /** cos(source group of `a` from `i`, target group of `b` from `j`). */
  const cos = (a: number, i: number, b: number, j: number): number => {
    const key = `${a},${b}`;
    let table = cosines.get(key);
    if (!table) {
      table = new Float32Array(n * m).fill(NaN);
      cosines.set(key, table);
    }
    const at = i * m + j;
    if (Number.isNaN(table[at]!)) {
      table[at] = dot(sourceGroups[a]![i]!, targetGroups[b]![j]!);
    }
    return table[at]!;
  };
  const sumLengths = (lengths: number[], from: number, count: number) =>
    lengths.slice(from, from + count).reduce((x, y) => x + y, 0);

  /** Distance of source sentences [i, i + a) with target sentences [j, j + b). */
  const distance = (i: number, a: number, j: number, b: number): number => {
    if (a === 0 || b === 0) {
      return unmatched * (a + b);
    }
    const similarity = cos(a, i, b, j);
    const around: number[] = [];
    if (i > 0) {
      around.push(cos(1, i - 1, b, j));
    }
    if (i + a < n) {
      around.push(cos(1, i + a, b, j));
    }
    if (j > 0) {
      around.push(cos(a, i, 1, j - 1));
    }
    if (j + b < m) {
      around.push(cos(a, i, 1, j + b));
    }
    const neighbours = around.length > 0 ? around.reduce((x, y) => x + y, 0) / around.length : 0;
    const embedding = 1 - similarity + NEIGHBOURS * neighbours + PER_SENTENCE * (a + b);
    const length = lengthDistance(sumLengths(source.lengths, i, a) * ratio, sumLengths(target.lengths, j, b));
    return ((1 - LENGTH) * embedding + LENGTH * length) * (a + b);
  };

  // cost[i][j]: the least distance of a path through the first i source and j target sentences.
  const width = m + 1;
  const cost = new Float64Array((n + 1) * width).fill(Infinity);
  const step = new Int8Array((n + 1) * width).fill(-1);
  cost[0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) {
        continue;
      }
      groups.forEach(([a, b], g) => {
        if (a > i || b > j) {
          return;
        }
        const total = cost[(i - a) * width + j - b]! + distance(i - a, a, j - b, b);
        if (total < cost[i * width + j]!) {
          cost[i * width + j] = total;
          step[i * width + j] = g;
        }
      });
    }
  }

  const pairs: AlignedPair[] = [];
  for (let i = n, j = m; i > 0 || j > 0;) {
    const [a, b] = groups[step[i * width + j]!]!;
    i -= a;
    j -= b;
    pairs.unshift({
      source: range(i, a),
      target: range(j, b),
      similarity: a > 0 && b > 0 ? Math.round(cos(a, i, b, j) * 1000) / 1000 : 0,
    });
  }
  return pairs;
}
