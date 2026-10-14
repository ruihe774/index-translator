// The speech endpoints against a mock speech engine (test/helpers/mock-engine.ts), and the parts
// of the real one that need no audio.cpp: what it reports when nothing is installed, and how it
// lists voices.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type App, startApp } from "../src/app";
import { libraryPath } from "../src/audiocpp-ffi";
import {
  MAX_UPLOADED_VOICES,
  NativeSpeech,
  nativeSpeech,
  SeparationError,
  SpeechError,
  validateSample,
} from "../src/speech";
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

afterEach(resetMockSpeech);

afterAll(async () => {
  await app.stop();
});

const speak = (body: unknown, init: RequestInit = {}) => postTo(base, "/api/v1/speech", body, init);

describe("POST /speech", () => {
  test("returns the WAV of the text, with the first voice and normal speed by default", async () => {
    const res = await speak({ text: "Hello there.", lang: "en" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await res.arrayBuffer())).toStrictEqual(new Uint8Array(silentWav()));
    expect(mockSpeech.requests).toStrictEqual([{ text: "Hello there.", lang: "en", voice: "voice_01", speed: 1 }]);
  });

  test("passes the chosen voice and speed on", async () => {
    await speak({ text: "你好。", lang: "ZH", voice: "voice_02", speed: 1.5 });
    expect(mockSpeech.requests).toStrictEqual([{ text: "你好。", lang: "zh", voice: "voice_02", speed: 1.5 }]);
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
    expect(mockSpeech.requests).toStrictEqual([]);
  });

  test("a text of exactly 1,000 code points is accepted", async () => {
    expect((await speak({ text: "好".repeat(1000), lang: "zh" })).status).toBe(200);
  });

  test("503 speech_unavailable when speech is not installed", async () => {
    mockSpeech.state = "unavailable";
    const res = await speak({ text: "Hello", lang: "en" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toStrictEqual({
      code: "speech_unavailable",
      message: "the speech engine is not installed",
    });
  });

  test("503 speech_unavailable when there is no voice", async () => {
    const { voices } = mockSpeech;
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
    expect(((await res.json()) as any).error).toStrictEqual({ code: "speech_error", message: "out of memory" });
  });

  test("one utterance at a time; beyond the queue it is 429", async () => {
    mockSpeech.delayMs = 150;
    const first = speak({ text: "one", lang: "en" });
    const second = speak({ text: "two", lang: "en" });
    await Bun.sleep(30);
    const third = await speak({ text: "three", lang: "en" });
    expect(third.status).toBe(429);
    expect(((await third.json()) as any).error.code).toBe("queue_full");
    expect((await Promise.all([first, second])).map((r) => r.status)).toStrictEqual([200, 200]);
    expect(mockSpeech.requests.map((r) => r.text)).toStrictEqual(["one", "two"]);
  });

  test("a client that goes away gives up its request", async () => {
    mockSpeech.delayMs = 200;
    const gone = new AbortController();
    const pending = speak({ text: "never heard", lang: "en" }, { signal: gone.signal }).catch(() => null);
    await Bun.sleep(30);
    gone.abort();
    await pending;
    for (let i = 0; i < 50 && mockSpeech.aborted === 0; i++) {
      await Bun.sleep(10);
    }
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
    expect(mockSpeech.requests.map((r) => r.text)).toStrictEqual(["abandoned", "waits"]);
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
    expect(mockSpeech.requests.map((r) => r.text)).toStrictEqual(["first", "after"]);
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
    expect(body).toStrictEqual({
      status: "stopped",
      languages: ["zh", "en", "ja", "es", "ar"],
      speed: { min: 0.5, max: 2 },
      max_chars: 1000,
      max_sample_bytes: 8 * 1024 * 1024,
      sample_seconds: { min: 1, max: 60 },
      sample_rate: { min: 8000, max: 192_000 },
      voices: mockSpeech.voices,
    });
  });

  test("health carries the speech engine's state", async () => {
    await speak({ text: "Hello", lang: "en" });
    const health = (await (await fetch(base + "/api/v1/health")).json()) as any;
    expect(health.speech).toStrictEqual({ status: "ready" });
  });

  test("no voices are listed while speech is unavailable", async () => {
    mockSpeech.state = "unavailable";
    const body = (await (await fetch(base + "/api/v1/voices")).json()) as any;
    expect(body.status).toBe("unavailable");
    expect(body.error).toBe("the speech engine is not installed");
    expect(body.voices).toStrictEqual([]);
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
      for (const name of ["narrator_two.wav", "alice.wav", "notes.txt", "clip.mp3"]) {
        await Bun.write(join(dir, name), "");
      }
      await expect(nativeSpeech(config({ voicesDir: dir })).voices()).resolves.toStrictEqual([
        { id: "alice", name: "Alice" },
        { id: "narrator_two", name: "Narrator two" },
      ]);
      await expect(nativeSpeech(config({ voicesDir: join(dir, "missing") })).voices()).resolves.toStrictEqual([]);
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
    await Bun.write(libraryPath(dir), "");
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
      expect(kinds(worker)).toStrictEqual(["load"]);
      gone.abort();
      await expect(rejected).resolves.toBe(gone.signal.reason);
      expect(released).toBe(1);
      worker.reply(worker.posted[0].req, { type: "ok" });
      await tick();
      expect(kinds(worker)).toStrictEqual(["load"]);
      expect(released).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("a posted utterance that is aborted is flagged for the worker and released when it says it stopped", async () => {
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
      expect(kinds(worker)).toStrictEqual(["load", "synthesize"]);
      // The flag the worker thread and the library read while no message can reach them.
      expect(worker.posted[1].abort).toBeInstanceOf(SharedArrayBuffer);
      const flag = new Int32Array(worker.posted[1].abort);
      expect(flag[0]).toBe(0);
      gone.abort();
      expect(flag[0]).toBe(1);
      await expect(rejected).resolves.toBe(gone.signal.reason);
      expect(released).toBe(0);
      worker.reply(worker.posted[1].req, { type: "aborted" });
      await tick();
      expect(released).toBe(1);
      expect(speech.state).toBe("ready");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("an utterance that finished just before the abort reached the engine is released as well", async () => {
    const { dir, worker, speech } = await setup();
    try {
      const gone = new AbortController();
      let released = 0;
      const rejected = speech
        .synthesize(request, gone.signal, () => released++)
        .then(
          () => null,
          (e) => e,
        );
      await tick();
      worker.reply(worker.posted[0].req, { type: "ok" });
      await tick();
      gone.abort();
      await expect(rejected).resolves.toBe(gone.signal.reason);
      worker.reply(worker.posted[1].req, { type: "audio", wav: new ArrayBuffer(4) });
      await tick();
      expect(released).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("every utterance has a flag of its own", async () => {
    const { dir, worker, speech } = await setup();
    try {
      const gone = new AbortController();
      speech.synthesize(request, gone.signal, () => {}).catch(() => {});
      await tick();
      worker.reply(worker.posted[0].req, { type: "ok" });
      await tick();
      const kept = speech.synthesize(request, new AbortController().signal, () => {});
      await tick();
      gone.abort();
      expect(new Int32Array(worker.posted[1].abort)[0]).toBe(1);
      expect(new Int32Array(worker.posted[2].abort)[0]).toBe(0);
      worker.reply(worker.posted[1].req, { type: "aborted" });
      worker.reply(worker.posted[2].req, { type: "audio", wav: new ArrayBuffer(4) });
      await expect(kept).resolves.toBeInstanceOf(ArrayBuffer);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("NativeSpeech state machine with a scripted worker", () => {
  /** A test sets this to keep the worker from answering a load, and answers it itself. */
  let holdLoads = false;
  /** Answers like speech-worker.ts unless `manual`. */
  function scripted() {
    const w: any = {
      posted: [] as any[],
      listeners: {} as Record<string, () => void>,
      failLoad: undefined as string | undefined,
      failSeparation: undefined as string | undefined,
      manual: false,
      onmessage: null,
      onerror: null,
      terminated: false,
      postMessage(m: any) {
        w.posted.push(m);
        if (!w.manual && !(holdLoads && m.type === "load")) {
          setTimeout(() => w.answer(m), 1);
        }
      },
      answer(m: any) {
        if (m.type === "load" && w.failLoad) {
          w.onmessage({ data: { req: m.req, type: "error", message: w.failLoad } });
        } else if (m.type === "synthesize") {
          w.onmessage({ data: { req: m.req, type: "audio", wav: silentWav() } });
        } else if (m.type === "separate") {
          if (w.failSeparation) {
            w.onmessage({ data: { req: m.req, type: "error", message: w.failSeparation } });
          } else {
            w.onmessage({ data: { req: m.req, type: "audio", wav: separated() } });
          }
        } else {
          w.onmessage({ data: { req: m.req, type: "ok" } });
        }
      },
      addEventListener(type: string, fn: () => void) {
        w.listeners[type] = fn;
      },
      terminate() {
        w.terminated = true;
      },
    };
    return w;
  }
  const kinds = (w: any) => w.posted.map((m: any) => m.type);
  const request = { text: "Hi", lang: "en", voice: "a", speed: 1 };
  const say = (speech: NativeSpeech) => speech.synthesize(request, new AbortController().signal, () => {});
  const wav = () => silentWav(1.5, 16_000);
  /** What the worker answers a separation with: recognizably not the uploaded sample. */
  const separated = () => silentWav(2, 44_100);
  const quiet = () => spyOn(console, "error").mockImplementation(() => {});

  /** `separation`: the separation model is installed (a .gguf file in its directory). */
  async function setup(overrides: object = {}, separation = false) {
    const dir = await mkdtemp(join(tmpdir(), "native-speech-"));
    await Bun.write(libraryPath(dir), "");
    if (separation) {
      await Bun.write(join(dir, "bs-roformer.gguf"), "");
    }
    const workers: any[] = [];
    const speech = new NativeSpeech(
      config({ speech: true, audioDir: dir, speechModelDir: dir, separationModelDir: dir, ...overrides }),
      () => {
        const w = scripted();
        workers.push(w);
        return w;
      },
    );
    return { dir, workers, speech, cleanup: () => rm(dir, { recursive: true }) };
  }

  test("stopped, then starting while the model loads, then ready", async () => {
    const { workers, speech, cleanup } = await setup();
    const log = quiet();
    try {
      expect(speech.state).toBe("stopped");
      expect(workers).toHaveLength(0);
      const result = say(speech);
      expect(speech.state).toBe("starting");
      await expect(result).resolves.toBeInstanceOf(ArrayBuffer);
      expect(speech.state).toBe("ready");
      expect(speech.error).toBeUndefined();
      await say(speech);
      expect(kinds(workers[0])).toStrictEqual(["load", "synthesize", "synthesize"]);
      expect(workers).toHaveLength(1);
    } finally {
      log.mockRestore();
      await cleanup();
    }
  });

  test("a failed load is the error state, and the next request tries again", async () => {
    const { workers, speech, cleanup } = await setup();
    const log = quiet();
    try {
      const first = say(speech);
      workers[0].failLoad = "out of memory";
      await expect(first).rejects.toThrow("the speech model could not be loaded: out of memory");
      expect(speech.state).toBe("error");
      expect(speech.error).toContain("out of memory");

      workers[0].failLoad = undefined;
      await say(speech);
      expect(speech.state).toBe("ready");
      expect(speech.error).toBeUndefined();
      expect(kinds(workers[0])).toStrictEqual(["load", "load", "synthesize"]);
    } finally {
      log.mockRestore();
      await cleanup();
    }
  });

  test("the model is unloaded after SPEECH_IDLE_UNLOAD and loaded again by the next request", async () => {
    const { workers, speech, cleanup } = await setup({ speechIdleUnload: 0.03 });
    const log = quiet();
    try {
      await say(speech);
      expect(speech.state).toBe("ready");
      await Bun.sleep(120);
      expect(kinds(workers[0])).toStrictEqual(["load", "synthesize", "unload"]);
      expect(speech.state).toBe("stopped");
      await say(speech);
      expect(speech.state).toBe("ready");
      expect(kinds(workers[0])).toStrictEqual(["load", "synthesize", "unload", "load", "synthesize"]);
      expect(workers).toHaveLength(1);
    } finally {
      log.mockRestore();
      await speech.stop();
      await cleanup();
    }
  });

  test("an utterance in flight postpones the unload", async () => {
    const { workers, speech, cleanup } = await setup({ speechIdleUnload: 0.03 });
    const log = quiet();
    try {
      await say(speech);
      workers[0].manual = true;
      const slow = say(speech);
      await Bun.sleep(100);
      expect(kinds(workers[0])).toStrictEqual(["load", "synthesize", "synthesize"]);
      workers[0].answer(workers[0].posted[2]);
      await slow;
      workers[0].manual = false;
      await Bun.sleep(100);
      expect(kinds(workers[0]).at(-1)).toBe("unload");
    } finally {
      log.mockRestore();
      await speech.stop();
      await cleanup();
    }
  });

  test.each([
    ["onerror", (w: any) => w.onerror({ message: "boom" }), "the speech thread failed: boom"],
    ["close", (w: any) => w.listeners.close(), "the speech thread exited"],
  ])("a worker crash (%s) rejects waiters, and the next request starts a new worker", async (_n, crash, message) => {
    const { workers, speech, cleanup } = await setup();
    const log = quiet();
    try {
      await say(speech);
      workers[0].manual = true;
      const waiter = say(speech).then(
        () => null,
        (e) => e,
      );
      await Bun.sleep(5);
      crash(workers[0]);
      const error = await waiter;
      expect(error).toBeInstanceOf(SpeechError);
      expect(error.message).toBe(message);
      expect(speech.state).toBe("error");
      expect(speech.error).toBe(message);

      await say(speech);
      expect(workers).toHaveLength(2);
      expect(kinds(workers[1])).toStrictEqual(["load", "synthesize"]);
      expect(speech.state).toBe("ready");
      // The dead worker's late close does not take the new one down.
      workers[0].listeners.close();
      expect(speech.state).toBe("ready");
    } finally {
      log.mockRestore();
      await cleanup();
    }
  });

  test("a crash while the model loads rejects the request", async () => {
    const { workers, speech, cleanup } = await setup();
    const log = quiet();
    try {
      const result = say(speech).then(
        () => null,
        (e) => e,
      );
      workers[0].onerror({ message: "segfault" });
      expect((await result).message).toContain("segfault");
      expect(speech.state).toBe("error");
    } finally {
      log.mockRestore();
      await cleanup();
    }
  });

  test("stop() unloads, ends the worker and deletes the uploads", async () => {
    const { workers, speech, cleanup } = await setup();
    const log = quiet();
    try {
      await say(speech);
      const voice = await speech.addVoice("Mine", wav());
      expect((await speech.voices()).map((v) => v.id)).toContain(voice.id);
      const uploadDir = join(tmpdir(), `index-translator-voices-${process.pid}`);
      expect(existsSync(join(uploadDir, `${voice.id}.wav`))).toBe(true);

      await speech.stop();
      expect(kinds(workers[0]).at(-1)).toBe("unload");
      expect(workers[0].terminated).toBe(true);
      expect(existsSync(uploadDir)).toBe(false);
      await expect(speech.voices()).resolves.toStrictEqual([]);
      expect(speech.state).toBe("stopped");
    } finally {
      log.mockRestore();
      await cleanup();
    }
  });

  test("at most 16 uploads are kept", async () => {
    const { speech, cleanup } = await setup();
    try {
      for (let i = 0; i < MAX_UPLOADED_VOICES; i++) {
        await speech.addVoice(`v${i}`, wav());
      }
      await expect(speech.addVoice("one more", wav())).rejects.toThrow("too many uploaded voices");
      await expect(speech.voices()).resolves.toHaveLength(MAX_UPLOADED_VOICES);
      await speech.stop();
      await speech.addVoice("again", wav());
    } finally {
      await speech.stop();
      await cleanup();
    }
  });

  test("addVoice refuses samples outside the limits without keeping them", async () => {
    const { speech, cleanup } = await setup();
    try {
      await expect(speech.addVoice("x", silentWav(0.5, 16_000))).rejects.toThrow("too short");
      await expect(speech.addVoice("x", silentWav(1.5, 4000))).rejects.toThrow("sample rate");
      await expect(speech.addVoice("x", new ArrayBuffer(100))).rejects.toThrow(SpeechError);
      await expect(speech.voices()).resolves.toStrictEqual([]);
    } finally {
      await cleanup();
    }
  });

  describe("separating the voice of an uploaded sample", () => {
    test("without the separation model the sample is kept as it is, and no worker is started", async () => {
      const { dir, workers, speech, cleanup } = await setup();
      try {
        const voice = await speech.addVoice("Mine", wav());
        expect(workers).toHaveLength(0);
        const kept = await Bun.file(
          join(tmpdir(), `index-translator-voices-${process.pid}`, `${voice.id}.wav`),
        ).bytes();
        expect(kept).toStrictEqual(new Uint8Array(wav()));
        expect(dir).toBeTruthy();
      } finally {
        await speech.stop();
        await cleanup();
      }
    });

    test("the speech model is freed for it, the separated voice is what is kept, and speech loads again after", async () => {
      const { dir, workers, speech, cleanup } = await setup({}, true);
      const log = quiet();
      try {
        await say(speech);
        expect(speech.state).toBe("ready");

        const voice = await speech.addVoice("Mine", wav());
        const separation = workers[0].posted.find((m: any) => m.type === "separate");
        expect(separation.options).toMatchObject({
          dir,
          modelPath: join(dir, "bs-roformer.gguf"),
          family: "bs_roformer",
          backend: "cpu",
        });
        // The recording as uploaded goes to the worker, which does the rest on the speech thread.
        expect(new Uint8Array(separation.wav)).toStrictEqual(new Uint8Array(wav()));
        expect(speech.state).toBe("stopped");
        const kept = await Bun.file(
          join(tmpdir(), `index-translator-voices-${process.pid}`, `${voice.id}.wav`),
        ).bytes();
        expect(kept).toStrictEqual(new Uint8Array(separated()));

        await say(speech);
        expect(speech.state).toBe("ready");
        expect(kinds(workers[0])).toStrictEqual(["load", "synthesize", "separate", "load", "synthesize"]);
      } finally {
        log.mockRestore();
        await speech.stop();
        await cleanup();
      }
    });

    test("an utterance asked for during the separation waits for it, then loads the speech model again", async () => {
      const { workers, speech, cleanup } = await setup({}, true);
      const log = quiet();
      try {
        await say(speech);
        workers[0].manual = true;
        const upload = speech.addVoice("Mine", wav());
        await Bun.sleep(5);
        const waiting = say(speech);
        await Bun.sleep(20);
        // Nothing but the separation is with the worker: the utterance does not find the model gone.
        expect(kinds(workers[0])).toStrictEqual(["load", "synthesize", "separate"]);

        workers[0].answer(workers[0].posted[2]);
        await upload;
        await Bun.sleep(5);
        expect(kinds(workers[0])).toStrictEqual(["load", "synthesize", "separate", "load"]);
        workers[0].manual = false;
        workers[0].answer(workers[0].posted[3]);
        await expect(waiting).resolves.toBeInstanceOf(ArrayBuffer);
        expect(kinds(workers[0])).toStrictEqual(["load", "synthesize", "separate", "load", "synthesize"]);
      } finally {
        log.mockRestore();
        await speech.stop();
        await cleanup();
      }
    });

    test("an utterance already with the worker finishes before the separation starts", async () => {
      const { workers, speech, cleanup } = await setup({}, true);
      const log = quiet();
      try {
        await say(speech);
        workers[0].manual = true;
        const speaking = say(speech);
        await Bun.sleep(5);
        const upload = speech.addVoice("Mine", wav());
        await Bun.sleep(5);
        expect(kinds(workers[0])).toStrictEqual(["load", "synthesize", "synthesize", "separate"]);
        workers[0].answer(workers[0].posted[2]);
        await speaking;
        workers[0].answer(workers[0].posted[3]);
        await upload;
        workers[0].manual = false;
      } finally {
        log.mockRestore();
        await speech.stop();
        await cleanup();
      }
    });

    test("a separation waits for a model that is loading, and two uploads run one after the other", async () => {
      const { workers, speech, cleanup } = await setup({}, true);
      const log = quiet();
      try {
        holdLoads = true;
        const loading = say(speech);
        expect(speech.state).toBe("starting");
        const first = speech.addVoice("One", wav());
        const second = speech.addVoice("Two", wav());
        await Bun.sleep(10);
        expect(kinds(workers[0])).toStrictEqual(["load"]);
        // The utterance was first, but a separation was asked for before its model finished loading,
        // so the model goes again and the utterance is made after both separations.
        holdLoads = false;
        workers[0].answer(workers[0].posted[0]);
        await Promise.all([first, second]);
        await loading;
        expect(kinds(workers[0])).toStrictEqual(["load", "separate", "separate", "load", "synthesize"]);
      } finally {
        holdLoads = false;
        log.mockRestore();
        await speech.stop();
        await cleanup();
      }
    });

    test("a failed separation is a SeparationError, keeps nothing, and leaves speech working", async () => {
      const { workers, speech, cleanup } = await setup({}, true);
      const log = quiet();
      try {
        await say(speech);
        workers[0].failSeparation = "out of memory";
        const error = await speech.addVoice("Mine", wav()).then(
          () => null,
          (e) => e,
        );
        expect(error).toBeInstanceOf(SeparationError);
        expect(error).toBeInstanceOf(SpeechError);
        expect(error.message).toBe("separating the voice failed: out of memory");
        await expect(speech.voices()).resolves.toStrictEqual([]);

        await say(speech);
        expect(speech.state).toBe("ready");
        // The next upload separates again, and a later separation does not wait for the failed one.
        workers[0].failSeparation = undefined;
        await speech.addVoice("Mine", wav());
        await expect(speech.voices()).resolves.toHaveLength(1);
      } finally {
        log.mockRestore();
        await speech.stop();
        await cleanup();
      }
    });

    test("a sample outside the limits is refused before the speech model is touched", async () => {
      const { workers, speech, cleanup } = await setup({}, true);
      try {
        await expect(speech.addVoice("x", silentWav(0.5, 16_000))).rejects.toThrow("too short");
        expect(workers).toHaveLength(0);
      } finally {
        await cleanup();
      }
    });
  });
});

describe("POST /voices", () => {
  const upload = (body: string | Uint8Array, type = "audio/wav", name: string | null = "My voice") =>
    fetch(`${base}/api/v1/voices${name === null ? "" : `?name=${encodeURIComponent(name)}`}`, {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
  const sample = (seconds = 1.5, rate = 16_000) => new Uint8Array(silentWav(seconds, rate));
  const errorOf = async (res: Response) => ((await res.json()) as any).error;

  test("a WAV sample becomes a voice", async () => {
    const res = await upload(sample());
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe("My voice");
  });

  test("a separation that fails in the engine is a 502, not a bad request, and keeps no voice", async () => {
    const before = mockSpeech.voices.length;
    mockSpeech.separationFailWith = "separating the voice failed: out of memory";
    const res = await upload(sample());
    expect(res.status).toBe(502);
    await expect(errorOf(res)).resolves.toStrictEqual({
      code: "speech_error",
      message: "separating the voice failed: out of memory",
    });
    expect(mockSpeech.voices).toHaveLength(before);
  });

  test("anything else is refused", async () => {
    const res = await upload(new Uint8Array(64));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).details.field).toBe("body");
    expect((await upload("{}", "application/json")).status).toBe(415);
    expect((await upload("{}", "text/plain")).status).toBe(415);
  });

  test("the content type may carry parameters and any case", async () => {
    expect((await upload(sample(), "Audio/WAV; charset=binary")).status).toBe(201);
  });

  test("an empty body is a 400", async () => {
    expect((await upload(new Uint8Array(0))).status).toBe(400);
  });

  test("413 when content-length is over 8 MiB, and when the body is, without a length", async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    const declared = await upload(big);
    expect(declared.status).toBe(413);
    expect((await errorOf(declared)).code).toBe("body_too_large");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const chunked = await fetch(`${base}/api/v1/voices`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: stream,
      duplex: "half",
    });
    expect(chunked.status).toBe(413);
  });

  test("the name is trimmed, whitespace is collapsed, and it is cut at 60 characters", async () => {
    const named = async (name: string | null) =>
      ((await (await upload(sample(), "audio/wav", name)).json()) as any).name;
    await expect(named("  My \n  new\t voice  ")).resolves.toBe("My new voice");
    await expect(named("a".repeat(80))).resolves.toBe("a".repeat(60));
    await expect(named("   ")).resolves.toBe("Uploaded voice");
    await expect(named("")).resolves.toBe("Uploaded voice");
    await expect(named(null)).resolves.toBe("Uploaded voice");
  });

  test.each([
    ["shorter than 1 s", sample(0.5), "too short"],
    ["longer than 60 s", sample(61, 8000), "too long"],
    ["below 8 kHz", sample(1.5, 7999), "sample rate"],
    ["above 192 kHz", sample(0.2, 192_001), "sample rate"],
  ])("a sample %s is a 400", async (_what, wav, message) => {
    const res = await upload(wav);
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("invalid_request");
    expect(error.details.field).toBe("body");
    expect(error.message).toContain(message);
  });

  test("the limits are inclusive at 1 s, 60 s, 8 kHz and 192 kHz", async () => {
    for (const wav of [sample(1, 8000), sample(60, 8000), sample(1, 192_000)]) {
      expect((await upload(wav)).status).toBe(201);
    }
  });
});

describe("POST /speech speed range", () => {
  test.each([0.5, 1, 2])("speed %d is accepted", async (speed) => {
    expect((await speak({ text: "Hi", lang: "en", speed })).status).toBe(200);
    expect(mockSpeech.requests.at(-1)?.speed).toBe(speed);
  });

  test.each([0.49, 2.01, 0, -1])("speed %d is refused", async (speed) => {
    const res = await speak({ text: "Hi", lang: "en", speed });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.details.field).toBe("speed");
    expect(mockSpeech.requests).toStrictEqual([]);
  });
});

describe("validateSample", () => {
  /** silentWav is mono; the header is patched to two channels, which halves the duration. */
  const stereo = (seconds: number, rate: number) => {
    const wav = new Uint8Array(silentWav(seconds, rate));
    new DataView(wav.buffer).setUint16(22, 2, true);
    return wav.buffer;
  };

  test("the duration counts frames, not samples", () => {
    expect(() => validateSample(stereo(2, 8000))).not.toThrow();
    expect(() => validateSample(stereo(1.5, 8000))).toThrow("too short");
  });

  test("garbage is a SpeechError", () => {
    expect(() => validateSample(new ArrayBuffer(8))).toThrow(SpeechError);
  });
});
