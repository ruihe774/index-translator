/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/await-thenable */
// Engine lifecycle, queue and streaming edge cases against fake models. Each describe starts its
// own app, so none of this touches the shared app of api.test.ts.
//
// The launcher here builds on fakeModel() from test/helpers/mock-engine.ts and adds what the shared
// launcher cannot do: lose a loaded model, hold a launch or a generation until the test opens a
// gate, count concurrent generations, and report prompt_tokens as 0. Content knobs (chunks,
// delayMs, finish, failWith, failLaunch) still come from the shared `mock`, so every test calls
// resetMock() afterwards.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { type App, startApp } from "../src/app";
import type { Config } from "../src/config";
import { EngineError, type Launcher } from "../src/llama";
import {
  CHAT,
  config,
  DOCUMENT,
  fakeModel,
  mock,
  postTo,
  resetMock,
  type SseEvent,
  waitReady,
} from "./helpers/mock-engine";

afterEach(() => resetMock());

/** What the engine reports when a model is lost because its thread died. */
const KILLED = "the engine thread exited";

interface Upstream {
  model: string;
  readonly stopped: boolean;
  /** Resolves once the model is gone, for any reason. */
  exited: Promise<string | undefined>;
  /** Loses the model as if the engine thread had died. */
  kill(): void;
}

class Control {
  readonly upstreams: Upstream[] = [];
  readonly launches: string[] = [];
  readonly generations: { model: string; prompt: string }[] = [];
  /** Launches that start while this is set wait for it before the engine comes up. */
  launchGate?: Promise<void>;
  /** Generations wait for this before their first chunk. */
  generationGate?: Promise<void>;
  zeroPromptUsage = false;
  inFlight = 0;
  maxInFlight = 0;
  chunksSent = 0;
  private openers = new Set<() => void>();

  holdLaunches(): () => void {
    return this.hold("launchGate");
  }

  holdGenerations(): () => void {
    return this.hold("generationGate");
  }

  private hold(field: "launchGate" | "generationGate"): () => void {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    this[field] = gate;
    const release = () => {
      if (this[field] === gate) {
        this[field] = undefined;
      }
      this.openers.delete(release);
      open();
    };
    this.openers.add(release);
    return release;
  }

  /** Opens every gate still held, so a failed test cannot leave a launch or generation hanging. */
  reset(): void {
    for (const open of this.openers) {
      open();
    }
    this.zeroPromptUsage = false;
  }

  stopAll(): void {
    for (const u of this.upstreams) {
      u.kill();
    }
  }

  latest(): Upstream {
    return this.upstreams.at(-1)!;
  }

  readonly launch: Launcher = async (model) => {
    if (mock.failLaunch) {
      throw new EngineError(mock.failLaunch);
    }
    this.launches.push(model.id);
    const gate = this.launchGate;
    if (gate) {
      await gate;
    }

    const fake = fakeModel({
      onStart: (prompt) => {
        this.generations.push({ model: model.id, prompt });
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      },
      gate: () => this.generationGate,
      onChunk: () => this.chunksSent++,
      onEnd: () => this.inFlight--,
      promptTokens: () => (this.zeroPromptUsage ? 0 : 42),
    });
    this.upstreams.push({
      model: model.id,
      get stopped() {
        return fake.stopped;
      },
      exited: fake.exited,
      kill: () => fake.kill(KILLED),
    });
    return fake;
  };
}

/** A fresh app on a fresh Control, started in beforeAll and stopped in afterAll. */
function fixture(overrides: Partial<Config> = {}) {
  const ctl = new Control();
  const h = { app: undefined as unknown as App, origin: "", ctl };
  beforeAll(async () => {
    h.app = await startApp(config(overrides), ctl.launch);
    h.origin = h.app.server.url.origin;
    await waitReady(h.app);
  });
  afterEach(() => ctl.reset());

  afterAll(async () => {
    await h.app?.stop();
  });
  return h;
}

