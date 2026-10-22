import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { EMBED_MAX_TOKENS, EmbedError, NativeEmbedder } from "../src/embed";
import { libraryPath, shimPath } from "../src/llama-ffi";
import { EMBED_MODEL_FILE } from "../src/models";

const root = resolve(import.meta.dir, "..");
const llamaDir = join(root, "vendor", "llama.cpp");
const modelsDir = process.env.MODELS_DIR ?? join(root, "models");
const installed =
  existsSync(libraryPath(llamaDir)) && existsSync(shimPath(llamaDir)) && existsSync(join(modelsDir, EMBED_MODEL_FILE));

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

test("a missing model file is said, with how to fetch it", async () => {
  const embedder = new NativeEmbedder({ modelsDir: "/nonexistent", llamaDir, embedThreads: 1 });
  const error = await embedder.embed(["hello"]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(EmbedError);
  expect((error as Error).message).toContain(join("/nonexistent", EMBED_MODEL_FILE));
  // Nothing to embed needs no model.
  await expect(embedder.embed([])).resolves.toStrictEqual([]);
});

// Runs the real model; skipped without `bun scripts/build_llama.ts` and `bun scripts/fetch_models.ts --model bge-m3`
// (MODELS_DIR, as for the server, says where the GGUF is).
describe.skipIf(!installed)("NativeEmbedder with bge-m3", () => {
  const embedder = new NativeEmbedder({ modelsDir, llamaDir, embedThreads: 0 });

  test("vectors have length 1, and a sentence is closer to its translation than to another sentence", async () => {
    const [en, zh, other] = await embedder.embed([
      "The committee postponed the vote until next month.",
      "委员会把投票推迟到了下个月。",
      "Bake the bread for forty minutes at 220 degrees.",
    ]);
    expect(en!).toHaveLength(1024);
    expect(dot(en!, en!)).toBeCloseTo(1, 4);
    expect(dot(en!, zh!)).toBeGreaterThan(dot(en!, other!) + 0.2);
    expect(dot(zh!, other!)).toBeLessThan(dot(en!, zh!));
  });

  test("the same text gives the same vector, and special tokens in it are only text", async () => {
    const [a, b, c] = await embedder.embed(["plain text", "plain text", "<s>plain text</s>"]);
    expect(dot(a!, b!)).toBeCloseTo(1, 5);
    expect(dot(a!, c!)).toBeLessThan(1 - 1e-4);
  });

  test("a text longer than the limit is cut, not refused", async () => {
    const long = "A sentence of some length goes here. ".repeat(EMBED_MAX_TOKENS);
    const [v, prefix] = await embedder.embed([long, long.slice(0, 16_000)]);
    expect(dot(v!, v!)).toBeCloseTo(1, 4);
    // The cut falls inside both texts, so the model reads the same tokens of each.
    expect(dot(v!, prefix!)).toBeCloseTo(1, 3);
  });

  test("an aborted request rejects with the reason, and the next one is answered", async () => {
    const controller = new AbortController();
    const slow = embedder.embed(
      Array.from({ length: 50 }, (_, i) => `Sentence number ${i} of a long batch.`),
      controller.signal,
    );
    controller.abort(new Error("gone"));
    await expect(slow).rejects.toThrow("gone");
    expect((await embedder.embed(["after"]))[0]!).toHaveLength(1024);
  });

  test("unloading frees the model and the next request loads it again", async () => {
    await embedder.unload();
    expect((await embedder.embed(["again"]))[0]!).toHaveLength(1024);
    await embedder.unload();
  });
});
