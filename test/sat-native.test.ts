// The real segmenter: ONNX Runtime through bun:ffi on its worker, with the SaT model. Skipped unless
// both are installed (bun scripts/fetch_onnxruntime.ts; bun scripts/fetch_models.ts --model sat-3l-sm,
// or SEGMENT_MODEL_DIR naming a directory with model.onnx and tokenizer.json).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config";
import { libraryPath } from "../src/onnxruntime-ffi";
import { NativeSegmenter } from "../src/segment";

const cfg = { ...loadConfig(Bun.env), segment: true, segmentIdleUnload: 0 };
const installed =
  existsSync(libraryPath(cfg.onnxruntimeDir)) &&
  ["model.onnx", "tokenizer.json"].every((f) => existsSync(join(cfg.segmentModelDir, f)));

const segmenter = new NativeSegmenter(cfg);

afterAll(() => segmenter.stop());

/** The text before each offset the model gives more than `p`, as a list of sentences' ends. */
async function endsAbove(text: string, p = 0.5): Promise<string[]> {
  const [b] = await segmenter.segment([text], new AbortController().signal);
  return b!.offsets.filter((_, i) => b!.probabilities[i]! > p).map((o) => text.slice(0, o));
}

describe.skipIf(!installed)("SaT on ONNX Runtime", () => {
  test("loads on the first request", async () => {
    expect(segmenter.state).toBe("stopped");
    await endsAbove("One.");
    expect(segmenter.state).toBe("ready");
  });

  test("abbreviations and decimals are not sentence ends", async () => {
    const text = "Dr. Smith arrived at 3.5 p.m. on Monday. The meeting began at once.";
    await expect(endsAbove(text)).resolves.toStrictEqual(["Dr. Smith arrived at 3.5 p.m. on Monday.", text]);
  });

  test("finds sentences that punctuation or capitals do not mark", async () => {
    await expect(endsAbove("it was done. then we left for the station")).resolves.toContain("it was done.");
    await expect(endsAbove("No punctuation here but two sentences The second one starts here")).resolves.toContain(
      "No punctuation here but two sentences",
    );
    await expect(endsAbove("今天天气很好。我们去公园吧！")).resolves.toStrictEqual([
      "今天天气很好。",
      "今天天气很好。我们去公园吧！",
    ]);
  });

  test("answers every text, blank ones with nothing, offsets in UTF-16 units", async () => {
    const texts = ["😀 The first sentence is here. The second one follows it.", "  ", "Three."];
    const out = await segmenter.segment(texts, new AbortController().signal);
    expect(out).toHaveLength(3);
    expect(out[1]).toStrictEqual({ offsets: [], probabilities: [] });
    // The model takes a leading emoji for a sentence of its own: the offset after it is 2 (a surrogate pair).
    const ends = out[0]!.offsets.filter((_, i) => out[0]!.probabilities[i]! > 0.5);
    expect(ends.slice(0, 2).map((o) => texts[0]!.slice(0, o))).toStrictEqual(["😀", "😀 The first sentence is here."]);
  });

  test("a long text is read in windows and still answered whole", async () => {
    const text = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const ends = await endsAbove(text);
    expect(ends.length).toBeGreaterThan(250);
    expect(ends.at(-1)).toBe(text);
  });

  test("an abort is answered at once, and the next request still runs", async () => {
    const texts = Array.from({ length: 200 }, (_, i) => `Text ${i}. `.repeat(40));
    await expect(segmenter.segment(texts, AbortSignal.timeout(20))).rejects.toThrow();
    await expect(endsAbove("After. That.")).resolves.toStrictEqual(["After.", "After. That."]);
  });
});