// ---- small helpers ----

const chatBody = { text: "Hi", target_lang: "zh" };
const docBody = { text: "The fox.", source_lang: "en", target_lang: "zh", model: DOCUMENT };

async function until(check: () => boolean | Promise<boolean>, what = "condition", timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(5);
  }
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function translate(origin: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return postTo(origin, "/api/v1/translate", body, init);
}

function tokenize(origin: string, body: unknown): Promise<Response> {
  return postTo(origin, "/api/v1/tokenize", body);
}

async function jsonOf(p: Promise<Response>): Promise<any> {
  return (await p).json();
}

async function getHealth(origin: string): Promise<{ status: number; body: any }> {
  const res = await fetch(origin + "/api/v1/health");
  return { status: res.status, body: await res.json() };
}

async function queueOf(origin: string): Promise<{ running: boolean; waiting: number; max_waiting: number }> {
  return (await getHealth(origin)).body.queue;
}

async function getJson(origin: string, path: string): Promise<any> {
  return (await fetch(origin + path)).json();
}

/** Loads `model` with a tiny request, so the next test starts from a known engine. */
async function warm(origin: string, model: string): Promise<void> {
  const res = await translate(origin, model === DOCUMENT ? docBody : chatBody);
  expect(res.status).toBe(200);
  await res.text();
}

/** Yields the events of an SSE response one at a time, so a test can act between them. */
async function* sseEvents(res: Response): AsyncGenerator<SseEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event && data) {
          yield { event, data: JSON.parse(data) };
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function nextEvent(it: AsyncGenerator<SseEvent>): Promise<SseEvent> {
  const r = await it.next();
  if (r.done) {
    throw new Error("stream ended before the expected event");
  }
  return r.value;
}

async function collect(it: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of it) {
    out.push(ev);
  }
  return out;
}

const queuedPositions = (events: SseEvent[]) => events.filter((e) => e.event === "queued").map((e) => e.data.position);

// ---- engine thread failures ----

describe("engine thread dies", () => {
  const h = fixture();
  let log: ReturnType<typeof spyOn>;

  beforeAll(() => {
    // Expected engine errors are logged on purpose; keep the test output readable.
    log = spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(() => log.mockRestore());

  /** Starts a long JSON request and kills the engine once chunks are flowing. */
  async function killMidStreamJson(): Promise<Response> {
    mock.chunks = Array(30).fill("ab");
    mock.delayMs = 30;
    const before = h.ctl.chunksSent;
    const pending = translate(h.origin, { text: "long", target_lang: "en" });
    await until(() => h.ctl.chunksSent >= before + 3, "chunks to flow");
    h.ctl.latest().kill();
    return pending;
  }

  /** Starts a long SSE request, reads its first deltas, and kills the engine. Returns the rest of the stream. */
  async function killMidStreamSse(): Promise<SseEvent[]> {
    mock.chunks = Array(30).fill("ab");
    mock.delayMs = 30;
    const before = h.ctl.chunksSent;
    const it = sseEvents(await translate(h.origin, { text: "你好", target_lang: "en", stream: true }));
    expect((await nextEvent(it)).event).toBe("start");
    expect((await nextEvent(it)).event).toBe("delta");
    await until(() => h.ctl.chunksSent >= before + 3, "chunks to flow");
    h.ctl.latest().kill();
    return collect(it);
  }

  async function expectErrorStateThenReload(): Promise<void> {
    await until(() => h.app.engine.state === "error", "engine to report the error");
    const health = await getHealth(h.origin);
    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({ status: "error", model: null });
    expect(health.body.error).toBe(KILLED);

    resetMock();
    const launchesBefore = h.ctl.launches.length;
    const next = await translate(h.origin, { text: "你好", target_lang: "en" });
    expect(next.status).toBe(200);
    expect(((await next.json()) as any).model).toBe(CHAT);
    expect(h.ctl.launches.slice(launchesBefore)).toStrictEqual([CHAT]);
    expect((await getHealth(h.origin)).status).toBe(200);
  }

  test("dying mid-stream in JSON mode fails the request; health then reports the error and the next request reloads", async () => {
    const res = await killMidStreamJson();
    expect(res.status).toBeGreaterThanOrEqual(500);
    await res.text();
    await expectErrorStateThenReload();
  });

  test("dying mid-stream in JSON mode gives 502 engine_error", async () => {
    const res = await killMidStreamJson();
    await until(() => h.app.engine.state === "error", "engine to report the error");
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "engine_error" } });
  });

  test("dying mid-stream in SSE mode ends the stream with an error event; health then reports the error and the next request reloads", async () => {
    const rest = await killMidStreamSse();
    expect(rest.at(-1)!.event).toBe("error");
    await expectErrorStateThenReload();
  });

  test("dying mid-stream in SSE mode ends the stream with an engine_error event", async () => {
    const rest = await killMidStreamSse();
    await until(() => h.app.engine.state === "error", "engine to report the error");
    expect(rest.at(-1)!.data).toMatchObject({ code: "engine_error" });
  });

  test("dying while idle makes health 503 promptly; the next request reloads and health is ready again", async () => {
    await warm(h.origin, CHAT);
    const launchesBefore = h.ctl.launches.length;
    h.ctl.latest().kill();

    await until(async () => (await getHealth(h.origin)).status === 503, "health to report the dead engine", 1000);
    const health = await getHealth(h.origin);
    expect(health.body).toMatchObject({ status: "error", model: null });
    expect(health.body.error).toBe(KILLED);

    await warm(h.origin, CHAT);
    expect(h.ctl.launches.slice(launchesBefore)).toStrictEqual([CHAT]);
    await expect(getHealth(h.origin)).resolves.toMatchObject({ status: 200, body: { status: "ready", model: CHAT } });
  });
});

