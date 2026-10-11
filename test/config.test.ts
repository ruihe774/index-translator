import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { CONTEXT_MARGIN, loadConfig } from "../src/config";
import { DEFAULT_MODEL_ID } from "../src/models";

const root = resolve(import.meta.dir, "..");

describe("loadConfig defaults", () => {
  test("empty environment yields the documented defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      publicDir: join(root, "public"),
      specPath: join(root, "docs", "openapi.yaml"),
      modelsDir: join(root, "models"),
      defaultModel: DEFAULT_MODEL_ID,
      llamaDir: join(root, "vendor", "llama.cpp"),
      gpuLayers: -1,
      threads: 0,
      ctxSize: 65536,
      maxInputTokens: 28000,
      maxQueue: 8,
      allowedOrigins: [],
      allowedHosts: [],
      openBrowser: true,
    });
  });

  test("OPEN_BROWSER=0 disables the browser", () => {
    expect(loadConfig({ OPEN_BROWSER: "0" }).openBrowser).toBe(false);
    expect(loadConfig({ OPEN_BROWSER: "1" }).openBrowser).toBe(true);
  });

  test("empty values fall back to the defaults", () => {
    const cfg = loadConfig({ PORT: "", CTX_SIZE: "" });
    expect(cfg.port).toBe(3000);
    expect(cfg.ctxSize).toBe(65536);
  });

  test("valid overrides are applied", () => {
    const cfg = loadConfig({ HOST: "0.0.0.0", PORT: "8080", LLAMA_THREADS: "8", CTX_SIZE: "4096", MAX_INPUT_TOKENS: "2000", MAX_QUEUE: "100000" });
    expect(cfg).toMatchObject({ host: "0.0.0.0", port: 8080, threads: 8, ctxSize: 4096, maxInputTokens: 2000, maxQueue: 100000 });
  });

  test("the environment record is read, not process.env", () => {
    const before = Bun.env.CTX_SIZE;
    expect(loadConfig({ CTX_SIZE: "2048", MAX_INPUT_TOKENS: "100" }).ctxSize).toBe(2048);
    expect(Bun.env.CTX_SIZE).toBe(before);
  });

  test("the default model can be chosen by name", () => {
    expect(loadConfig({ DEFAULT_MODEL: "index-nailong-9b" }).defaultModel).toBe("index-nailong-9b");
  });
});

describe("loadConfig rejections", () => {
  test("an unknown DEFAULT_MODEL is rejected", () => {
    expect(() => loadConfig({ DEFAULT_MODEL: "no-such-model" })).toThrow('DEFAULT_MODEL "no-such-model" is not a known model');
  });

  test("CTX_SIZE below 1 is rejected", () => {
    expect(() => loadConfig({ CTX_SIZE: "0" })).toThrow("CTX_SIZE must be an integer of at least 1");
  });

  test("MAX_INPUT_TOKENS below 1 is rejected", () => {
    expect(() => loadConfig({ MAX_INPUT_TOKENS: "0" })).toThrow("MAX_INPUT_TOKENS must be an integer of at least 1");
  });

  test("non-integers and negatives are still rejected", () => {
    expect(() => loadConfig({ CTX_SIZE: "1.5" })).toThrow("CTX_SIZE must be an integer");
    expect(() => loadConfig({ MAX_QUEUE: "-1" })).toThrow("MAX_QUEUE must be an integer");
    expect(() => loadConfig({ PORT: "abc" })).toThrow("PORT must be an integer");
  });

  test("PORT above 65535 is rejected, 65535 is accepted", () => {
    expect(() => loadConfig({ PORT: "65536" })).toThrow("PORT must be at most 65535");
    expect(loadConfig({ PORT: "65535" }).port).toBe(65535);
  });

  test("GPU_LAYERS is a layer count or all; anything else is rejected", () => {
    expect(loadConfig({ GPU_LAYERS: "all" }).gpuLayers).toBe(-1);
    expect(loadConfig({ GPU_LAYERS: "" }).gpuLayers).toBe(-1);
    expect(loadConfig({ GPU_LAYERS: "0" }).gpuLayers).toBe(0);
    expect(loadConfig({ GPU_LAYERS: "20" }).gpuLayers).toBe(20);
    expect(() => loadConfig({ GPU_LAYERS: "auto" })).toThrow('GPU_LAYERS must be an integer of at least 0, got "auto"');
    expect(() => loadConfig({ GPU_LAYERS: "-1" })).toThrow("GPU_LAYERS must be an integer of at least 0");
  });

  test("LLAMA_THREADS must be a non-negative integer; 0 leaves the choice to the engine", () => {
    expect(loadConfig({ LLAMA_THREADS: "0" }).threads).toBe(0);
    expect(() => loadConfig({ LLAMA_THREADS: "many" })).toThrow("LLAMA_THREADS must be an integer");
  });

  test("MAX_INPUT_TOKENS must leave room for the margin and output", () => {
    // With CTX_SIZE 1000 the largest prompt is 1000 - 64 - 1 = 935 tokens.
    expect(loadConfig({ CTX_SIZE: "1000", MAX_INPUT_TOKENS: "935" }).maxInputTokens).toBe(935);
    expect(() => loadConfig({ CTX_SIZE: "1000", MAX_INPUT_TOKENS: "936" })).toThrow(
      "MAX_INPUT_TOKENS must be at most 935 for CTX_SIZE=1000",
    );
  });

  test("the default MAX_INPUT_TOKENS is rejected when CTX_SIZE is set alone and small", () => {
    expect(() => loadConfig({ CTX_SIZE: "4096" })).toThrow("MAX_INPUT_TOKENS must be at most 4031 for CTX_SIZE=4096");
  });

  test("a CTX_SIZE too small for any prompt is rejected with the minimum", () => {
    expect(() => loadConfig({ CTX_SIZE: "65", MAX_INPUT_TOKENS: "1" })).toThrow(
      `CTX_SIZE must be at least ${CONTEXT_MARGIN + 2}, got 65`,
    );
    expect(loadConfig({ CTX_SIZE: "66", MAX_INPUT_TOKENS: "1" }).ctxSize).toBe(66);
  });
});

describe("loadConfig PUBLIC_DIR", () => {
  test("a trailing slash is dropped", () => {
    expect(loadConfig({ PUBLIC_DIR: "/srv/site/" }).publicDir).toBe("/srv/site");
    expect(loadConfig({ PUBLIC_DIR: "/srv/site///" }).publicDir).toBe("/srv/site");
  });

  test("a relative path is made absolute against the working directory", () => {
    expect(loadConfig({ PUBLIC_DIR: "site" }).publicDir).toBe(resolve("site"));
    expect(loadConfig({ PUBLIC_DIR: "./site/" }).publicDir).toBe(resolve("site"));
  });

  test("an empty value falls back to the bundled public directory", () => {
    expect(loadConfig({ PUBLIC_DIR: "" }).publicDir).toBe(join(root, "public"));
  });
});

describe("loadConfig LLAMA_DIR", () => {
  test("a relative path is made absolute, since the library is opened by path", () => {
    expect(loadConfig({ LLAMA_DIR: "build/bin/" }).llamaDir).toBe(resolve("build/bin"));
  });

  test("an empty value falls back to the vendored build", () => {
    expect(loadConfig({ LLAMA_DIR: "" }).llamaDir).toBe(join(root, "vendor", "llama.cpp"));
  });
});
