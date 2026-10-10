// API tests against a mock engine, so they run without a GPU or model files. The mock launcher
// starts an in-process upstream server per load and records which model each load was for.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { join, resolve } from "node:path";
import { startApp, type App } from "../src/app";
import type { Config } from "../src/config";
import { EngineError, type Launcher } from "../src/llama";
import { buildDocumentPrompt } from "../src/prompt";

const root = resolve(import.meta.dir, "..");

// The mock tokenizer counts one token per character and the chat template adds TEMPLATE.length tokens.
const TEMPLATE = "<user></user>";

const CHAT = "index-translate-9b";
const DOCUMENT = "index-nailong-9b";

const mock = {
  ready: true,
  chunks: ["<think>\n\n</think>\n\n", "Hello", ", ", "world", "\n"],
  delayMs: 0,
  finish: "stop",
  failWith: undefined as string | undefined,
  failLaunch: undefined as string | undefined,
  requests: [] as any[],
  aborted: 0,
  launches: [] as string[],
};

const sse = (data: unknown) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

async function upstreamFetch(req: Request): Promise<Response> {
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
}

const launcher: Launcher = async (model) => {
  if (mock.failLaunch) throw new EngineError(mock.failLaunch);
  mock.launches.push(model.id);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: upstreamFetch });
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (finish = resolve));
  return {
    url: `http://127.0.0.1:${server.port}`,
    exited,
    stop() {
      void server.stop(true).then(() => finish(0));
    },
  };
};

function config(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    publicDir: join(root, "public"),
    specPath: join(root, "docs", "openapi.yaml"),
    modelsDir: "/nonexistent",
    defaultModel: CHAT,
    llamaBin: "/nonexistent/llama-server",
    llamaPort: 0,
    gpuLayers: "all",
    llamaExtraArgs: [],
    ctxSize: 1000,
    maxInputTokens: 400,
    maxQueue: 1,
    allowedOrigins: [],
    allowedHosts: [],
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
  app = await startApp(config(), launcher);
  base = app.server.url.origin;
  await waitReady(app);
});