// ---- default model fails at startup ----

describe("default model fails to load at startup", () => {
  test("health reports the error, a request gets 502 with the message, and the next request loads the model", async () => {
    const ctl = new Control();
    mock.failLaunch = "model file is corrupt";
    const log = spyOn(console, "error").mockImplementation(() => {});
    const app = await startApp(config(), ctl.launch);
    try {
      const { origin } = app.server.url;
      await until(() => app.engine.state === "error", "startup load to fail");

      const health = await getHealth(origin);
      expect(health.status).toBe(503);
      expect(health.body).toMatchObject({ status: "error", error: "model file is corrupt", model: null });

      const failed = await translate(origin, chatBody);
      expect(failed.status).toBe(502);
      await expect(failed.json()).resolves.toMatchObject({
        error: { code: "engine_error", message: "model file is corrupt" },
      });

      mock.failLaunch = undefined;
      const ok = await translate(origin, chatBody);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).model).toBe(CHAT);
      const recovered = await getHealth(origin);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toMatchObject({ status: "ready", model: CHAT });
      expect(recovered.body.error).toBeUndefined();
    } finally {
      mock.failLaunch = undefined;
      log.mockRestore();
      await app.stop();
    }
  });
});

// ---- model swaps ----

describe("model swaps", () => {
  const h = fixture({ maxQueue: 3 });

  test("while a swap is in progress, health and models name the target model (known quirk, review finding #8), and tokenize is refused", async () => {
    const release = h.ctl.holdLaunches();
    const pending = jsonOf(translate(h.origin, docBody));
    await until(() => h.app.engine.state === "loading", "swap to start");

    // Known quirk, review finding #8: the target model is reported as loaded before its engine is ready.
    const health = await getHealth(h.origin);
    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({ status: "loading", model: DOCUMENT });
    await expect(getJson(h.origin, "/api/v1/models")).resolves.toMatchObject({ default: CHAT, loaded: DOCUMENT });

    const busy = await tokenize(h.origin, chatBody);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("2");
    expect(((await busy.json()) as any).error.code).toBe("engine_unavailable");

    release();
    expect((await pending).model).toBe(DOCUMENT);
    await expect(getHealth(h.origin)).resolves.toMatchObject({
      status: 200,
      body: { status: "ready", model: DOCUMENT },
    });
  });

  test("a request waiting behind a swap that disconnects leaves the queue, and the swap still completes", async () => {
    await warm(h.origin, CHAT);
    const before = h.ctl.launches.length;
    const release = h.ctl.holdLaunches();
    const swap = jsonOf(translate(h.origin, docBody));
    await until(() => h.app.engine.state === "loading", "swap to start");

    const ac = new AbortController();
    const waiting = translate(h.origin, { text: "two", target_lang: "en" }, { signal: ac.signal });
    await until(async () => (await queueOf(h.origin)).waiting === 1, "second request to queue");
    ac.abort();
    await expect(waiting).rejects.toThrow();
    await until(async () => (await queueOf(h.origin)).waiting === 0, "second request to leave");
    await expect(queueOf(h.origin)).resolves.toMatchObject({ running: true, waiting: 0 });

    release();
    expect((await swap).model).toBe(DOCUMENT);
    await expect(queueOf(h.origin)).resolves.toMatchObject({ running: false, waiting: 0 });

    const next = await translate(h.origin, { text: "你好", target_lang: "en" });
    expect(next.status).toBe(200);
    expect(h.ctl.launches.slice(before)).toStrictEqual([DOCUMENT, CHAT]);
  });

  test("a client that disconnects during its own model load: the load finishes, the queue is freed, and the next request works", async () => {
    await warm(h.origin, CHAT);
    const before = h.ctl.launches.length;
    const release = h.ctl.holdLaunches();
    const ac = new AbortController();
    const abandoned = translate(h.origin, docBody, { signal: ac.signal });
    await until(() => h.app.engine.state === "loading", "swap to start");

    ac.abort();
    await expect(abandoned).rejects.toThrow();
    await until(async () => !(await queueOf(h.origin)).running, "queue slot to be freed");

    release();
    await until(async () => (await getHealth(h.origin)).status === 200, "document engine to be ready");
    expect((await getHealth(h.origin)).body.model).toBe(DOCUMENT);
    await expect(queueOf(h.origin)).resolves.toMatchObject({ running: false, waiting: 0 });

    const next = await translate(h.origin, { text: "你好", target_lang: "en" });
    expect(next.status).toBe(200);
    expect(((await next.json()) as any).model).toBe(CHAT);
    expect(h.ctl.launches.slice(before)).toStrictEqual([DOCUMENT, CHAT]);
  });

  // Abandoning a request frees the queue slot while its engine load is still in flight, so the next
  // request starts a second load. The older load must free its own model when it finishes.
  test("a swap abandoned mid-load does not leave its engine running when another request swaps again", async () => {
    await warm(h.origin, CHAT);
    const before = h.ctl.launches.length;
    try {
      const releaseDoc = h.ctl.holdLaunches();
      const ac = new AbortController();
      const abandoned = translate(h.origin, docBody, { signal: ac.signal });
      await until(() => h.app.engine.state === "loading", "swap to start");
      ac.abort();
      await expect(abandoned).rejects.toThrow();
      await until(async () => !(await queueOf(h.origin)).running, "queue slot to be freed");

      const releaseChat = h.ctl.holdLaunches();
      const next = jsonOf(translate(h.origin, { text: "你好", target_lang: "en" }));
      await until(() => h.ctl.launches.length === before + 2, "the chat engine to start loading");

      releaseDoc();
      await until(
        () => h.ctl.upstreams.filter((u) => u.model === DOCUMENT).every((u) => u.stopped),
        "the abandoned engine to be stopped",
      );
      expect(h.app.engine.state).toBe("loading");
      releaseChat();
      expect((await next).model).toBe(CHAT);

      // Only one engine may run at a time (see src/models.ts).
      expect(h.ctl.upstreams.filter((u) => !u.stopped).map((u) => u.model)).toStrictEqual([CHAT]);
    } finally {
      h.ctl.stopAll();
    }
  });
});

