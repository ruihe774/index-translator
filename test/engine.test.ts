// Unit tests for src/llama.ts: the Engine lifecycle and streaming against an in-process fake
// llama-server (scripted bytes, status codes and exits), and launchLlamaServer against a fake
// binary: a shell script that records its argv and sleeps. No real llama-server runs.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Engine,
  EngineError,
  launchLlamaServer,
  type GenerationEvent,
  type Launcher,
  type Running,
} from "../src/llama";
import { MODELS } from "../src/models";
import { TEMPLATE, config } from "./helpers/mock-engine";

// ---- fake upstream -------------------------------------------------------------------------

interface Live {
  url: string;
  exited: Promise<number>;
  /** Stops answering HTTP without ending the process, as if the socket were gone. */
  stopServer(): Promise<void>;
  /** Stops answering and resolves `exited` with `code`, as if the process had ended. */
  end(code: number): Promise<void>;
}

const fake = {
  health: 200,
  template: TEMPLATE,
  /** Replaces a route's response by path, e.g. to make /tokenize fail. */
  override: {} as Record<string, () => Response | Promise<Response>>,
  completion: ((_req: Request) => streamed(OK_BODY)) as (req: Request) => Response,
  requests: [] as any[],
  aborted: 0,
  launches: [] as string[],
  stops: 0,
  launchError: undefined as Error | undefined,
  live: [] as Live[],
};

async function route(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (fake.override[path]) return fake.override[path]();
  if (path === "/health") {
    return Response.json({ status: fake.health === 200 ? "ok" : "loading" }, { status: fake.health });
  }
  if (path === "/apply-template") return Response.json({ prompt: fake.template });
  if (path === "/tokenize") {
    const { content } = (await req.json()) as { content: string };
    return Response.json({ tokens: Array.from(content, (_, i) => i) });
  }
  if (path === "/v1/chat/completions") {
    fake.requests.push(await req.json());
    req.signal.addEventListener("abort", () => fake.aborted++);
    return fake.completion(req);
  }
  return new Response("not found", { status: 404 });
}

const launcher: Launcher = async (model) => {
  if (fake.launchError) throw fake.launchError;
  fake.launches.push(model.id);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: route });
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (finish = resolve));
  let serverDown: Promise<void> | undefined;
  const live: Live = {
    url: `http://127.0.0.1:${server.port}`,
    exited,
    stopServer: () => (serverDown ??= server.stop(true)),
    end: async (code) => {
      await live.stopServer();
      finish(code);
    },
  };
  fake.live.push(live);
  return {
    url: live.url,
    exited,
    stop() {
      fake.stops++;
      void live.end(0);
    },
  };
};

// ---- response builders ---------------------------------------------------------------------

const frame = (data: unknown) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const token = (content: string) => frame({ choices: [{ delta: { content }, finish_reason: null }] });
const finishFrame = (reason: string) => frame({ choices: [{ delta: {}, finish_reason: reason }] });
const USAGE = frame({
  choices: [],
  usage: { prompt_tokens: 42, completion_tokens: 2 },
  timings: { prompt_ms: 12.4, predicted_ms: 99.6, predicted_per_second: 70.123 },
});
const DONE = frame("[DONE]");
// An empty delta is skipped; the rest is the normal happy-path stream.
const OK_BODY = token("Hel") + token("") + token("lo") + finishFrame("stop") + USAGE + DONE;

/** A body delivered in pieces of `chunk` bytes (0 = one piece), with a macrotask between pieces. */
function streamed(text: string, chunk = 0): Response {
  const bytes = new TextEncoder().encode(text);
  const size = chunk || bytes.length || 1;
  const pieces: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.subarray(i, i + size));
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const piece of pieces) {
          controller.enqueue(piece);
          if (chunk) await Bun.sleep(1);
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Sends `first`, then keeps the stream open until the client disconnects. */
function holdOpen(req: Request, first: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
        req.signal.addEventListener(
          "abort",
          () => {
            try {
              controller.close();
            } catch {}
          },
          { once: true },
        );
      },
    }),
  );
}

