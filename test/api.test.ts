// API tests against a mock llama-server, so they run without a GPU or model.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { startApp, type App } from "../src/app";
import type { Config } from "../src/config";

const root = resolve(import.meta.dir, "..");

// The mock tokenizer counts one token per character and the chat template adds TEMPLATE.length tokens.
const TEMPLATE = "<user></user>";

const mock = {
  ready: true,
  chunks: ["<think>\n\n</think>\n\n", "Hello", ", ", "world", "\n"],
  delayMs: 0,
  finish: "stop",
  failWith: undefined as string | undefined,
  requests: [] as any[],
  aborted: 0,
};

const sse = (data: unknown) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return Response.json({ status: mock.ready ? "ok" : "loading" }, { status: mock.ready ? 200 : 503 });
    if (path === "/apply-template") return Response.json({ prompt: TEMPLATE });
    if (path === "/tokenize") {
      const { content } = (await req.json()) as { content: string };
      return Response.json({ tokens: Array.from(content, (_, i) => i) });
    }
    if (path === "/v1/chat/completions") {
      const body = (await req.json()) as any;
      mock.requests.push(body);
      const { chunks, delayMs, finish, failWith } = mock;
      req.signal.addEventListener("abort", () => mock.aborted++);
      return new Response(
        (async function* () {
          for (const content of chunks) {
            if (delayMs) await Bun.sleep(delayMs);
            yield sse({ choices: [{ delta: { content }, finish_reason: null }] });
          }
          if (failWith) {
            yield sse({ error: { message: failWith } });
            return;
          }
          yield sse({ choices: [{ delta: {}, finish_reason: finish }] });
          yield sse({
            choices: [],
            usage: { prompt_tokens: 42, completion_tokens: chunks.length },
            timings: { prompt_ms: 12.4, predicted_ms: 99.6, predicted_per_second: 70.123 },
          });
          yield sse("[DONE]");
        })(),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response("not found", { status: 404 });
  },
});

function config(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    publicDir: join(root, "public"),
    specPath: join(root, "docs", "openapi.yaml"),
    modelPath: "/nonexistent/model.gguf",
    modelName: "mock-model",
    llamaBin: "/nonexistent/llama-server",
    llamaUrl: `http://127.0.0.1:${upstream.port}`,
    llamaPort: 0,
    gpuLayers: "all",
    llamaExtraArgs: [],
    ctxSize: 1000,
    maxInputTokens: 400,
    maxQueue: 1,
    ...overrides,
  };
}

async function waitReady(app: App): Promise<void> {
  for (let i = 0; i < 100 && app.engine.state !== "ready"; i++) await Bun.sleep(20);
  expect(app.engine.state).toBe("ready");
}

let app: App;
let base: string;

beforeAll(async () => {
  app = await startApp(config());
  base = app.server.url.origin;
  await waitReady(app);
});

afterAll(async () => {
  await app.stop();
  await upstream.stop(true);
});

