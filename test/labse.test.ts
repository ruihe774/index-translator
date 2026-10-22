// LaBSE's tokenizer and pooling without the model: a small vocabulary, and a made-up encoder.
// test/labse-native.test.ts checks the real vocabulary against Hugging Face's ids.

import { describe, expect, test } from "bun:test";

import { type Dense, DIMENSIONS, embed, readDense, WordPieceTokenizer } from "../src/labse";

const VOCAB = [
  "[PAD]",
  "[UNK]",
  "[CLS]",
  "[SEP]",
  "un",
  "##aff",
  "##able",
  "play",
  "##ing",
  ",",
  ".",
  "猫",
  "Café",
  "あ",
  "##い",
].join("\n");

const tokenizer = new WordPieceTokenizer(VOCAB);
const id = (token: string) => VOCAB.split("\n").indexOf(token);

describe("WordPieceTokenizer", () => {
  test("words: white space and punctuation split, CJK ideographs stand alone, case and accents kept", () => {
    expect(WordPieceTokenizer.words("Café, unaffable猫猫 あい.")).toStrictEqual([
      "Café",
      ",",
      "unaffable",
      "猫",
      "猫",
      "あい",
      ".",
    ]);
  });

  test("control characters are dropped and join what is around them; tab and line ends are white space", () => {
    expect(WordPieceTokenizer.words("a\u0000b​c\vd\te\nf　g")).toStrictEqual(["abcd", "e", "f", "g"]);
  });

  test("encode: greedy longest pieces from the start, [CLS] before and [SEP] after", () => {
    expect(tokenizer.encode("unaffable playing.")).toStrictEqual([
      id("[CLS]"),
      id("un"),
      id("##aff"),
      id("##able"),
      id("play"),
      id("##ing"),
      id("."),
      id("[SEP]"),
    ]);
  });

  test("a word with any part no piece matches is one [UNK], as is one of more than 100 characters", () => {
    expect(tokenizer.encode("unaffx play")).toStrictEqual([id("[CLS]"), id("[UNK]"), id("play"), id("[SEP]")]);
    expect(tokenizer.encode("un".repeat(51))).toStrictEqual([id("[CLS]"), id("[UNK]"), id("[SEP]")]);
  });

  test("a long text is cut to the model's 512 positions", () => {
    const ids = tokenizer.encode("play ".repeat(600));
    expect(ids).toHaveLength(512);
    expect(ids.at(-1)).toBe(id("[SEP]"));
  });

  test("a vocabulary without the special tokens is refused", () => {
    expect(() => new WordPieceTokenizer("a\nb")).toThrow("[CLS]");
  });
});

/** A safetensors file holding `tensors`, as sentence-transformers writes the pooling layer. */
function safetensors(tensors: Record<string, { shape: number[]; data: Float32Array }>): Uint8Array {
  let offset = 0;
  const header: Record<string, unknown> = {};
  for (const [name, { shape, data }] of Object.entries(tensors)) {
    header[name] = { dtype: "F32", shape, data_offsets: [offset, offset + data.byteLength] };
    offset += data.byteLength;
  }
  // An odd header length, so the data does not start on a multiple of 4.
  const json = new TextEncoder().encode(`${JSON.stringify(header)} `);
  const out = new Uint8Array(8 + json.length + offset);
  new DataView(out.buffer).setBigUint64(0, BigInt(json.length), true);
  out.set(json, 8);
  let at = 8 + json.length;
  for (const { data } of Object.values(tensors)) {
    out.set(new Uint8Array(data.buffer), at);
    at += data.byteLength;
  }
  return out;
}

/** The identity as the pooling layer, with no bias: the embedding is tanh of the [CLS] state, normalized. */
const identity: Dense = {
  weight: new Float32Array(DIMENSIONS * DIMENSIONS).map((_, k) => (k % (DIMENSIONS + 1) === 0 ? 1 : 0)),
  bias: new Float32Array(DIMENSIONS),
};

describe("readDense", () => {
  test("reads the weight and bias, wherever the data starts", () => {
    const bias = new Float32Array(DIMENSIONS).map((_, k) => k / 10);
    const file = safetensors({
      "linear.bias": { shape: [DIMENSIONS], data: bias },
      "linear.weight": { shape: [DIMENSIONS, DIMENSIONS], data: identity.weight },
    });
    const dense = readDense(file);
    expect(dense.bias).toStrictEqual(bias);
    expect(dense.weight).toStrictEqual(identity.weight);
  });

  test("a file of another shape is refused", () => {
    const file = safetensors({ "linear.weight": { shape: [2, 2], data: new Float32Array(4) } });
    expect(() => readDense(file)).toThrow("linear.weight");
  });
});

describe("embed", () => {
  test("pools each text's first token in batches, shortest first, padded with a mask; vectors come back in order", () => {
    const texts = Array.from({ length: 20 }, (_, k) => "play ".repeat(k + 1));
    const batches: { rows: number; width: number; masked: number }[] = [];
    const vectors = embed(tokenizer, identity, texts, (ids, mask, rows, width) => {
      batches.push({ rows, width, masked: mask.filter((m) => m === 0n).length });
      // The [CLS] state of each row says how many tokens it has: on axis 0, (tokens) / 100.
      const out = new Float32Array(rows * width * DIMENSIONS);
      for (let row = 0; row < rows; row++) {
        let tokens = 0;
        for (let k = 0; k < width; k++) {
          tokens += Number(mask[row * width + k]);
        }
        out[row * width * DIMENSIONS] = tokens / 100;
        out[row * width * DIMENSIONS + 1] = 0.5;
      }
      return out;
    })!;
    expect(batches.map((b) => [b.rows, b.width])).toStrictEqual([
      [16, 18],
      [4, 22],
    ]);
    // In the first batch, row k holds k + 3 tokens of 18.
    expect(batches[0]!.masked).toBe(Array.from({ length: 16 }, (_, k) => 18 - (k + 3)).reduce((a, b) => a + b));
    expect(vectors).toHaveLength(20);
    vectors.forEach((v, k) => {
      const a = Math.tanh((k + 3) / 100);
      const b = Math.tanh(0.5);
      expect(v[0]).toBeCloseTo(a / Math.hypot(a, b), 6);
      expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    });
  });

  test("an abort between batches gives no answer", () => {
    let runs = 0;
    const texts = Array.from({ length: 40 }, () => "play");
    const out = embed(
      tokenizer,
      identity,
      texts,
      (_ids, _mask, rows, width) => {
        runs++;
        return new Float32Array(rows * width * DIMENSIONS);
      },
      () => runs >= 1,
    );
    expect(out).toBeUndefined();
    expect(runs).toBe(1);
  });
});