afterAll(async () => {
  await app.stop();
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
  test("health reports engine state, the loaded model, limits and queue", async () => {
    const res = await fetch(base + "/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ready",
      model: CHAT,
      limits: { context_tokens: 1000, max_input_tokens: 400 },
      queue: { running: false, waiting: 0, max_waiting: 1 },
    });
  });

  test("models lists both checkpoints with their document directions", async () => {
    const body = (await (await fetch(base + "/api/v1/models")).json()) as any;
    expect(body.default).toBe(CHAT);
    expect(body.loaded).toBe(CHAT);
    expect(body.models.map((m: any) => m.id)).toEqual([CHAT, DOCUMENT]);
    expect(body.models[1]).toEqual({
      id: DOCUMENT,
      label: expect.any(String),
      kind: "document",
      directions: ["zh-en", "en-zh", "zh-ja", "ja-zh"],
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
      model: CHAT,
      counted_with: CHAT,
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

  test("validates the document model's language pair like /translate does", async () => {
    const res = await post("/api/v1/tokenize", { text: "Hi", target_lang: "zh", model: DOCUMENT });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.details.field).toBe("source_lang");
  });

  test("counts a document request's own prompt with the loaded model, without loading it", async () => {
    const before = mock.launches.length;
    const res = await post("/api/v1/tokenize", { text: "The fox.", source_lang: "en", target_lang: "zh", model: DOCUMENT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ model: DOCUMENT, counted_with: CHAT });
    expect(body.prompt_tokens).toBe(buildDocumentPrompt("en-zh", "The fox.").length + TEMPLATE.length);
    expect(mock.launches.length).toBe(before);

    const health = (await (await fetch(base + "/api/v1/health")).json()) as any;
    expect(health.model).toBe(CHAT);
  });

  test("does not wait for a running translation", async () => {
    mock.delayMs = 300;
    const running = post("/api/v1/translate", { text: "long", target_lang: "en", stream: true });
    await Bun.sleep(50);

    const started = performance.now();
    const res = await post("/api/v1/tokenize", { text: "Hello", target_lang: "zh" });
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(200);
    expect(((await res.json()) as any).counted_with).toBe(CHAT);

    expect((await readSse(await running)).at(-1)!.event).toBe("done");
    mock.delayMs = 0;
  });

  test("takes no queue slot, so it works when the queue is full and leaves the queue unchanged", async () => {
    mock.delayMs = 100;
    const first = post("/api/v1/translate", { text: "one", target_lang: "en", stream: true });
    await Bun.sleep(30);
    const second = post("/api/v1/translate", { text: "two", target_lang: "en", stream: true });
    await Bun.sleep(30);

    const before = (await (await fetch(base + "/api/v1/health")).json()) as any;
    expect(before.queue).toEqual({ running: true, waiting: 1, max_waiting: 1 });

    const res = await post("/api/v1/tokenize", { text: "Hi", target_lang: "zh" });
    expect(res.status).toBe(200);

    const after = (await (await fetch(base + "/api/v1/health")).json()) as any;
    expect(after.queue).toEqual({ running: true, waiting: 1, max_waiting: 1 });

    await Promise.all([first.then(readSse), second.then(readSse)]);
    mock.delayMs = 0;
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
      model: CHAT,
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
    ["unknown model", { text: "Hi", target_lang: "zh", model: "gpt" }, "model"],
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
      model: CHAT,
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

  test("an input over the token limit arrives as an error event", async () => {
    const events = await readSse(await post("/api/v1/translate", { text: "x".repeat(500), target_lang: "zh", stream: true }));
    expect(events.map((e) => e.event)).toEqual(["error"]);
    expect(events[0]!.data.code).toBe("input_too_long");
    expect(events[0]!.data.details.max_input_tokens).toBe(400);
  });

  test("engine failures mid-stream arrive as an error event", async () => {
    mock.failWith = "device lost";
    const events = await readSse(await post("/api/v1/translate", { text: "你好", target_lang: "en", stream: true }));
    mock.failWith = undefined;
    expect(events.at(-1)).toEqual({ event: "error", data: { code: "engine_error", message: expect.stringContaining("device lost") } });
  });
});

describe("model selection", () => {
  test("a request for another model swaps the engine, and the default is restored for the next", async () => {
    const before = mock.launches.length;
    const res = await post("/api/v1/translate", { text: "The fox.", source_lang: "en", target_lang: "zh", model: DOCUMENT });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).model).toBe(DOCUMENT);
    expect(mock.launches.slice(before)).toEqual([DOCUMENT]);

    const health = (await (await fetch(base + "/api/v1/health")).json()) as any;
    expect(health.model).toBe(DOCUMENT);

    // A request already on the loaded model does not reload it.
    await post("/api/v1/translate", { text: "Again.", source_lang: "en", target_lang: "zh", model: DOCUMENT });
    expect(mock.launches.slice(before)).toEqual([DOCUMENT]);

    await post("/api/v1/translate", { text: "你好", target_lang: "en" });
    expect(mock.launches.slice(before)).toEqual([DOCUMENT, CHAT]);
  });

  test("the document model gets its fixed template with the whole text in place", async () => {
    mock.requests.length = 0;
    await post("/api/v1/translate", { text: "Line one.\n\nLine two.", source_lang: "en", target_lang: "zh", model: DOCUMENT });
    const content: string = mock.requests.at(-1).messages[0].content;
    expect(content).toStartWith("请将以下英文小说翻译成中文");
    expect(content).toContain("【源文】\n\nLine one.\n\nLine two.");
    expect(content).not.toContain("（在这里放入");
    expect(content).toEndWith("只输出译文，不要有任何额外说明。\n\n【源文】\n\nLine one.\n\nLine two.");
  });

  test("the document model needs a source language and a supported direction", async () => {
    const missing = await post("/api/v1/translate", { text: "Hi", target_lang: "zh", model: DOCUMENT });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as any).error.details.field).toBe("source_lang");

    const pair = await post("/api/v1/translate", { text: "Hi", source_lang: "en", target_lang: "fr", model: DOCUMENT });
    expect(pair.status).toBe(400);
    const { error } = (await pair.json()) as any;
    expect(error.code).toBe("unsupported_language_pair");
    expect(error.details.supported).toEqual(["zh-en", "en-zh", "zh-ja", "ja-zh"]);
  });

  test("the document model rejects options its fixed template cannot express", async () => {
    for (const [field, extra] of [
      ["glossary", { glossary: { a: "b" } }],
      ["hard_constraints", { hard_constraints: ["x"] }],
      ["soft_constraints", { soft_constraints: ["x"] }],
      ["genre", { genre: "novel" }],
    ] as const) {
      const res = await post("/api/v1/translate", { text: "Hi", source_lang: "en", target_lang: "zh", model: DOCUMENT, ...extra });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.details.field).toBe(field);
    }
  });

  test("a model that fails to load gives 502, and the next request tries again", async () => {
    // Move off the document model first so the next request has to load it.
    await post("/api/v1/translate", { text: "你好", target_lang: "en" });
    mock.failLaunch = "model file is corrupt";
    const failed = await post("/api/v1/translate", { text: "Hi", source_lang: "en", target_lang: "zh", model: DOCUMENT });
    mock.failLaunch = undefined;
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as any).error.message).toContain("model file is corrupt");

    const retried = await post("/api/v1/translate", { text: "Hi", source_lang: "en", target_lang: "zh", model: DOCUMENT });
    expect(retried.status).toBe(200);
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

  async function queueState(): Promise<{ running: boolean; waiting: number }> {
    const { running, waiting } = ((await (await fetch(base + "/api/v1/health")).json()) as any).queue;
    return { running, waiting };
  }

  async function waitForWaiting(count: number): Promise<void> {
    for (let i = 0; i < 100 && (await queueState()).waiting !== count; i++) await Bun.sleep(20);
  }

  test.each([
    ["translate", "/api/v1/translate", { text: "two", target_lang: "en" }],
    ["tokenize", "/api/v1/tokenize", { text: "two", target_lang: "en" }],
  ])("cancelling a queued JSON %s request frees its place quietly", async (_name, path, body) => {
    mock.delayMs = 60;
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = post("/api/v1/translate", { text: "one", target_lang: "en" });
      await Bun.sleep(30);
      const ac = new AbortController();
      const second = post(path, body, { signal: ac.signal });
      await Bun.sleep(30);
      expect((await queueState()).waiting).toBe(1);

      ac.abort();
      await expect(second).rejects.toThrow();
      await waitForWaiting(0);
      expect(await queueState()).toEqual({ running: true, waiting: 0 });

      expect((await first).status).toBe(200);
      expect(await queueState()).toEqual({ running: false, waiting: 0 });
      expect(log).not.toHaveBeenCalled();

      const next = await post("/api/v1/translate", { text: "next", target_lang: "en" });
      expect(next.status).toBe(200);
    } finally {
      log.mockRestore();
      mock.delayMs = 0;
    }
  });

  test("disconnecting during a JSON translation is a quiet cancellation", async () => {
    mock.delayMs = 200;
    const log = spyOn(console, "error").mockImplementation(() => {});
    const abortedBefore = mock.aborted;
    try {
      const ac = new AbortController();
      const pending = post("/api/v1/translate", { text: "long", target_lang: "en" }, { signal: ac.signal });
      await Bun.sleep(100);
      ac.abort();
      await expect(pending).rejects.toThrow();

      for (let i = 0; i < 100 && mock.aborted === abortedBefore; i++) await Bun.sleep(20);
      await waitForWaiting(0);
      await Bun.sleep(50);
      expect(mock.aborted).toBe(abortedBefore + 1);
      expect(await queueState()).toEqual({ running: false, waiting: 0 });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      mock.delayMs = 0;
    }
  });

  test("cancelling a queued SSE request ends its handler and clears its keepalive", async () => {
    // Keepalive timers are the only thing a hung queued stream would leak, so track them directly.
    const g = globalThis as any;
    const realSetInterval = g.setInterval;
    const realClearInterval = g.clearInterval;
    const live = new Set<unknown>();
    g.setInterval = (...args: any[]) => {
      const id = realSetInterval(...args);
      live.add(id);
      return id;
    };
    g.clearInterval = (id: unknown) => {
      live.delete(id);
      realClearInterval(id);
    };
    try {
      mock.delayMs = 60;
      const first = post("/api/v1/translate", { text: "one", target_lang: "en" });
      await Bun.sleep(30);
      const before = live.size;
      const ac = new AbortController();
      // The stream's headers arrive at once, so the queued request is open but never answered.
      await post("/api/v1/translate", { text: "two", target_lang: "en", stream: true }, { signal: ac.signal });
      await Bun.sleep(30);
      expect((await queueState()).waiting).toBe(1);
      expect(live.size).toBe(before + 1);

      ac.abort();
      await waitForWaiting(0);
      await Bun.sleep(50);
      expect(live.size).toBe(before);
      expect((await first).status).toBe(200);

      const next = await post("/api/v1/translate", { text: "next", target_lang: "en", stream: true });
      expect((await readSse(next)).at(-1)!.event).toBe("done");
      expect(await queueState()).toEqual({ running: false, waiting: 0 });
    } finally {
      g.setInterval = realSetInterval;
      g.clearInterval = realClearInterval;
      mock.delayMs = 0;
    }
  });
});