// ---- helpers -------------------------------------------------------------------------------

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

async function errorOf(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

async function collect(gen: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const events: GenerationEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

const engines: Engine[] = [];

function newEngine(launch: Launcher = launcher): Engine {
  const engine = new Engine(config(), launch);
  engines.push(engine);
  return engine;
}

async function readyEngine(): Promise<Engine> {
  const engine = newEngine();
  await engine.load(MODELS[0]);
  return engine;
}

const DONE_STOP = {
  type: "done",
  finishReason: "stop",
  usage: { prompt_tokens: 42, completion_tokens: 2 },
  timings: { prompt_ms: 12, generation_ms: 100, tokens_per_second: 70.12 },
};

let silence: ReturnType<typeof spyOn>;

beforeEach(() => {
  silence = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.unload();
  await Promise.all(fake.live.map((l) => l.end(0)));
  silence.mockRestore();
  fake.health = 200;
  fake.template = TEMPLATE;
  fake.override = {};
  fake.completion = (_req) => streamed(OK_BODY);
  fake.requests = [];
  fake.aborted = 0;
  fake.launches = [];
  fake.stops = 0;
  fake.launchError = undefined;
  fake.live = [];
});

// ---- Engine lifecycle ----------------------------------------------------------------------

describe("Engine lifecycle", () => {
  test("load marks the engine ready and measures the template overhead", async () => {
    fake.template = "<|im_start|>user\n\n<|im_end|>\n";
    const engine = newEngine();
    await engine.load(MODELS[0]);
    expect(engine.state).toBe("ready");
    expect(engine.loaded).toBe(MODELS[0]);
    expect(engine.error).toBeUndefined();
    expect(engine.templateOverhead).toBe(fake.template.length);
    expect(fake.launches).toEqual([MODELS[0].id]);
  });

  test("load of the model already loaded keeps the running engine", async () => {
    const engine = newEngine();
    await engine.load(MODELS[0]);
    await engine.load(MODELS[0]);
    expect(fake.launches).toHaveLength(1);
    expect(fake.stops).toBe(0);
  });

  test("load of another model stops the engine and starts the new one", async () => {
    const engine = newEngine();
    await engine.load(MODELS[0]);
    await engine.load(MODELS[1]);
    expect(fake.launches).toEqual([MODELS[0].id, MODELS[1].id]);
    expect(fake.stops).toBe(1);
    expect(engine.state).toBe("ready");
    expect(engine.loaded).toBe(MODELS[1]);
  });

  test("a launcher EngineError fails the load and a retry recovers", async () => {
    fake.launchError = new EngineError("no GPU backend");
    const engine = newEngine();
    const err = await errorOf(engine.load(MODELS[0]));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("no GPU backend");
    expect(engine.state).toBe("error");
    expect(engine.error).toBe("no GPU backend");
    expect(engine.loaded).toBeUndefined();

    fake.launchError = undefined;
    await engine.load(MODELS[0]);
    expect(engine.state).toBe("ready");
    expect(engine.error).toBeUndefined();
  });

  test("a plain Error from the launcher is wrapped as EngineError", async () => {
    fake.launchError = new Error("spawn EACCES");
    const engine = newEngine();
    const err = await errorOf(engine.load(MODELS[0]));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("spawn EACCES");
    expect(engine.state).toBe("error");
    expect(engine.error).toBe("spawn EACCES");
  });

  test("the process exiting before /health is ready fails the load with its exit code", async () => {
    fake.health = 503;
    const engine = newEngine();
    const loading = errorOf(engine.load(MODELS[0]));
    await until(() => fake.live.length > 0, "the engine to launch");
    await fake.live[0].end(3);
    const err = await loading;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("llama-server exited with code 3");
    expect(engine.state).toBe("error");
    expect(engine.error).toBe("llama-server exited with code 3");
    expect(engine.loaded).toBeUndefined();
  });

  test("an unexpected exit while ready marks the engine error and the next load recovers", async () => {
    const engine = newEngine();
    await engine.load(MODELS[0]);
    await fake.live[0].end(9);
    await until(() => engine.state === "error", "the exit to be noticed");
    expect(engine.loaded).toBeUndefined();
    expect(engine.error).toContain("code 9");

    await engine.load(MODELS[0]);
    expect(engine.state).toBe("ready");
    expect(engine.error).toBeUndefined();
    expect(fake.launches).toHaveLength(2);
  });

  test("unload is idempotent and leaves the engine stopped", async () => {
    const engine = newEngine();
    await engine.load(MODELS[0]);
    await engine.unload();
    await engine.unload();
    expect(engine.state).toBe("stopped");
    expect(engine.loaded).toBeUndefined();
    expect(fake.stops).toBe(1);
  });

  test("unload before any load is a no-op", async () => {
    const engine = newEngine();
    await engine.unload();
    expect(engine.state).toBe("stopped");
    expect(fake.stops).toBe(0);
  });
});

// ---- countPromptTokens ---------------------------------------------------------------------

describe("countPromptTokens", () => {
  test("throws EngineError before any load", async () => {
    const engine = newEngine();
    const err = await errorOf(engine.countPromptTokens("hi"));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("the engine is stopped");
  });

  test("throws EngineError while the model is still loading", async () => {
    fake.health = 503;
    const engine = newEngine();
    const loading = engine.load(MODELS[0]);
    await until(() => fake.live.length > 0, "the engine to launch");
    const err = await errorOf(engine.countPromptTokens("hi"));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("the engine is loading");

    fake.health = 200;
    await loading;
    expect(await engine.countPromptTokens("hi")).toBe(2 + TEMPLATE.length);
  });

  test("throws EngineError after unload", async () => {
    const engine = newEngine();
    await engine.load(MODELS[0]);
    await engine.unload();
    const err = await errorOf(engine.countPromptTokens("hi"));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("the engine is stopped");
  });

  test("throws EngineError after the engine exited unexpectedly", async () => {
    const engine = newEngine();
    await engine.load(MODELS[0]);
    await fake.live[0].end(1);
    await until(() => engine.state === "error", "the exit to be noticed");
    const err = await errorOf(engine.countPromptTokens("hi"));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("the engine is error");
  });

  test("adds the template overhead to the tokenized content", async () => {
    const engine = await readyEngine();
    expect(engine.templateOverhead).toBe(TEMPLATE.length);
    expect(await engine.countPromptTokens("hello")).toBe(5 + TEMPLATE.length);
    expect(await engine.countPromptTokens("你好")).toBe(2 + TEMPLATE.length);
  });

  test("falls back to 32 tokens of overhead when /apply-template fails", async () => {
    fake.override["/apply-template"] = () => new Response("oops", { status: 500 });
    const engine = newEngine();
    await engine.load(MODELS[0]);
    expect(engine.state).toBe("ready");
    expect(engine.templateOverhead).toBe(32);
    expect(silence).toHaveBeenCalledWith(expect.stringContaining("could not measure template overhead"));
    expect(await engine.countPromptTokens("ab")).toBe(2 + 32);
  });
});

// ---- error mapping -------------------------------------------------------------------------

describe("upstream errors", () => {
  test("a JSON error body becomes EngineError with its message and status", async () => {
    const engine = await readyEngine();
    fake.override["/tokenize"] = () => Response.json({ error: { message: "context overflow" } }, { status: 500 });
    const err = await errorOf(engine.countPromptTokens("x"));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toContain("/tokenize");
    expect(err.message).toContain("HTTP 500");
    expect(err.message).toContain("context overflow");
  });

  test("a plain-text error body is passed through as the message", async () => {
    const engine = await readyEngine();
    fake.override["/tokenize"] = () => new Response("upstream busy", { status: 503 });
    const err = await errorOf(engine.countPromptTokens("x"));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("llama-server /tokenize failed (HTTP 503): upstream busy");
  });

  test("an unreachable llama-server is reported as EngineError", async () => {
    const engine = await readyEngine();
    await fake.live[0].stopServer();
    const err = await errorOf(engine.countPromptTokens("x"));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toContain("llama-server unreachable");
  });

  test("a generation HTTP error is reported with its status", async () => {
    const engine = await readyEngine();
    fake.override["/v1/chat/completions"] = () => Response.json({ error: { message: "bad request" } }, { status: 400 });
    const err = await errorOf(collect(engine.generate("hi", 16)));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("llama-server /v1/chat/completions failed (HTTP 400): bad request");
  });
});

// ---- generate ------------------------------------------------------------------------------

describe("generate", () => {
  test("streams deltas then a done event with usage and rounded timings", async () => {
    const engine = await readyEngine();
    const events = await collect(engine.generate("hi", 16));
    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      DONE_STOP,
    ] as GenerationEvent[]);
  });

  test("request body is one user message with deterministic settings", async () => {
    const engine = await readyEngine();
    await collect(engine.generate("translate me", 64));
    expect(fake.requests).toEqual([
      {
        messages: [{ role: "user", content: "translate me" }],
        temperature: 0,
        max_tokens: 64,
        stream: true,
        stream_options: { include_usage: true },
        cache_prompt: false,
      },
    ]);
  });

  test("frames split into 1-3 byte chunks decode the same as one body", async () => {
    const body = token("你好") + token("😀") + finishFrame("stop") + DONE;
    const engine = await readyEngine();
    fake.completion = () => streamed(body);
    const whole = await collect(engine.generate("hi", 16));
    expect(whole.filter((e) => e.type === "delta").map((e) => (e as any).text)).toEqual(["你好", "😀"]);
    for (const chunk of [1, 2, 3]) {
      fake.completion = () => streamed(body, chunk);
      expect(await collect(engine.generate("hi", 16))).toEqual(whole);
    }
  });

  test("multi-byte UTF-8 characters split across 1-byte chunks decode intact", async () => {
    const engine = await readyEngine();
    fake.completion = () => streamed(token("你好😀界") + finishFrame("stop") + DONE, 1);
    const events = await collect(engine.generate("hi", 16));
    expect(events[0]).toEqual({ type: "delta", text: "你好😀界" });
    expect(JSON.stringify(events)).not.toContain("\\ufffd");
  });

  test("CRLF line endings parse the same as LF", async () => {
    const engine = await readyEngine();
    const lf = await collect(engine.generate("hi", 16));
    fake.completion = () => streamed(OK_BODY.replaceAll("\n", "\r\n"));
    expect(await collect(engine.generate("hi", 16))).toEqual(lf);
  });

  test("comment, blank and non-data lines are ignored", async () => {
    const engine = await readyEngine();
    fake.completion = () =>
      streamed(
        ": ping\n\nevent: chunk\nid: 7\nretry: 100\n\n" +
          token("A") +
          `data:${JSON.stringify({ choices: [{ delta: { content: "B" }, finish_reason: null }] })}\n\n` +
          finishFrame("stop") +
          DONE,
      );
    const events = await collect(engine.generate("hi", 16));
    expect(events.slice(0, 2)).toEqual([
      { type: "delta", text: "A" },
      { type: "delta", text: "B" },
    ]);
  });

  test("[DONE] without a finish reason is an error", async () => {
    const engine = await readyEngine();
    fake.completion = () => streamed(token("Hi") + DONE);
    const err = await errorOf(collect(engine.generate("hi", 16)));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("generation ended without a finish reason");
  });

  test("the stream closing without a finish reason is an error", async () => {
    const engine = await readyEngine();
    fake.completion = () => streamed(token("Hi"));
    const err = await errorOf(collect(engine.generate("hi", 16)));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("generation ended without a finish reason");
  });

  test("an error frame fails generation with its message", async () => {
    const engine = await readyEngine();
    fake.completion = () => streamed(token("a") + frame({ error: { message: "out of memory" } }));
    const err = await errorOf(collect(engine.generate("hi", 16)));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("generation failed: out of memory");
  });

  test("an error frame without a message is reported as JSON", async () => {
    const engine = await readyEngine();
    fake.completion = () => streamed(frame({ error: { code: 500, type: "server" } }));
    const err = await errorOf(collect(engine.generate("hi", 16)));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe('generation failed: {"code":500,"type":"server"}');
  });

  test("finish_reason length maps to length", async () => {
    const engine = await readyEngine();
    fake.completion = () => streamed(token("x") + finishFrame("length") + DONE);
    const events = await collect(engine.generate("hi", 16));
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "length" });
  });

  test("any other finish_reason maps to stop", async () => {
    const engine = await readyEngine();
    for (const reason of ["stop", "eos", "stop_sequence"]) {
      fake.completion = () => streamed(token("x") + finishFrame(reason) + DONE);
      const events = await collect(engine.generate("hi", 16));
      expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
    }
  });

  test("missing usage and timings default to zeros", async () => {
    const engine = await readyEngine();
    fake.completion = () => streamed(token("x") + finishFrame("stop") + DONE);
    const events = await collect(engine.generate("hi", 16));
    expect(events.at(-1)).toEqual({
      type: "done",
      finishReason: "stop",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      timings: { prompt_ms: 0, generation_ms: 0, tokens_per_second: 0 },
    });
  });

  test("a malformed data line rejects with a raw SyntaxError", async () => {
    const engine = await readyEngine();
    fake.completion = () => streamed(token("x") + "data: {not json}\n\n" + DONE);
    const err = await errorOf(collect(engine.generate("hi", 16)));
    // Known low-severity issue: this should become an EngineError like the other stream failures.
    expect(err).toBeInstanceOf(SyntaxError);
    expect(err).not.toBeInstanceOf(EngineError);
  });

  test("aborting mid-stream rejects with AbortError and the upstream sees the disconnect", async () => {
    const engine = await readyEngine();
    fake.completion = (req) => holdOpen(req, frame({ choices: [{ delta: { content: "Hel" }, finish_reason: null }] }));
    const ac = new AbortController();
    const it = engine.generate("hi", 16, ac.signal)[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: "delta", text: "Hel" });
    ac.abort();
    const err = await errorOf(it.next());
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(EngineError);
    await until(() => fake.aborted === 1, "the upstream to see the disconnect");
  });
});

