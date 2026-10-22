// The alignment search on made-up embeddings: each sentence is a unit vector along its "meaning", so
// cosines are known exactly.

import { describe, expect, test } from "bun:test";

import { alignSentences, OPENING, openings, type Sentences } from "../src/align";

const DIMS = 16;

/** A unit vector mixing the given axes equally (a sentence that says those things). */
function meaning(...axes: number[]): Float32Array {
  const v = new Float32Array(DIMS);
  for (const a of axes) {
    v[a] = 1;
  }
  const norm = Math.sqrt(axes.length);
  return v.map((x) => x / norm);
}

/** Sentences by their axes, each `length` characters long. */
const side = (meanings: number[][], length = 40): Sentences => ({
  embeddings: meanings.map((axes) => meaning(...axes)),
  lengths: meanings.map(() => length),
});

const pairsOf = (source: Sentences, target: Sentences) =>
  alignSentences(source, target).map((p) => [p.source, p.target]);

describe("alignSentences", () => {
  test("one to one, in order", () => {
    expect(pairsOf(side([[0], [1], [2]]), side([[0], [1], [2]]))).toStrictEqual([
      [[0], [0]],
      [[1], [1]],
      [[2], [2]],
    ]);
  });

  test("a sentence split in two is one pair with both halves", () => {
    const source = { embeddings: [meaning(0), meaning(1, 2), meaning(3)], lengths: [40, 80, 40] };
    expect(pairsOf(source, side([[0], [1], [2], [3]]))).toStrictEqual([
      [[0], [0]],
      [[1], [1, 2]],
      [[2], [3]],
    ]);
  });

  test("two joined into one, on the source side", () => {
    const target = { embeddings: [meaning(0, 1), meaning(2)], lengths: [80, 40] };
    expect(pairsOf(side([[0], [1], [2]]), target)).toStrictEqual([
      [[0, 1], [0]],
      [[2], [1]],
    ]);
  });

  test("every sentence of both sides is in exactly one pair, in order", () => {
    const source = side([[0], [1], [2, 3], [4], [5], [6]]);
    const target = side([[0], [1], [2], [3], [5], [6], [7]]);
    const pairs = alignSentences(source, target);
    expect(pairs.flatMap((p) => p.source)).toStrictEqual([0, 1, 2, 3, 4, 5]);
    expect(pairs.flatMap((p) => p.target)).toStrictEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const p of pairs) {
      expect(p.source.length + p.target.length).toBeGreaterThan(0);
      expect(p.source.length <= 4 && p.target.length <= 4).toBe(true);
    }
  });

  test("a group pair's similarity is the cosine of the summed embeddings; an empty side has 0", () => {
    const [pair] = alignSentences(side([[0]]), side([[0], [0, 1]]));
    expect(pair).toStrictEqual({ source: [0], target: [0, 1], similarity: 0.924 });
    // Six sentences against one: a group holds at most four, so some stand alone.
    const lone = alignSentences(side([[0], [1], [2], [3], [4], [5]]), side([[0]]));
    expect(lone.some((p) => p.target.length === 0 && p.similarity === 0)).toBe(true);
  });

  test("one sentence on each side is one pair, whatever they say", () => {
    expect(pairsOf(side([[0]]), side([[1]]))).toStrictEqual([[[0], [0]]]);
  });
});

describe("paragraphs", () => {
  // Openings that half resemble the neighbours, as related paragraphs of one document do.
  const near = (k: number) => [k, 8 + (k % 4)];
  const paragraphs = (ks: number[], lengths?: number[]): Sentences => ({
    embeddings: ks.map((k) => meaning(...near(k))),
    lengths: lengths ?? ks.map(() => 600),
  });

  test("a paragraph the translation left out stands alone; as sentences it joins a neighbour", () => {
    const source = paragraphs([0, 1, 2, 3, 4]);
    const target = paragraphs([0, 1, 3, 4]);
    const shapes = (unit: "sentences" | "paragraphs") =>
      alignSentences(source, target, unit).map((p) => [p.source, p.target]);
    expect(shapes("paragraphs")).toStrictEqual([
      [[0], [0]],
      [[1], [1]],
      [[2], []],
      [[3], [2]],
      [[4], [3]],
    ]);
    expect(shapes("sentences").some(([s]) => s!.length === 2)).toBe(true);
  });

  test("two merged into one: the opening is the first one's, the length is both", () => {
    const source = paragraphs([0, 1, 2, 3]);
    const target = paragraphs([0, 1, 3], [600, 1200, 600]);
    expect(alignSentences(source, target, "paragraphs").map((p) => [p.source, p.target])).toStrictEqual([
      [[0], [0]],
      [[1, 2], [1]],
      [[3], [2]],
    ]);
  });
});

describe("openings", () => {
  test("the source's first OPENING characters, back to a space when the cut is inside a word", () => {
    const words = Array.from({ length: 40 }, (_, k) => `w${k}`).join(" ");
    const { source } = openings([words], [words]);
    expect(source[0]!.length).toBeLessThanOrEqual(OPENING);
    expect(words.startsWith(source[0]!)).toBe(true);
    expect(words[source[0]!.length]).toBe(" ");
  });

  test("text without spaces is cut where it is; a short paragraph is whole", () => {
    const { source } = openings(["字".repeat(200), "短。"], ["x"]);
    expect(source).toStrictEqual(["字".repeat(OPENING), "短。"]);
  });

  test("the target's opening is scaled by the texts' length ratio, within bounds", () => {
    const zh = "字".repeat(300);
    const en = "x".repeat(1000);
    expect(openings([zh], [en]).target[0]).toHaveLength(Math.round(OPENING * (1000 / 300)));
    expect(openings(["x".repeat(10_000)], ["y".repeat(10)]).target[0]).toHaveLength(10);
    expect(openings(["x".repeat(100)], ["y".repeat(10_000)]).target[0]).toHaveLength(OPENING * 4);
  });
});
