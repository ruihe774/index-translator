import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { EmbedError, NativeEmbedder } from "../src/embed";
import { EMBED_MODEL_FILE } from "../src/models";

// Like the other engines, the embedder is not run against a real model here.
test("a missing model file is said, with how to fetch it", async () => {
  const embedder = new NativeEmbedder({
    modelsDir: "/nonexistent",
    llamaDir: join(resolve(import.meta.dir, ".."), "vendor", "llama.cpp"),
    embedThreads: 1,
  });
  const error = await embedder.embed(["hello"]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(EmbedError);
  expect((error as Error).message).toContain(join("/nonexistent", EMBED_MODEL_FILE));
  // Nothing to embed needs no model.
  await expect(embedder.embed([])).resolves.toStrictEqual([]);
});
