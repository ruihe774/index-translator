// The real aligner: ONNX Runtime through bun:ffi on the segmentation worker, with LaBSE. Skipped unless
// both are installed (bun scripts/fetch_onnxruntime.ts; bun scripts/fetch_models.ts --model labse, or
// ALIGN_MODEL_DIR naming a directory with model.onnx, vocab.txt and dense.safetensors).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config";
import { WordPieceTokenizer } from "../src/labse";
import { libraryPath } from "../src/onnxruntime-ffi";
import { NativeSegmenter } from "../src/segment";

const cfg = { ...loadConfig(Bun.env), align: true, segmentIdleUnload: 0 };
const installed =
  existsSync(libraryPath(cfg.onnxruntimeDir)) &&
  ["model.onnx", "vocab.txt", "dense.safetensors"].every((f) => existsSync(join(cfg.alignModelDir, f)));

const segmenter = new NativeSegmenter(cfg);

afterAll(() => segmenter.stop());

/** The pairs as [source indexes, target indexes]. */
async function pairs(source: string[], target: string[], signal = new AbortController().signal) {
  return (await segmenter.align(source, target, signal)).map((p) => [p.source, p.target]);
}

describe.skipIf(!installed)("LaBSE on ONNX Runtime", () => {
  test("the tokenizer gives Hugging Face's ids", () => {
    const tokenizer = new WordPieceTokenizer(readFileSync(join(cfg.alignModelDir, "vocab.txt"), "utf8"));
    // From `tokenizers` with Xenova/LaBSE's tokenizer.json.
    const expected: [string, number[]][] = [
      ["Café société naïve: déjà vu.", [101, 38_824, 30_532, 14_977, 52_318, 15_479, 131, 25_367, 19_380, 119, 102]],
      ["猫坐在垫子上。", [101, 7946, 5093, 5078, 5128, 5449, 3890, 3641, 102]],
      ["Emoji 😀 and 👨‍👩‍👧 family.", [101, 225_653, 14_818, 14_999, 14_639, 499_035, 499_033, 18_882, 119, 102]],
      [
        "tab\there\nnew\rline\vvtab\fff\u0085nel nbsp　ideo",
        [101, 20_960, 16_651, 15_737, 17_740, 128_022, 21_767, 22_394, 35_719, 39_397, 85_863, 102],
      ],
      [
        "zero​width‍joiner﻿bom�repl\u0000nul",
        [101, 32_301, 152_743, 18_287, 15_799, 61_187, 102_304, 103_673, 171_072, 15_053, 102],
      ],
    ];
    for (const [text, ids] of expected) {
      expect({ text, ids: tokenizer.encode(text) }).toStrictEqual({ text, ids });
    }
  });

  test("loads on the first request; a translation pairs with its source", async () => {
    expect(segmenter.aligner.state).toBe("stopped");
    const source = [
      "The library reopened last month.",
      "It seats 214 visitors.",
      "Volunteers meet there on Thursdays.",
    ];
    const target = ["图书馆上个月重新开放。", "它可容纳214名访客。", "志愿者每周四在那里聚会。"];
    await expect(pairs(source, target)).resolves.toStrictEqual([
      [[0], [0]],
      [[1], [1]],
      [[2], [2]],
    ]);
    expect(segmenter.aligner.state).toBe("ready");
  });

  test("a sentence split in two in the translation is a 1-2 pair", async () => {
    const source = [
      "The storm closed the roads, so the delivery that was due on Monday arrived on Wednesday instead.",
      "Nobody complained.",
    ];
    const target = ["暴风雨封闭了道路。", "因此，原定周一送达的货物改在周三才到。", "没有人抱怨。"];
    await expect(pairs(source, target)).resolves.toStrictEqual([
      [[0], [0, 1]],
      [[1], [2]],
    ]);
  });

  // A sentence with no counterpart costs as much as a poor match, so the paper's distance joins it to
  // a neighbour's pair rather than leave it alone: only the pairs around it are certain.
  test("a sentence the translation left out does not shift the pairs after it", async () => {
    const source = [
      "Wir fuhren früh am Morgen los.",
      "Der Himmel war klar.",
      "Mein Bruder hatte die Karten vergessen, was wir erst an der Grenze bemerkten.",
      "Am Abend erreichten wir das Hotel.",
    ];
    const target = ["We left early in the morning.", "The sky was clear.", "In the evening we reached the hotel."];
    const got = await pairs(source, target);
    expect(got[0]).toStrictEqual([[0], [0]]);
    expect(got[1]).toStrictEqual([[1], [1]]);
    expect(got.at(-1)![0]).toContain(3);
    expect(got.at(-1)![1]).toStrictEqual([2]);
  });

  test("an abort is answered at once, and the next request still runs", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `Sentence ${i} is about something else entirely.`);
    await expect(segmenter.align(many, many, AbortSignal.timeout(5))).rejects.toThrow();
    await expect(pairs(["Yes."], ["Oui."])).resolves.toStrictEqual([[[0], [0]]]);
  });
});