// ---- queue order across models ----

describe("queue order across models", () => {
  const h = fixture({ maxQueue: 5 });

  test("queued requests run in arrival order, never overlap, and each reports its own model", async () => {
    await warm(h.origin, CHAT);
    const launchesBefore = h.ctl.launches.length;
    const generationsBefore = h.ctl.generations.length;
    h.ctl.maxInFlight = 0;
    mock.delayMs = 5;

    const open = h.ctl.holdGenerations();
    const a = jsonOf(translate(h.origin, { text: "one", target_lang: "en" }));
    await until(async () => (await queueOf(h.origin)).running, "first request to run");
    const b = jsonOf(translate(h.origin, docBody));
    await until(async () => (await queueOf(h.origin)).waiting === 1, "document request to queue");
    const c = jsonOf(translate(h.origin, { text: "two", target_lang: "en" }));
    await until(async () => (await queueOf(h.origin)).waiting === 2, "chat request to queue");
    open();

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect([ra.model, rb.model, rc.model]).toStrictEqual([CHAT, DOCUMENT, CHAT]);
    expect(h.ctl.launches.slice(launchesBefore)).toStrictEqual([DOCUMENT, CHAT]);
    expect(h.ctl.generations.slice(generationsBefore).map((g) => g.model)).toStrictEqual([CHAT, DOCUMENT, CHAT]);
    expect(h.ctl.maxInFlight).toBe(1);
  });
});