// ---- launchLlamaServer ---------------------------------------------------------------------

const TMP = join(import.meta.dir, ".tmp-engine");
const MODELS_DIR = join(TMP, "models");
const EMPTY_DIR = join(TMP, "empty");
const FAKE_BIN = join(TMP, "llama-server");
const ARGS_FILE = join(TMP, "argv.txt");
const PID_FILE = join(TMP, "pid.txt");

// Records argv (written atomically), its own pid, then becomes `sleep` so SIGTERM ends it.
const FAKE_SCRIPT = [
  "#!/bin/sh",
  `for a in "$@"; do printf '%s\\n' "$a"; done > '${ARGS_FILE}.tmp' && mv '${ARGS_FILE}.tmp' '${ARGS_FILE}'`,
  `echo $$ > '${PID_FILE}.tmp' && mv '${PID_FILE}.tmp' '${PID_FILE}'`,
  "exec sleep 30",
  "",
].join("\n");

const started: Running[] = [];

function valueOf(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i < 0) throw new Error(`argv has no ${flag}`);
  return args[i + 1];
}

async function startFake(overrides: Partial<ReturnType<typeof config>> = {}) {
  rmSync(ARGS_FILE, { force: true });
  rmSync(PID_FILE, { force: true });
  const running = await launchLlamaServer(
    MODELS[0],
    config({ modelsDir: MODELS_DIR, llamaBin: FAKE_BIN, ...overrides }),
  );
  started.push(running);
  await until(() => existsSync(PID_FILE), "the fake llama-server to start");
  const args = readFileSync(ARGS_FILE, "utf8").split("\n").slice(0, -1);
  return { running, args, pid: Number(readFileSync(PID_FILE, "utf8")) };
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(MODELS_DIR, { recursive: true });
  mkdirSync(EMPTY_DIR, { recursive: true });
  writeFileSync(join(MODELS_DIR, MODELS[0].file), "");
  writeFileSync(FAKE_BIN, FAKE_SCRIPT);
  chmodSync(FAKE_BIN, 0o755);
});

