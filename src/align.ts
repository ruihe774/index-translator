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
// costs 1. The path with the least total distance wins.

import type { AlignedPair } from "./api";

/** The paper's settings. */
const MAX_GROUP = 4;
/** Weight of the neighbours' similarity (`c`). */
const NEIGHBOURS = 0.6;
/** Distance added per sentence in a group (`p`): cosine alone favours large groups. */
const PER_SENTENCE = 0.06;
/** Weight of the length distance (`w`). */
const LENGTH = 0.33;
/** Distance of a sentence matched with nothing. */
const UNMATCHED = 1;

/** The groups a step may take: [source sentences, target sentences]. */
const GROUPS: [number, number][] = [
  [0, 1],
  [1, 0],
  [1, 1],
  ...Array.from({ length: MAX_GROUP - 1 }, (_, k): [number, number][] => [
    [1, k + 2],
    [k + 2, 1],
  ]).flat(),
  [2, 2],
];

export interface Sentences {
  /** Unit vectors, one per sentence. */
  embeddings: Float32Array[];
  /** Length of each sentence in characters. */
  lengths: number[];
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, k) => from + k);

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

/** The best path through both texts, in order; every sentence of each is in exactly one pair. */
export function alignSentences(source: Sentences, target: Sentences): AlignedPair[] {
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
      return UNMATCHED * (a + b);
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
      GROUPS.forEach(([a, b], g) => {
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
    const [a, b] = GROUPS[step[i * width + j]!]!;
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