// ---- queued events ----

describe("queued events", () => {
  const h = fixture({ maxQueue: 4 });

  test("a waiting SSE request sees its position fall as earlier requests finish", async () => {
    const open = h.ctl.holdGenerations();
    const a = sseEvents(await translate(h.origin, { text: "one", target_lang: "en", stream: true }));
    expect((await nextEvent(a)).event).toBe("start");
    const b = sseEvents(await translate(h.origin, { text: "two", target_lang: "en", stream: true }));
    await expect(nextEvent(b)).resolves.toStrictEqual({ event: "queued", data: { position: 1 } });
    const c = sseEvents(await translate(h.origin, { text: "three", target_lang: "en", stream: true }));
    await expect(nextEvent(c)).resolves.toStrictEqual({ event: "queued", data: { position: 2 } });

    open();
    const [, , cRest] = await Promise.all([collect(a), collect(b), collect(c)]);
    expect(queuedPositions(cRest)).toStrictEqual([1]);
    expect(cRest.map((e) => e.event)).toStrictEqual(["queued", "start", "delta", "delta", "delta", "done"]);
  });

  test("when a request in the middle disconnects, the one behind moves up and the one ahead keeps its place", async () => {
    const open = h.ctl.holdGenerations();
    const a = sseEvents(await translate(h.origin, { text: "one", target_lang: "en", stream: true }));
    expect((await nextEvent(a)).event).toBe("start");
    const b = sseEvents(await translate(h.origin, { text: "two", target_lang: "en", stream: true }));
    await expect(nextEvent(b)).resolves.toStrictEqual({ event: "queued", data: { position: 1 } });
    const cAbort = new AbortController();
    const c = sseEvents(
      await translate(h.origin, { text: "three", target_lang: "en", stream: true }, { signal: cAbort.signal }),
    );
    await expect(nextEvent(c)).resolves.toStrictEqual({ event: "queued", data: { position: 2 } });
    const d = sseEvents(await translate(h.origin, { text: "four", target_lang: "en", stream: true }));
    await expect(nextEvent(d)).resolves.toStrictEqual({ event: "queued", data: { position: 3 } });

    cAbort.abort();
    await until(async () => (await queueOf(h.origin)).waiting === 2, "middle request to leave");
    await expect(nextEvent(d)).resolves.toStrictEqual({ event: "queued", data: { position: 2 } });

    open();
    const [, bRest, dRest] = await Promise.all([collect(a), collect(b), collect(d)]);
    // B was first in line and never moved; the repeated position is harmless.
    expect(queuedPositions(bRest).every((p) => p === 1)).toBe(true);
    expect(bRest.at(-1)!.event).toBe("done");
    expect(queuedPositions(dRest)).toStrictEqual([1]);
    expect(dRest.at(-1)!.event).toBe("done");
  });
});