afterAll(async () => {
  for (const running of started.splice(0)) {
    running.stop();
    await running.exited;
  }
  rmSync(TMP, { recursive: true, force: true });
});

describe("launchLlamaServer", () => {
  test("a missing model file fails with a fetch_models hint", async () => {
    const err = await errorOf(launchLlamaServer(MODELS[0], config({ modelsDir: EMPTY_DIR, llamaBin: FAKE_BIN })));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toContain("fetch_models");
    expect(err.message).toContain(join(EMPTY_DIR, MODELS[0].file));
  });

  test("a missing binary fails with a fetch_llama hint", async () => {
    const err = await errorOf(
      launchLlamaServer(MODELS[0], config({ modelsDir: MODELS_DIR, llamaBin: join(TMP, "no-such-llama-server") })),
    );
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toContain("fetch_llama");
  });

  test("the command line carries the engine defaults and llamaExtraArgs last", async () => {
    const { args, running } = await startFake({ gpuLayers: "35", ctxSize: 4096, llamaExtraArgs: ["--threads", "8"] });
    expect(valueOf(args, "--model")).toBe(join(MODELS_DIR, MODELS[0].file));
    expect(valueOf(args, "--alias")).toBe(MODELS[0].id);
    expect(valueOf(args, "--host")).toBe("127.0.0.1");
    expect(valueOf(args, "--port")).toBe(String(Number(new URL(running.url).port)));
    expect(valueOf(args, "--gpu-layers")).toBe("35");
    expect(valueOf(args, "--ctx-size")).toBe("4096");
    expect(valueOf(args, "--parallel")).toBe("1");
    expect(valueOf(args, "--chat-template-kwargs")).toBe('{"enable_thinking":false}');
    for (const flag of ["--no-context-shift", "--jinja", "--no-webui", "--offline"]) {
      expect(args).toContain(flag);
    }
    expect(args.slice(-2)).toEqual(["--threads", "8"]);
  });

  test("a non-zero llamaPort is used as given", async () => {
    const { args, running } = await startFake({ llamaPort: 47819 });
    expect(valueOf(args, "--port")).toBe("47819");
    expect(running.url).toBe("http://127.0.0.1:47819");
  });

  test("llamaPort 0 picks a free port and passes it to the process", async () => {
    const { args, running } = await startFake({ llamaPort: 0 });
    const port = Number(new URL(running.url).port);
    expect(port).toBeGreaterThan(0);
    expect(valueOf(args, "--port")).toBe(String(port));
  });

  test("stop() terminates the child and exited resolves", async () => {
    // Not pushed to `started`: this test stops the process itself.
    rmSync(PID_FILE, { force: true });
    const running = await launchLlamaServer(MODELS[0], config({ modelsDir: MODELS_DIR, llamaBin: FAKE_BIN }));
    await until(() => existsSync(PID_FILE), "the fake llama-server to start");
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();

    running.stop();
    await Promise.race([
      running.exited,
      Bun.sleep(5000).then(() => {
        throw new Error("child did not exit after stop()");
      }),
    ]);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