function post(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(base + path, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
}

interface SseEvent {
  event: string;
  data: any;
}

async function readSse(res: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for (const frame of (await res.text()).split("\n\n")) {
    const event = /^event: (.*)$/m.exec(frame)?.[1];
    const data = /^data: (.*)$/m.exec(frame)?.[1];
    if (event && data) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

describe("metadata endpoints", () => {
  test("health reports engine state, limits and queue", async () => {
    const res = await fetch(base + "/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ready",
      model: "mock-model",
      limits: { context_tokens: 1000, max_input_tokens: 400 },
      queue: { running: false, waiting: 0, max_waiting: 1 },
    });
  });

  test("languages lists codes and names", async () => {
    const { languages } = (await (await fetch(base + "/api/v1/languages")).json()) as any;
    expect(languages).toContainEqual({ code: "zh", name: "Chinese" });
    expect(languages.length).toBeGreaterThan(30);
  });

  test("the OpenAPI document is served", async () => {
    const res = await fetch(base + "/api/v1/openapi.yaml");
    expect(res.status).toBe(200);
    expect(await res.text()).toStartWith("openapi: 3.1");
  });

  test("unknown endpoints and wrong methods use the error envelope", async () => {
    const missing = await fetch(base + "/api/v1/nope");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("not_found");

    const wrong = await fetch(base + "/api/v1/translate");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    expect(((await wrong.json()) as any).error.code).toBe("method_not_allowed");
  });
});

describe("POST /tokenize", () => {
  test("counts prompt tokens including the chat template", async () => {
    const res = await post("/api/v1/tokenize", { text: "Hello", target_lang: "zh" });
    expect(res.status).toBe(200);
    const promptChars = "请将以下文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\nHello".length;
    expect(await res.json()).toEqual({
      prompt_tokens: promptChars + TEMPLATE.length,
      fits: true,
      max_output_tokens: 1000 - promptChars - TEMPLATE.length - 64,
      limits: { context_tokens: 1000, max_input_tokens: 400 },
    });
  });

  test("reports inputs that do not fit instead of failing", async () => {
    const body = (await (await post("/api/v1/tokenize", { text: "x".repeat(500), target_lang: "zh" })).json()) as any;
    expect(body.fits).toBe(false);
  });
});

describe("POST /translate (JSON)", () => {
  test("returns the cleaned translation with usage and timings", async () => {
    mock.requests.length = 0;
    const res = await post("/api/v1/translate", { text: "你好，世界", target_lang: "en", max_output_tokens: 50 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      translation: "Hello, world",
      finish_reason: "stop",
      model: "mock-model",
      usage: { prompt_tokens: 42, completion_tokens: 5 },
      timings: { queue_ms: expect.any(Number), prompt_ms: 12, generation_ms: 100, tokens_per_second: 70.12 },
    });

    const sent = mock.requests[0];
    expect(sent.messages).toEqual([
      { role: "user", content: "请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n你好，世界" },
    ]);
    expect(sent.temperature).toBe(0);
    expect(sent.max_tokens).toBe(50);
  });

  test("the output budget defaults to a multiple of the prompt and never exceeds the context", async () => {
    mock.requests.length = 0;
    await post("/api/v1/translate", { text: "Hi", target_lang: "zh" });
    const short = mock.requests[0].messages[0].content.length + TEMPLATE.length;
    expect(mock.requests[0].max_tokens).toBe(short * 4 + 512);

    await post("/api/v1/translate", { text: "x".repeat(300), target_lang: "zh" });
    const long = mock.requests[1].messages[0].content.length + TEMPLATE.length;
    expect(mock.requests[1].max_tokens).toBe(1000 - long - 64);

    await post("/api/v1/translate", { text: "Hi", target_lang: "zh", max_output_tokens: 5000 });
    expect(mock.requests[2].max_tokens).toBe(1000 - short - 64);
  });

  test("reports truncation through finish_reason", async () => {
    mock.finish = "length";
    const body = (await (await post("/api/v1/translate", { text: "Hi", target_lang: "zh" })).json()) as any;
    mock.finish = "stop";
    expect(body.finish_reason).toBe("length");
  });

  test.each([
    ["not json", "{", undefined],
    ["array body", [], undefined],
    ["missing text", { target_lang: "zh" }, "text"],
    ["blank text", { text: "  ", target_lang: "zh" }, "text"],
    ["missing target", { text: "Hi" }, "target_lang"],
    ["bad glossary", { text: "Hi", target_lang: "zh", glossary: ["a"] }, "glossary"],
    ["bad glossary value", { text: "Hi", target_lang: "zh", glossary: { a: 1 } }, "glossary"],
    ["bad constraints", { text: "Hi", target_lang: "zh", hard_constraints: "x" }, "hard_constraints"],
    ["bad output cap", { text: "Hi", target_lang: "zh", max_output_tokens: 0 }, "max_output_tokens"],
    ["bad stream flag", { text: "Hi", target_lang: "zh", stream: "yes" }, "stream"],
  ])("rejects %s with 400", async (_name, body, field) => {
    const res = await post("/api/v1/translate", body);
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as any;
    expect(error.code).toBe("invalid_request");
    expect(error.details?.field).toBe(field);
  });

  test("rejects oversized input with 413 and the measured token counts", async () => {
    const res = await post("/api/v1/translate", { text: "x".repeat(500), target_lang: "zh" });
    expect(res.status).toBe(413);
    const { error } = (await res.json()) as any;
    expect(error.code).toBe("input_too_long");
    expect(error.details.max_input_tokens).toBe(400);
    expect(error.details.prompt_tokens).toBeGreaterThan(500);
  });

  test("rejects an oversized body with 413 and the error envelope", async () => {
    const res = await post("/api/v1/translate", JSON.stringify({ text: "a".repeat(5 * 1024 * 1024), target_lang: "zh" }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.code).toBe("body_too_large");
  });

  test("surfaces engine failures as 502", async () => {
    mock.failWith = "out of memory";
    const res = await post("/api/v1/translate", { text: "Hi", target_lang: "zh" });
    mock.failWith = undefined;
    expect(res.status).toBe(502);
    const { error } = (await res.json()) as any;
    expect(error.code).toBe("engine_error");
    expect(error.message).toContain("out of memory");
  });
});

describe("POST /translate (SSE)", () => {
  test("streams start, delta and done events", async () => {
    const res = await post("/api/v1/translate", { text: "你好", target_lang: "en", stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");

    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual(["start", "delta", "delta", "delta", "done"]);
    expect(events[0]!.data).toEqual({
      model: "mock-model",
      prompt_tokens: expect.any(Number),
      max_output_tokens: expect.any(Number),
      queue_ms: expect.any(Number),
    });
    expect(events.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toBe("Hello, world");
    expect(events.at(-1)!.data).toEqual({
      finish_reason: "stop",
      usage: { prompt_tokens: 42, completion_tokens: 5 },
      timings: { queue_ms: expect.any(Number), prompt_ms: 12, generation_ms: 100, tokens_per_second: 70.12 },
    });
  });

  test("the Accept header alone selects streaming", async () => {
    const res = await post("/api/v1/translate", { text: "你好", target_lang: "en" }, { headers: { accept: "text/event-stream" } });
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    await res.text();
  });

  test("validation errors are plain JSON responses even when streaming is requested", async () => {
    const res = await post("/api/v1/translate", { text: "", target_lang: "en", stream: true });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toStartWith("application/json");
  });

  test("engine failures mid-stream arrive as an error event", async () => {
    mock.failWith = "device lost";
    const events = await readSse(await post("/api/v1/translate", { text: "你好", target_lang: "en", stream: true }));
    mock.failWith = undefined;
    expect(events.at(-1)).toEqual({ event: "error", data: { code: "engine_error", message: expect.stringContaining("device lost") } });
  });
});

describe("queueing and cancellation", () => {
  test("a second request waits, a third is rejected with 429", async () => {
    mock.delayMs = 60;
    const first = post("/api/v1/translate", { text: "one", target_lang: "en", stream: true });
    await Bun.sleep(30);
    const second = post("/api/v1/translate", { text: "two", target_lang: "en", stream: true });
    await Bun.sleep(30);

    const health = (await (await fetch(base + "/api/v1/health")).json()) as any;
    expect(health.queue).toEqual({ running: true, waiting: 1, max_waiting: 1 });

    const third = await post("/api/v1/translate", { text: "three", target_lang: "en" });
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("10");
    expect(((await third.json()) as any).error.code).toBe("queue_full");

    const [a, b] = await Promise.all([first.then(readSse), second.then(readSse)]);
    mock.delayMs = 0;
    expect(a.map((e) => e.event)).toEqual(["start", "delta", "delta", "delta", "done"]);
    expect(b.map((e) => e.event)).toEqual(["queued", "start", "delta", "delta", "delta", "done"]);
    expect(b[0]!.data).toEqual({ position: 1 });
    expect(b[1]!.data.queue_ms).toBeGreaterThan(0);
  });

  test("disconnecting cancels the generation and frees the slot", async () => {
    mock.delayMs = 200;
    const abortedBefore = mock.aborted;
    const ac = new AbortController();
    const res = await post("/api/v1/translate", { text: "long", target_lang: "en", stream: true }, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();

    for (let i = 0; i < 100 && mock.aborted === abortedBefore; i++) await Bun.sleep(20);
    mock.delayMs = 0;
    expect(mock.aborted).toBe(abortedBefore + 1);

    const health = (await (await fetch(base + "/api/v1/health")).json()) as any;
    expect(health.queue.running).toBe(false);
    const next = await post("/api/v1/translate", { text: "next", target_lang: "en" });
    expect(next.status).toBe(200);
  });
});

describe("engine availability", () => {
  test("requests get 503 while the model is loading", async () => {
    mock.ready = false;
    const loading = await startApp(config());
    try {
      const origin = loading.server.url.origin;
      const health = await fetch(origin + "/api/v1/health");
      expect(health.status).toBe(503);
      expect(((await health.json()) as any).status).toBe("loading");

      const res = await fetch(origin + "/api/v1/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hi", target_lang: "zh" }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(((await res.json()) as any).error.code).toBe("engine_loading");

      mock.ready = true;
      await waitReady(loading);
    } finally {
      mock.ready = true;
      await loading.stop();
    }
  });
});

describe("static files", () => {
  test("serves the site root and refuses to leave the public directory", async () => {
    const index = await fetch(base + "/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toStartWith("text/html");

    expect((await fetch(base + "/missing.html")).status).toBe(404);
    expect((await fetch(base + "/%2e%2e/package.json")).status).toBe(404);
    expect((await fetch(base + "/..%2fREADME.md")).status).toBe(404);
  });
});
