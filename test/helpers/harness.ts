// Shared helpers for the API tests and the Playwright mock server: configuration, polling, and small
// request/SSE helpers. The mocks themselves are in mock-llama.ts, mock-speech.ts, mock-webpage.ts and
// mock-segment.ts; mock-engine.ts re-exports all of it and has `resetAllMocks`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ErrorBody, ErrorResponse, Health, TranslateEvents } from "../../src/api";
import type { App } from "../../src/app";
import type { Config } from "../../src/config";

export const root = resolve(import.meta.dir, "..", "..");

export const CHAT = "index-translate-9b";
export const DOCUMENT = "index-nailong-9b";

/**
 * Polls `cond` until it answers something other than false, undefined or null, and returns that value.
 * Throws after `timeoutMs`; `what` (or what it returns when the time is up) says what was waited for.
 * Use it instead of a fixed sleep to wait for something that happens on its own; a sleep is only for
 * asserting that something does not happen.
 */
export async function until<T>(
  cond: () => T | Promise<T>,
  what: string | (() => string) = "the condition",
  timeoutMs = 3000,
): Promise<Exclude<T, false | undefined | null>> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await cond();
    if (value !== false && value !== undefined && value !== null) {
      return value as Exclude<T, false | undefined | null>;
    }
    if (performance.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${typeof what === "string" ? what : what()}`);
    }
    await Bun.sleep(2);
  }
}

/**
 * Waits until the server holds `n` requests it has not answered yet: how a test knows a request has
 * reached the server and is waiting in a queue, which nothing else shows. Needs a quiet server (no
 * request of an earlier test still open).
 */
export async function inFlight(app: App, n: number): Promise<void> {
  await until(() => app.server.pendingRequests >= n, `${n} requests in flight`);
}

/** Waits until `GET /health` reports the translation queue as `running` with `waiting` requests behind it. */
export async function queueIs(base: string, running: boolean, waiting: number): Promise<void> {
  await until(async () => {
    const { queue } = await getHealth(base);
    return queue.running === running && queue.waiting === waiting;
  }, `the queue to have running ${running}, waiting ${waiting}`);
}

/**
 * Lets pending promise callbacks and I/O callbacks run: `rounds` turns of the event loop. Uses
 * `setImmediate`, which fake timers do not hold back (`Bun.sleep` and `setTimeout` are).
 */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => void setImmediate(resolve));
  }
}

/**
 * One macrotask on the timer queue, so every pending promise callback has run. Use `flush` instead
 * under fake timers, or when the event loop is busy: a timer is not held back there, but
 * `setImmediate` can be slow once a server has been busy.
 */
export function tick(): Promise<void> {
  return Bun.sleep(0);
}

/** Rejects with `timed out: ${what}` when `p` has not settled after `ms`. */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>(
    (_, reject) => void (timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)),
  );
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Everything an async iterable yields, in order. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) {
    out.push(item);
  }
  return out;
}

const tempDirs = new Set<string>();
process.on("exit", () => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A new empty directory under the system's temporary one, removed when the test process exits. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

/** Waits `ms`, or until `signal` aborts, whichever is first; never rejects. A mock's way to take its time. */
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms && !signal.aborted) {
    let wake!: () => void;
    const aborted = new Promise<void>((resolve) => void (wake = resolve));
    signal.addEventListener("abort", wake, { once: true });
    await Promise.race([Bun.sleep(ms), aborted]);
    signal.removeEventListener("abort", wake);
  }
}

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
    mtp: true,
    ctxSize: 1000,
    maxInputTokens: 400,
    maxQueue: 1,
    allowedOrigins: [],
    allowedHosts: [],
    allowedWebpageDomains: [],
    openBrowser: false,
    devReload: false,
    speech: true,
    audioDir: "/nonexistent/audio.cpp",
    speechModelDir: "/nonexistent/IndexTTS2.5-GGUF",
    separationModelDir: "/nonexistent/BS-RoFormer-ep368-GGUF",
    voicesDir: "/nonexistent/voices",
    speechBackend: "cpu",
    speechIdleUnload: 0,
    transcribe: true,
    transcribeModelDir: "/nonexistent/MOSS-Transcribe-Diarize-GGUF",
    segment: true,
    onnxruntimeDir: "/nonexistent/onnxruntime",
    segmentModelDir: "/nonexistent/sat-3l-sm",
    segmentThreads: 0,
    segmentIdleUnload: 0,
    align: true,
    alignModelDir: "/nonexistent/labse",
    ...overrides,
  };
}

export async function waitReady(app: App): Promise<void> {
  await until(
    () => app.engine.state === "ready",
    () => `the engine to be ready: ${app.engine.state}`,
  );
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

/** One event of a translation stream; `event` tells which schema `data` has. */
export type SseEvent = { [E in keyof TranslateEvents]: { event: E; data: TranslateEvents[E] } }[keyof TranslateEvents];

/** The `data` of the events called `name`, in order. */
export function dataOf<E extends keyof TranslateEvents>(events: SseEvent[], name: E): TranslateEvents[E][] {
  return events.flatMap((e) => (e.event === name ? [e.data as TranslateEvents[E]] : []));
}

export async function readSse(res: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for (const frame of (await res.text()).split("\n\n")) {
    const event = /^event: (.*)$/m.exec(frame)?.[1];
    const data = /^data: (.*)$/m.exec(frame)?.[1];
    if (event && data) {
      const parsed: unknown = JSON.parse(data);
      events.push({ event, data: parsed } as SseEvent);
    }
  }
  return events;
}

/**
 * The JSON body of a response as `T`, the type of its schema in docs/openapi.yaml. A cast, since the
 * wire holds no types: what keeps the server to the spec is that it builds each body as that type.
 */
export async function bodyOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** `GET /api/v1/health` with its status. */
export async function healthResponse(origin: string): Promise<{ status: number; body: Health }> {
  const res = await fetch(origin + "/api/v1/health");
  return { status: res.status, body: await bodyOf<Health>(res) };
}

/** The body of `GET /api/v1/health`. */
export async function getHealth(origin: string): Promise<Health> {
  return (await healthResponse(origin)).body;
}

/** The `queue` of `GET /api/v1/health`. */
export async function queueOf(origin: string): Promise<Health["queue"]> {
  return (await getHealth(origin)).queue;
}

/** The JSON body of `GET origin + path` as `T`. */
export async function getJson<T>(origin: string, path: string): Promise<T> {
  return bodyOf<T>(await fetch(origin + path));
}

/** The `error` of an error response. */
export async function errorOf(res: Response): Promise<ErrorBody> {
  return (await bodyOf<ErrorResponse>(res)).error;
}