// ---- app.stop() during a stream ----

describe("stopping the app during a stream", () => {
  test("stop resolves, stops the engine, and the client's stream ends instead of hanging", async () => {
    const ctl = new Control();
    const app = await startApp(config(), ctl.launch);
    const { origin } = app.server.url;
    let stopped = false;
    try {
      await waitReady(app);
      const release = ctl.holdGenerations();
      const it = sseEvents(await translate(origin, { text: "long", target_lang: "en", stream: true }));
      expect((await nextEvent(it)).event).toBe("start");
      const upstream = ctl.latest();

      stopped = true;
      await within(app.stop(), 5000, "app.stop");
      await within(upstream.exited, 5000, "engine exit");
      expect(upstream.stopped).toBe(true);

      // The stream ends with a closed connection or an error event; either is fine, a hang is not.
      await within(
        collect(it).catch(() => []),
        5000,
        "client stream to end",
      );
      release();
    } finally {
      ctl.reset();
      if (!stopped) {
        await app.stop();
      }
    }
  });
});

// ---- SSE and JSON output details ----

describe("streaming and output details", () => {
  const h = fixture();

  test("SSE responses are not cached, not buffered by proxies, and are event streams", async () => {
    const res = await translate(h.origin, { text: "你好", target_lang: "en", stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await res.text();
  });

  test("finish_reason 'length' is reported in the JSON result and the SSE done event", async () => {
    mock.finish = "length";
    const json = await jsonOf(translate(h.origin, chatBody));
    expect(json.finish_reason).toBe("length");

    const events = await collect(sseEvents(await translate(h.origin, { ...chatBody, stream: true })));
    expect(events.at(-1)!.data.finish_reason).toBe("length");
  });

  test("a model that emits only an empty think block gives an empty translation, with no delta events", async () => {
    mock.chunks = ["<think>\n\n</think>\n\n"];
    await expect(jsonOf(translate(h.origin, chatBody))).resolves.toMatchObject({
      translation: "",
      finish_reason: "stop",
    });

    const events = await collect(sseEvents(await translate(h.origin, { ...chatBody, stream: true })));
    expect(events.map((e) => e.event)).toStrictEqual(["start", "done"]);
  });

  test("whitespace-only output is also an empty translation", async () => {
    mock.chunks = ["  ", "\n", "\t\n"];
    await expect(jsonOf(translate(h.origin, chatBody))).resolves.toMatchObject({ translation: "" });

    const events = await collect(sseEvents(await translate(h.origin, { ...chatBody, stream: true })));
    expect(events.map((e) => e.event)).toStrictEqual(["start", "done"]);
  });

  test("a think block with content is dropped from the translation", async () => {
    mock.chunks = ["<think>", "let me work this out", "</think>", "Hi there"];
    await expect(jsonOf(translate(h.origin, chatBody))).resolves.toMatchObject({ translation: "Hi there" });

    mock.chunks = ["<think>plan</think>Hello"];
    const events = await collect(sseEvents(await translate(h.origin, { ...chatBody, stream: true })));
    const text = events
      .filter((e) => e.event === "delta")
      .map((e) => e.data.text)
      .join("");
    expect(text).toBe("Hello");
  });

  test("an engine error after some deltas delivers those deltas first, then an error event", async () => {
    mock.failWith = "boom";
    const events = await collect(sseEvents(await translate(h.origin, { ...chatBody, stream: true })));
    expect(events.map((e) => e.event)).toStrictEqual(["start", "delta", "delta", "delta", "error"]);
    expect(
      events
        .filter((e) => e.event === "delta")
        .map((e) => e.data.text)
        .join(""),
    ).toBe("Hello, world");
    expect(events.at(-1)!.data).toMatchObject({ code: "engine_error", message: expect.stringContaining("boom") });
  });

  test("queue_ms is positive for a request that waited behind a slow one", async () => {
    const open = h.ctl.holdGenerations();
    const first = jsonOf(translate(h.origin, { text: "one", target_lang: "en" }));
    await until(async () => (await queueOf(h.origin)).running, "first request to run");
    const second = jsonOf(translate(h.origin, { text: "two", target_lang: "en" }));
    await until(async () => (await queueOf(h.origin)).waiting === 1, "second request to queue");
    // Hold the slot for a while so the wait is measurable; a timer never fires early, so the bound is safe.
    await Bun.sleep(20);
    open();

    expect((await second).timings.queue_ms).toBeGreaterThanOrEqual(10);
    await first;
  });

  test("usage.prompt_tokens falls back to the measured prompt size when the engine reports 0", async () => {
    h.ctl.zeroPromptUsage = true;
    const counted = ((await (await tokenize(h.origin, chatBody)).json()) as any).prompt_tokens;
    expect(counted).toBeGreaterThan(0);

    const json = await jsonOf(translate(h.origin, chatBody));
    expect(json.usage).toStrictEqual({ prompt_tokens: counted, completion_tokens: mock.chunks.length });

    const events = await collect(sseEvents(await translate(h.origin, { ...chatBody, stream: true })));
    expect(events.at(-1)!.data.usage.prompt_tokens).toBe(counted);
  });

  test("a failed generation releases the slot: queue is idle and the next request succeeds", async () => {
    mock.failWith = "out of memory";
    const failed = await translate(h.origin, chatBody);
    mock.failWith = undefined;
    expect(failed.status).toBe(502);
    await failed.text();
    await expect(queueOf(h.origin)).resolves.toMatchObject({ running: false, waiting: 0 });

    const next = await translate(h.origin, chatBody);
    expect(next.status).toBe(200);
    await next.text();
  });

  test("a failed SSE generation also releases the slot", async () => {
    mock.failWith = "device lost";
    const events = await collect(sseEvents(await translate(h.origin, { ...chatBody, stream: true })));
    mock.failWith = undefined;
    expect(events.at(-1)!.event).toBe("error");
    await expect(queueOf(h.origin)).resolves.toMatchObject({ running: false, waiting: 0 });

    expect((await collect(sseEvents(await translate(h.origin, { ...chatBody, stream: true })))).at(-1)!.event).toBe(
      "done",
    );
  });
});

// ---- queue full over SSE ----

describe("queue full over SSE", () => {
  const h = fixture({ maxQueue: 1 });

  test("a request turned away by a full queue gets a plain JSON 429 with Retry-After, not an event stream", async () => {
    const open = h.ctl.holdGenerations();
    const first = jsonOf(translate(h.origin, { text: "one", target_lang: "en" }));
    await until(async () => (await queueOf(h.origin)).running, "first request to run");
    const queued = sseEvents(await translate(h.origin, { text: "two", target_lang: "en", stream: true }));
    await expect(nextEvent(queued)).resolves.toStrictEqual({ event: "queued", data: { position: 1 } });

    const full = await translate(h.origin, { text: "three", target_lang: "en", stream: true });
    expect(full.status).toBe(429);
    expect(full.headers.get("content-type")).toStartWith("application/json");
    expect(full.headers.get("retry-after")).toBe("10");
    await expect(full.json()).resolves.toMatchObject({ error: { code: "queue_full", details: { max_queue: 1 } } });

    open();
    await first;
    expect((await collect(queued)).at(-1)!.event).toBe("done");
  });
});
