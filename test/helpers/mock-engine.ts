// Shared harness for API tests: a mock llama-server that runs in-process, a launcher that starts
// one per model load, and small request/SSE helpers. No GPU or model files are needed.
//
// The mock tokenizer counts one token per character and the chat template adds TEMPLATE.length tokens.
// `mock` is module state shared by every test file in the run: tests that change it must restore it
// (or call resetMock() in afterEach/finally), because bun runs test files in one process.

import { expect } from "bun:test";
import { join, resolve } from "node:path";
import type { App } from "../../src/app";
import type { Config } from "../../src/config";
import { EngineError, type Launcher } from "../../src/llama";

export const root = resolve(import.meta.dir, "..", "..");

export const TEMPLATE = "<user></user>";

export const CHAT = "index-translate-9b";
export const DOCUMENT = "index-nailong-9b";

const DEFAULT_CHUNKS = ["<think>\n\n</think>\n\n", "Hello", ", ", "world", "\n"];

export const mock = {
  ready: true,
  chunks: [...DEFAULT_CHUNKS],
  delayMs: 0,
  finish: "stop",
  failWith: undefined as string | undefined,
  failLaunch: undefined as string | undefined,
  requests: [] as any[],
  aborted: 0,
  launches: [] as string[],
};

/** Puts the behaviour knobs back to their defaults; counters (requests, aborted, launches) are kept. */
export function resetMock(): void {
  mock.ready = true;
  mock.chunks = [...DEFAULT_CHUNKS];
  mock.delayMs = 0;
  mock.finish = "stop";
  mock.failWith = undefined;
  mock.failLaunch = undefined;
}

export const sse = (data: unknown) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

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

export const launcher: Launcher = async (model) => {
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

export function config(overrides: Partial<Config> = {}): Config {
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
    openBrowser: false,
    ...overrides,
  };
}

export async function waitReady(app: App): Promise<void> {
  for (let i = 0; i < 100 && app.engine.state !== "ready"; i++) await Bun.sleep(20);
  expect(app.engine.state).toBe("ready");
}

/** POST JSON (or a raw string body) to `base + path`. */
export function postTo(base: string, path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(base + path, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
}

export interface SseEvent {
  event: string;
  data: any;
}

export async function readSse(res: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for (const frame of (await res.text()).split("\n\n")) {
    const event = /^event: (.*)$/m.exec(frame)?.[1];
    const data = /^data: (.*)$/m.exec(frame)?.[1];
    if (event && data) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}