describe("engine availability", () => {
  test("requests wait in line while the default model loads, then complete", async () => {
    mock.ready = false;
    const loading = await startApp(config(), launcher);
    try {
      const origin = loading.server.url.origin;
      const health = await fetch(origin + "/api/v1/health");
      expect(health.status).toBe(503);
      expect(((await health.json()) as any).status).toBe("loading");

      const pending = fetch(origin + "/api/v1/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hi", target_lang: "zh" }),
      });
      await Bun.sleep(100);
      mock.ready = true;
      const res = await pending;
      expect(res.status).toBe(200);
      await waitReady(loading);
    } finally {
      mock.ready = true;
      await loading.stop();
    }
  });

  test("tokenize while the engine is loading gets 503 with Retry-After, then counts once it is ready", async () => {
    mock.ready = false;
    const loading = await startApp(config(), launcher);
    try {
      const origin = loading.server.url.origin;
      for (let i = 0; i < 100 && loading.engine.state !== "loading"; i++) await Bun.sleep(10);
      expect(loading.engine.state).toBe("loading");

      const tokenize = () =>
        fetch(origin + "/api/v1/tokenize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Hi", target_lang: "zh" }),
        });
      const busy = await tokenize();
      expect(busy.status).toBe(503);
      expect(busy.headers.get("retry-after")).toBe("2");
      expect(((await busy.json()) as any).error.code).toBe("engine_unavailable");

      mock.ready = true;
      await waitReady(loading);
      const ready = await tokenize();
      expect(ready.status).toBe(200);
      expect(((await ready.json()) as any).counted_with).toBe(CHAT);
    } finally {
      mock.ready = true;
      await loading.stop();
    }
  });

  test("tokenize after a failed default load gets 503 instead of waiting", async () => {
    mock.failLaunch = "model file is corrupt";
    const broken = await startApp(config(), launcher);
    try {
      for (let i = 0; i < 100 && broken.engine.state !== "error"; i++) await Bun.sleep(10);
      expect(broken.engine.state).toBe("error");
      const res = await fetch(broken.server.url.origin + "/api/v1/tokenize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hi", target_lang: "zh" }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("2");
      expect(((await res.json()) as any).error.code).toBe("engine_unavailable");
    } finally {
      mock.failLaunch = undefined;
      await broken.stop();
    }
  });
});

