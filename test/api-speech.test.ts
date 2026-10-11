// The speech endpoints against a mock speech engine (test/helpers/mock-engine.ts), and the parts
// of the real one that need no audio.cpp: what it reports when nothing is installed, and how it
// lists voices.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, startApp } from "../src/app";
import { NativeSpeech, nativeSpeech } from "../src/speech";
import {
  config,
  launcher,
  mockSpeech,
  postTo,
  resetMockSpeech,
  silentWav,
  speechLauncher,
  waitReady,
} from "./helpers/mock-engine";

let app: App;
let base: string;

beforeAll(async () => {
  app = await startApp(config(), launcher, speechLauncher);
  base = app.server.url.origin;
  await waitReady(app);
});

afterAll(async () => {
  await app.stop();
});

afterEach(resetMockSpeech);

const speak = (body: unknown, init: RequestInit = {}) => postTo(base, "/api/v1/speech", body, init);

describe("POST /speech", () => {
  test("returns the WAV of the text, with the first voice and normal speed by default", async () => {
    const res = await speak({ text: "Hello there.", lang: "en" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(silentWav()));
    expect(mockSpeech.requests).toEqual([{ text: "Hello there.", lang: "en", voice: "voice_01", speed: 1 }]);
  });

  test("passes the chosen voice and speed on", async () => {
    await speak({ text: "你好。", lang: "ZH", voice: "voice_02", speed: 1.5 });
    expect(mockSpeech.requests).toEqual([{ text: "你好。", lang: "zh", voice: "voice_02", speed: 1.5 }]);
  });

  test.each([
    [{ lang: "en" }, "text"],
    [{ text: "   ", lang: "en" }, "text"],
    [{ text: "x".repeat(1001), lang: "en" }, "text"],
    [{ text: "Hallo", lang: "de" }, "lang"],
    [{ text: "Hello" }, "lang"],
    [{ text: "Hello", lang: "en", speed: 3 }, "speed"],
    [{ text: "Hello", lang: "en", speed: "fast" }, "speed"],
    [{ text: "Hello", lang: "en", voice: "../../etc/passwd" }, "voice"],
  ])("rejects %j, naming %s", async (body, field) => {
    const res = await speak(body);
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as any;
    expect(error.code).toBe("invalid_request");
    expect(error.details.field).toBe(field);
    expect(mockSpeech.requests).toEqual([]);
  });

  test("a text of exactly 1,000 code points is accepted", async () => {
    expect((await speak({ text: "好".repeat(1000), lang: "zh" })).status).toBe(200);
  });

  test("503 speech_unavailable when speech is not installed", async () => {
    mockSpeech.state = "unavailable";
    const res = await speak({ text: "Hello", lang: "en" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toEqual({
      code: "speech_unavailable",
      message: "the speech engine is not installed",
    });
  });

  test("503 speech_unavailable when there is no voice", async () => {
    const voices = mockSpeech.voices;
    mockSpeech.voices = [];
    try {
      const res = await speak({ text: "Hello", lang: "en" });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error.code).toBe("speech_unavailable");
    } finally {
      mockSpeech.voices = voices;
    }
  });

  test("502 speech_error when the engine fails", async () => {
    mockSpeech.failWith = "out of memory";
    const res = await speak({ text: "Hello", lang: "en" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toEqual({ code: "speech_error", message: "out of memory" });
  });

  test("one utterance at a time; beyond the queue it is 429", async () => {
    mockSpeech.delayMs = 150;
    const first = speak({ text: "one", lang: "en" });
    const second = speak({ text: "two", lang: "en" });
    await Bun.sleep(30);
    const third = await speak({ text: "three", lang: "en" });
    expect(third.status).toBe(429);
    expect(((await third.json()) as any).error.code).toBe("queue_full");
    expect((await Promise.all([first, second])).map((r) => r.status)).toEqual([200, 200]);
    expect(mockSpeech.requests.map((r) => r.text)).toEqual(["one", "two"]);
  });

  test("a client that goes away gives up its request", async () => {
    mockSpeech.delayMs = 200;
    const gone = new AbortController();
    const pending = speak({ text: "never heard", lang: "en" }, { signal: gone.signal }).catch(() => null);
    await Bun.sleep(30);
    gone.abort();
    await pending;
    for (let i = 0; i < 50 && mockSpeech.aborted === 0; i++) await Bun.sleep(10);
    expect(mockSpeech.aborted).toBe(1);
  });

  test("an abandoned utterance keeps its slot until the engine finishes it", async () => {
    mockSpeech.ignoreAbort = true;
    mockSpeech.delayMs = 250;
    const gone = new AbortController();
    const abandoned = speak({ text: "abandoned", lang: "en" }, { signal: gone.signal }).catch(() => null);
    await Bun.sleep(30);
    gone.abort();
    await abandoned;
    expect(mockSpeech.running).toBe(1);
    // One waiting is allowed (MAX_QUEUE is 1); a third is refused while the abandoned one runs.
    const waiting = speak({ text: "waits", lang: "en" });
    await Bun.sleep(30);
    const refused = await speak({ text: "refused", lang: "en" });
    expect(refused.status).toBe(429);
    expect((await waiting).status).toBe(200);
    expect(mockSpeech.running).toBe(0);
    expect(mockSpeech.requests.map((r) => r.text)).toEqual(["abandoned", "waits"]);
  });

  test("a request aborted while waiting in line is never sent to the engine", async () => {
    mockSpeech.delayMs = 150;
    const first = speak({ text: "first", lang: "en" });
    const gone = new AbortController();
    const queued = speak({ text: "queued", lang: "en" }, { signal: gone.signal }).catch(() => null);
    await Bun.sleep(30);
    gone.abort();
    await queued;
    expect((await first).status).toBe(200);
    expect((await speak({ text: "after", lang: "en" })).status).toBe(200);
    expect(mockSpeech.requests.map((r) => r.text)).toEqual(["first", "after"]);
  });

  test("does not hold the translation queue", async () => {
    mockSpeech.delayMs = 150;
    const speaking = speak({ text: "one", lang: "en" });
    await Bun.sleep(30);
    const translated = await postTo(base, "/api/v1/translate", { text: "Hi", target_lang: "zh" });
    expect(translated.status).toBe(200);
    expect((await speaking).status).toBe(200);
  });

  test("only POST with a JSON body", async () => {
    expect((await fetch(base + "/api/v1/speech")).status).toBe(405);
    const res = await speak(JSON.stringify({ text: "Hi", lang: "en" }), { headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(415);
  });
});

describe("GET /voices and health", () => {
  test("lists voices, languages and limits", async () => {
    const body = await (await fetch(base + "/api/v1/voices")).json();
    expect(body).toEqual({
      status: "stopped",
      languages: ["zh", "en", "ja", "es", "ar"],
      speed: { min: 0.5, max: 2 },
      max_chars: 1000,
      max_sample_bytes: 8 * 1024 * 1024,
      voices: mockSpeech.voices,
    });
  });

  test("health carries the speech engine's state", async () => {
    await speak({ text: "Hello", lang: "en" });
    const health = (await (await fetch(base + "/api/v1/health")).json()) as any;
    expect(health.speech).toEqual({ status: "ready" });
  });

  test("no voices are listed while speech is unavailable", async () => {
    mockSpeech.state = "unavailable";
    const body = (await (await fetch(base + "/api/v1/voices")).json()) as any;
    expect(body.status).toBe("unavailable");
    expect(body.error).toBe("the speech engine is not installed");
    expect(body.voices).toEqual([]);
  });
});

describe("the native speech engine without audio.cpp", () => {
  test("says what is missing, and refuses to synthesize", async () => {
    const speech = nativeSpeech(config());
    expect(speech.state).toBe("unavailable");
    expect(speech.error).toContain("bun scripts/build_audiocpp.ts");
    expect(nativeSpeech(config({ speech: false })).error).toContain("SPEECH=0");
    const request = { text: "Hi", lang: "en", voice: "a", speed: 1 };
    let released = 0;
    await expect(speech.synthesize(request, new AbortController().signal, () => released++)).rejects.toThrow(
      "not installed",
    );
    expect(released).toBe(1);
  });

  test("a voice is a .wav file in the voices directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voices-"));
    try {
      for (const name of ["narrator_two.wav", "alice.wav", "notes.txt", "clip.mp3"])
        await writeFile(join(dir, name), "");
      expect(await nativeSpeech(config({ voicesDir: dir })).voices()).toEqual([
        { id: "alice", name: "Alice" },
        { id: "narrator_two", name: "Narrator two" },
      ]);
      expect(await nativeSpeech(config({ voicesDir: join(dir, "missing") })).voices()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("NativeSpeech with a fake worker", () => {
  /** A worker that records what it is sent and answers when the test says so. */
  function fakeWorker() {
    const posted: any[] = [];
    const fake: any = {
      posted,
      onmessage: null,
      onerror: null,
      postMessage: (m: any) => posted.push(m),
      addEventListener() {},
      terminate() {},
      reply: (req: number, extra: object) => fake.onmessage({ data: { req, ...extra } }),
    };
    return fake;
  }
  const request = { text: "Hi", lang: "en", voice: "a", speed: 1 };
  const tick = () => Bun.sleep(5);

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "native-speech-"));
    await writeFile(join(dir, `libaudiocpp.${process.platform === "darwin" ? "dylib" : "so"}`), "");
    const worker = fakeWorker();
    const speech = new NativeSpeech(config({ speech: true, audioDir: dir, speechModelDir: dir }), () => worker);
    return { dir, worker, speech };
  }
  const kinds = (w: any) => w.posted.map((m: any) => m.type);

  test("an utterance aborted while the model loads is never posted", async () => {
    const { dir, worker, speech } = await setup();
    try {
      const gone = new AbortController();
      let released = 0;
      const result = speech.synthesize(request, gone.signal, () => released++);
      const rejected = result.then(
        () => null,
        (e) => e,
      );
      await tick();
      expect(kinds(worker)).toEqual(["load"]);
      gone.abort();
      expect(await rejected).toBe(gone.signal.reason);
      expect(released).toBe(1);
      worker.reply(worker.posted[0].req, { type: "ok" });
      await tick();
      expect(kinds(worker)).toEqual(["load"]);
      expect(released).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("a posted utterance that is aborted is released only when the worker is done", async () => {
    const { dir, worker, speech } = await setup();
    try {
      const gone = new AbortController();
      let released = 0;
      const result = speech.synthesize(request, gone.signal, () => released++);
      const rejected = result.then(
        () => null,
        (e) => e,
      );
      await tick();
      worker.reply(worker.posted[0].req, { type: "ok" });
      await tick();
      expect(kinds(worker)).toEqual(["load", "synthesize"]);
      gone.abort();
      expect(await rejected).toBe(gone.signal.reason);
      expect(released).toBe(0);
      worker.reply(worker.posted[1].req, { type: "audio", wav: new ArrayBuffer(4) });
      await tick();
      expect(released).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("POST /voices", () => {
  const upload = (body: string | Uint8Array, type = "audio/wav") =>
    fetch(`${base}/api/v1/voices?name=${encodeURIComponent("My voice")}`, {
      method: "POST",
      headers: { "content-type": type },
      body,
    });

  test("a WAV sample becomes a voice", async () => {
    const wav = new Uint8Array(64);
    wav.set(new TextEncoder().encode("RIFF"), 0);
    const res = await upload(wav);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe("My voice");
  });

  test("anything else is refused", async () => {
    expect((await upload(new Uint8Array(64))).status).toBe(400);
    expect((await upload("{}", "application/json")).status).toBe(415);
  });
});
