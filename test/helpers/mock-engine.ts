// Shared harness for API tests and the Playwright mock server (e2e/mock-server.ts): a fake model that
// stands in for the one libllama would load, a launcher that makes one per model load, and small
// request/SSE helpers. No GPU, library or model files are needed.
//
// The fake counts one token per code point and the chat template adds TEMPLATE.length tokens.
// `mock` is module state shared by every test file in the run: tests that change it must restore it
// (or call resetMock() in afterEach/finally), because bun runs test files in one process.

import { join, resolve } from "node:path";
import type { App } from "../../src/app";
import type { Config } from "../../src/config";
import { EngineError, type FinishReason, type GenerationEvent, type Launcher, type Running } from "../../src/llama";

export const root = resolve(import.meta.dir, "..", "..");

export const TEMPLATE = "<user></user>";

export const CHAT = "index-translate-9b";
export const DOCUMENT = "index-nailong-9b";

const DEFAULT_CHUNKS = ["<think>\n\n</think>\n\n", "Hello", ", ", "world", "\n"];

export const mock = {
  /** While false, a launch waits instead of finishing, as a slow model load would. */
  ready: true,
  chunks: [...DEFAULT_CHUNKS],
  delayMs: 0,
  finish: "stop" as FinishReason,
  failWith: undefined as string | undefined,
  failLaunch: undefined as string | undefined,
  /** Every generation the shared launcher's models were asked for. */
  requests: [] as { prompt: string; maxTokens: number }[],
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

export interface FakeHooks {
  /** Called when a generation starts. */
  onStart?(prompt: string, maxTokens: number): void;
  /** A promise the generation waits for before its first chunk. */
  gate?(): Promise<void> | undefined;
  onChunk?(): void;
  /** The client went away before the generation finished. */
  onAbort?(): void;
  /** Called once per generation, however it ends. */
  onEnd?(): void;
  /** What the done event reports as prompt_tokens; 42 by default. */
  promptTokens?(): number;
}

export interface FakeModel extends Running {
  stopped: boolean;
  /** Loses the model as if the engine thread had died: generations fail and `exited` gives the reason. */
  kill(reason?: string): void;
}

/** A loaded model that plays `mock.chunks`. Stopping or killing it fails the generations in flight. */
export function fakeModel(hooks: FakeHooks = {}): FakeModel {
  let finish!: (reason: string | undefined) => void;
  const exited = new Promise<string | undefined>((resolve) => (finish = resolve));
  const gone = new AbortController();
  const end = (reason: string | undefined) => {
    if (model.stopped) return;
    model.stopped = true;
    gone.abort();
    finish(reason);
  };

  /** Waits for `p`, but throws as soon as the model is gone or the client aborts. */
  async function alive(p: Promise<void> | undefined, signal: AbortSignal): Promise<void> {
    if (p && !signal.aborted) {
      let wake!: () => void;
      const aborted = new Promise<void>((resolve) => (wake = resolve));
      signal.addEventListener("abort", wake);
      await Promise.race([p, aborted]).finally(() => signal.removeEventListener("abort", wake));
    }
    if (model.stopped) throw new EngineError("generation failed: the model was unloaded during the generation");
    signal.throwIfAborted();
  }

  const model: FakeModel = {
    exited,
    stopped: false,
    stop: () => end(undefined),
    kill: (reason = "the engine thread exited") => end(reason),
    async countTokens(content) {
      if (model.stopped) throw new EngineError("the model is not loaded");
      return Array.from(content).length + TEMPLATE.length;
    },
    async *generate(prompt, maxTokens, client): AsyncGenerator<GenerationEvent> {
      const signal = client ? AbortSignal.any([client, gone.signal]) : gone.signal;
      hooks.onStart?.(prompt, maxTokens);
      const { chunks, delayMs, finish: finishReason, failWith } = mock;
      let played = false;
      try {
        await alive(hooks.gate?.(), signal);
        for (const text of chunks) {
          await alive(delayMs ? Bun.sleep(delayMs) : undefined, signal);
          hooks.onChunk?.();
          yield { type: "delta", text };
        }
        played = true;
        if (failWith) throw new EngineError(`generation failed: ${failWith}`);
        yield {
          type: "done",
          finishReason,
          usage: { prompt_tokens: hooks.promptTokens?.() ?? 42, completion_tokens: chunks.length },
          timings: { prompt_ms: 12, generation_ms: 100, tokens_per_second: 70.12 },
        };
      } finally {
        if (!played && !model.stopped) hooks.onAbort?.();
        hooks.onEnd?.();
      }
    },
  };
  return model;
}

export const launcher: Launcher = async (model) => {
  if (mock.failLaunch) throw new EngineError(mock.failLaunch);
  mock.launches.push(model.id);
  while (!mock.ready) await Bun.sleep(10);
  return fakeModel({
    onStart: (prompt, maxTokens) => mock.requests.push({ prompt, maxTokens }),
    onAbort: () => mock.aborted++,
  });
};

export function config(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    publicDir: join(root, "public"),
    specPath: join(root, "docs", "openapi.yaml"),
    modelsDir: "/nonexistent",
    defaultModel: CHAT,
    llamaDir: "/nonexistent/llama.cpp",
    gpuLayers: -1,
    threads: 0,
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
  if (app.engine.state !== "ready") throw new Error(`engine not ready: ${app.engine.state}`);
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