/** Runs `fn` against a second app started with `overrides`, e.g. a different allow-list. */
async function withApp(overrides: Partial<Config>, fn: (app: App) => Promise<void>): Promise<void> {
  const extra = await startApp(config(overrides), launcher);
  try {
    await waitReady(extra);
    await fn(extra);
  } finally {
    await extra.stop();
  }
}

describe("browser request checks", () => {
  const translateBody = JSON.stringify({ text: "Hi", target_lang: "zh" });

  test("POST endpoints reject a non-JSON body type with 415", async () => {
    for (const path of ["/api/v1/translate", "/api/v1/tokenize"]) {
      const res = await post(path, translateBody, { headers: { "content-type": "text/plain" } });
      expect(res.status).toBe(415);
      expect(((await res.json()) as any).error.code).toBe("unsupported_media_type");
    }
    // A simple cross-site form POST carries no content-type at all.
    const bare = await fetch(base + "/api/v1/translate", { method: "POST", body: translateBody, headers: { "content-type": "" } });
    expect(bare.status).toBe(415);
  });

  test("JSON with parameters and any letter case is accepted", async () => {
    const res = await post("/api/v1/translate", { text: "Hi", target_lang: "zh" }, {
      headers: { "content-type": "Application/JSON; Charset=UTF-8" },
    });
    expect(res.status).toBe(200);
    await res.json();
  });

  test("a cross-origin page is refused with 403", async () => {
    const res = await post("/api/v1/translate", { text: "Hi", target_lang: "zh" }, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("forbidden_origin");

    const health = await fetch(base + "/api/v1/health", { headers: { origin: "null" } });
    expect(health.status).toBe(403);
  });

  test("a same-origin page is served, and so is a request without an Origin", async () => {
    const port = app.server.url.port;
    const same = await post("/api/v1/tokenize", { text: "Hi", target_lang: "zh" }, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(same.status).toBe(200);
    await same.text();

    const none = await fetch(base + "/api/v1/health");
    expect(none.status).toBe(200);
    await none.text();
  });

  test("ALLOWED_ORIGINS admits the listed origins only", async () => {
    await withApp({ allowedOrigins: ["https://app.example.com/", "http://localhost:5173"] }, async (extra) => {
      const tokenize = (origin: string) =>
        fetch(extra.server.url.origin + "/api/v1/tokenize", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: translateBody,
        });

      const allowed = await tokenize("https://app.example.com");
      expect(allowed.status).toBe(200);
      await allowed.text();

      const dev = await tokenize("http://localhost:5173");
      expect(dev.status).toBe(200);
      await dev.text();

      const other = await tokenize("https://evil.example");
      expect(other.status).toBe(403);
      await other.text();
    });
  });

  test("a Host header that is not loopback or configured is refused with 403", async () => {
    const evil = await fetch(base + "/api/v1/health", { headers: { host: "rebind.example:3000" } });
    expect(evil.status).toBe(403);
    expect(((await evil.json()) as any).error.code).toBe("forbidden_host");

    for (const host of ["localhost:3000", "[::1]:3000", "127.0.0.1"]) {
      const ok = await fetch(base + "/api/v1/health", { headers: { host } });
      expect(ok.status).toBe(200);
      await ok.text();
    }
  });

  test("ALLOWED_HOSTS admits a proxy host name", async () => {
    await withApp({ allowedHosts: ["Translate.Example.com"] }, async (extra) => {
      const base2 = extra.server.url.origin;
      const proxied = await fetch(base2 + "/api/v1/health", { headers: { host: "translate.example.com:8443" } });
      expect(proxied.status).toBe(200);
      await proxied.text();

      const other = await fetch(base2 + "/api/v1/health", { headers: { host: "other.example.com" } });
      expect(other.status).toBe(403);
      await other.text();
    });
  });

  test("HOST itself is an allowed Host, so a wildcard bind works with its own address", async () => {
    await withApp({ host: "::1" }, async (extra) => {
      const res = await fetch(`http://[::1]:${extra.server.url.port}/api/v1/health`, { headers: { host: "[::1]" } });
      expect(res.status).toBe(200);
      await res.text();
    });
  });

  test("static files are not subject to the checks", async () => {
    const res = await fetch(base + "/", { headers: { host: "rebind.example", origin: "https://evil.example" } });
    expect(res.status).toBe(200);
    await res.text();
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

describe("output budget", () => {
  // The mock counts one token per prompt character, so a source text of n characters has a known prompt size.
  async function tokenCount(origin: string, text: string): Promise<number> {
    const res = await fetch(origin + "/api/v1/tokenize", {
      method: "POST",
      body: JSON.stringify({ text, target_lang: "en" }),
      headers: { "content-type": "application/json" },
    });
    return ((await res.json()) as any).prompt_tokens;
  }

  async function textWithPromptTokens(origin: string, target: number): Promise<string> {
    const overhead = (await tokenCount(origin, "a")) - 1;
    return "a".repeat(target - overhead);
  }

  function translate(origin: string, body: unknown): Promise<Response> {
    return fetch(origin + "/api/v1/translate", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  describe("ctxSize 300, maxInputTokens 200", () => {
    // A prompt of 200 tokens leaves 300 - 200 - 64 = 36 for the translation.
    let app: App;
    let origin: string;

    beforeAll(async () => {
      app = await startApp(config({ ctxSize: 300, maxInputTokens: 200 }), launcher);
      origin = app.server.url.origin;
      await waitReady(app);
    });

    afterAll(async () => {
      await app.stop();
    });

    test("a prompt at the input limit gets the remaining context as its budget", async () => {
      const text = await textWithPromptTokens(origin, 200);
      expect(await tokenCount(origin, text)).toBe(200);
      const events = await readSse(await translate(origin, { text, target_lang: "en", stream: true }));
      expect(events.find((e) => e.event === "start")?.data).toMatchObject({ prompt_tokens: 200, max_output_tokens: 36 });
    });

    test("an explicit max_output_tokens is clamped to the remaining context", async () => {
      const text = await textWithPromptTokens(origin, 200);
      const events = await readSse(
        await translate(origin, { text, target_lang: "en", stream: true, max_output_tokens: 1000 }),
      );
      expect(events.find((e) => e.event === "start")?.data.max_output_tokens).toBe(36);
    });

    test("a prompt one token over the input limit is refused with details", async () => {
      const text = await textWithPromptTokens(origin, 201);
      const res = await translate(origin, { text, target_lang: "en" });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: {
          code: "input_too_long",
          message: "the input exceeds the token limit for a single translation",
          details: { prompt_tokens: 201, max_input_tokens: 200 },
        },
      });
    });
  });

  test("a prompt that leaves no room after the margin is refused, not sent with a non-positive budget", async () => {
    // loadConfig would reject this pair (290 + 64 >= 300); startApp takes the config as given.
    const app = await startApp(config({ ctxSize: 300, maxInputTokens: 290 }), launcher);
    try {
      const origin = app.server.url.origin;
      await waitReady(app);

      // 230 tokens leaves 300 - 230 - 64 = 6 for the translation: still accepted.
      const fits = await textWithPromptTokens(origin, 230);
      const events = await readSse(await translate(origin, { text: fits, target_lang: "en", stream: true }));
      expect(events.find((e) => e.event === "start")?.data.max_output_tokens).toBe(6);

      // 240 tokens leaves -4: refused before any generation starts.
      const tooLong = await textWithPromptTokens(origin, 240);
      const requests = mock.requests.length;
      const res = await translate(origin, { text: tooLong, target_lang: "en" });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: {
          code: "input_too_long",
          message: "the input leaves no room for a translation in the context window",
          details: { prompt_tokens: 240, context_tokens: 300 },
        },
      });
      expect(mock.requests.length).toBe(requests);
    } finally {
      await app.stop();
    }
  });
});
