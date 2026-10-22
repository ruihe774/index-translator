// src/sat.ts without ONNX Runtime: the tokenizer on a small made-up vocabulary, and the windows a long
// text is read in, through a fake model. test/sat-native.test.ts runs the real ones.

import { describe, expect, test } from "bun:test";

import { findBoundaries, type RunModel, type TokenizerJson, XlmrTokenizer } from "../src/sat";

const SPECIAL = ["<s>", "<pad>", "</s>", "<unk>"];
const PIECES: [string, number][] = [
  ["▁", -3],
  ["▁a", -1],
  ["b", -1],
  ["▁ab", -1.5],
  ["▁abc", -9],
  ["c", -1],
  [".", -1],
  ["▁fi", -1],
  ["ﬁ", -0.1],
  ["لْ", -1],
  ["▁ا", -1],
  ["ق", -1],
  ["x", -1],
];
const json: TokenizerJson = {
  added_tokens: SPECIAL.map((content, id) => ({ id, content })),
  model: { unk_id: 3, vocab: [...SPECIAL.map((p): [string, number] => [p, 0]), ...PIECES] },
};
const tokenizer = new XlmrTokenizer(json);
const id = (piece: string) => SPECIAL.length + PIECES.findIndex(([p]) => p === piece);

describe("XlmrTokenizer", () => {
  test("splits each word, with its ▁, into the pieces of the best total score", () => {
    // ▁ab (-1.5) beats ▁a + b (-2); ▁abc (-9) loses to ▁ab + c (-2.5).
    expect(tokenizer.encode("ab abc")).toStrictEqual({
      ids: [id("▁ab"), id("▁ab"), id("c")],
      ends: [2, 5, 6],
    });
  });

  test("ends count UTF-16 units of the text as given, spaces and all", () => {
    expect(tokenizer.encode("  a.\tb ").ends).toStrictEqual([3, 4, 6, 6]);
  });

  test("a lone ▁ spans the first character of its word", () => {
    const { ids, ends } = tokenizer.encode("a x");
    expect(ids).toStrictEqual([id("▁a"), id("▁"), id("x")]);
    expect(ends).toStrictEqual([1, 3, 3]);
  });

  test("characters no piece starts with are one unknown token, fused", () => {
    const { ids, ends } = tokenizer.encode("a 😀😀b");
    expect(ids).toStrictEqual([id("▁a"), id("▁"), 3, id("b")]);
    expect(ends).toStrictEqual([1, 4, 6, 7]);
  });

  test("normalizes like the model's tokenizer: zero-width spaces split, controls vanish, NFKC", () => {
    expect(tokenizer.encode("a​ab").ids).toStrictEqual([id("▁a"), id("▁ab")]);
    expect(tokenizer.encode("a\u0007b").ids).toStrictEqual([id("▁ab")]);
    // The ligature becomes "fi"; both letters end where the ligature does.
    expect(tokenizer.encode("ﬁ")).toStrictEqual({ ids: [id("▁fi")], ends: [1] });
  });

  test("a vowel mark the normalizer leaves alone keeps its own position", () => {
    // "ال" + sukun + "ق": the token ending at the sukun ends after it, not after the cluster.
    const { ids, ends } = tokenizer.encode("الْق");
    expect(ids).toStrictEqual([id("▁ا"), id("لْ"), id("ق")]);
    expect(ends).toStrictEqual([1, 3, 4]);
  });

  test("refuses a tokenizer that is not Unigram", () => {
    expect(() => new XlmrTokenizer({ ...json, model: { ...json.model, type: "BPE" } })).toThrow("Unigram");
  });
});

/** A model that answers, for each token, a logit made from its id: its probability is then known. */
function fakeModel(logit: (tokenId: bigint) => number, calls: { rows: number; width: number }[] = []): RunModel {
  return (ids, mask, rows, width) => {
    calls.push({ rows, width });
    expect(ids).toHaveLength(rows * width);
    expect(mask).toHaveLength(rows * width);
    return Float32Array.from(ids, logit);
  };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

describe("findBoundaries", () => {
  test("gives each token's probability to the end of its span, leaving out the unlikely", () => {
    // "." is likely (logit 3), everything else not (-9).
    const run = fakeModel((t) => (t === BigInt(id(".")) ? 3 : -9));
    expect(findBoundaries(tokenizer, ["a. ab.", ""], run, 0.001)).toStrictEqual([
      { offsets: [2, 6], probabilities: [Number(sigmoid(3).toPrecision(3)), Number(sigmoid(3).toPrecision(3))] },
      { offsets: [], probabilities: [] },
    ]);
  });

  test("brackets each window with <s> and </s> and masks the padding", () => {
    const seen: { ids: bigint[]; mask: number[] }[] = [];
    const run: RunModel = (ids, mask, rows, width) => {
      for (let r = 0; r < rows; r++) {
        seen.push({
          ids: Array.from(ids.slice(r * width, (r + 1) * width)),
          mask: Array.from(mask.slice(r * width, (r + 1) * width)),
        });
      }
      return new Float32Array(rows * width);
    };
    // "ab c." is ▁ab, ▁, c, . (there is no "▁c"); the shorter window comes first.
    findBoundaries(tokenizer, ["ab c.", "ab"], run, 0.5);
    const big = (...pieces: string[]) => pieces.map((p) => BigInt(id(p)));
    expect(seen).toStrictEqual([
      { ids: [0n, ...big("▁ab"), 2n, 0n, 0n, 0n], mask: [1, 1, 1, 0, 0, 0] },
      { ids: [0n, ...big("▁ab", "▁", "c", "."), 2n], mask: [1, 1, 1, 1, 1, 1] },
    ]);
  });

  test("reads a long text in overlapping windows of 512 positions, 8 per run, and averages them", () => {
    // 1,200 tokens: windows start at 0, 256, 512 and (the last) 690.
    const text = Array.from({ length: 1200 }, () => "a").join(" ");
    const calls: { rows: number; width: number }[] = [];
    const out = findBoundaries(
      tokenizer,
      [text],
      fakeModel(() => 0, calls),
      0,
    );
    expect(calls).toStrictEqual([{ rows: 4, width: 512 }]);
    expect(out![0]!.offsets).toHaveLength(1200);
    expect(new Set(out![0]!.probabilities)).toStrictEqual(new Set([0.5]));
  });

  test("runs at most 8 windows at a time, each batch as wide as its longest", () => {
    const texts = Array.from({ length: 10 }, (_, i) => Array.from({ length: i + 1 }, () => "a").join(" "));
    const calls: { rows: number; width: number }[] = [];
    findBoundaries(
      tokenizer,
      texts,
      fakeModel(() => 0, calls),
      0.5,
    );
    expect(calls).toStrictEqual([
      { rows: 8, width: 10 },
      { rows: 2, width: 12 },
    ]);
  });

  test("stops between batches when asked to, answering nothing", () => {
    const texts = Array.from({ length: 20 }, () => "a.");
    const calls: { rows: number; width: number }[] = [];
    const out = findBoundaries(
      tokenizer,
      texts,
      fakeModel(() => 0, calls),
      0,
      () => calls.length >= 1,
    );
    expect(out).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
