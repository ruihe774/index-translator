// Shared harness for API tests and the Playwright mock server (e2e/mock-server.ts): a fake model that
// stands in for the one libllama would load, a launcher that makes one per model load, and small
// request/SSE helpers. No GPU, library or model files are needed.
//
// The fake counts one token per code point and the chat template adds TEMPLATE.length tokens.
// `mock` is module state shared by every test file in the run: tests that change it must restore it
// (or call resetMock() in afterEach/finally), because bun runs test files in one process.

import { join, resolve } from "node:path";

import type { AlignedPair, AlignUnit, ErrorBody, ErrorResponse, SegmentedText, TranslateEvents } from "../../src/api";
import type { App } from "../../src/app";
import type { Config } from "../../src/config";
import {
  EngineError,
  type FinishReason,
  type GenerationEvent,
  ImageInputError,
  ImageUnavailableError,
  type Launcher,
  type Running,
} from "../../src/llama";
import { SegmentError, type SegmentLauncher, type SegmentState } from "../../src/segment";
import {
  SeparationError,
  SpeechError,
  type SpeechLauncher,
  type SpeechRequest,
  type SpeechState,
  validateSample,
  type Voice,
} from "../../src/speech";
import { WebpageError, type WebpageFetcher, WebpageForbiddenError } from "../../src/webpage";

export const root = resolve(import.meta.dir, "..", "..");

export const TEMPLATE = "<user></user>";
/** What the fake counts for an image, whatever its size. */
export const IMAGE_TOKENS = 64;
/** A white 2 × 2 PNG: the smallest thing the API takes as an image. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQAAAABazTCJAAAADElEQVQI12M4wHAAAAMEAYHFO6KpAAAAAElFTkSuQmCC",
  "base64",
);

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
  /** The engine cannot read the image it is given. */
  imageFailWith: undefined as string | undefined,
  /** The model's image encoder is not installed. */
  imageUnavailable: undefined as string | undefined,
  /** Every generation the shared launcher's models were asked for; `image` is the PNG handed to the engine. */
  requests: [] as { prompt: string; maxTokens: number; image?: Uint8Array }[],
  aborted: 0,
  launches: [] as string[],
  /** What the loaded model reports as GPU memory; undefined as on a machine without a GPU. */
  gpuMemory: undefined as { free: number; total: number } | undefined,
};

/** Puts the behaviour knobs back to their defaults; counters (requests, aborted, launches) are kept. */
export function resetMock(): void {
  mock.ready = true;
  mock.chunks = [...DEFAULT_CHUNKS];
  mock.delayMs = 0;
  mock.finish = "stop";
  mock.failWith = undefined;
  mock.failLaunch = undefined;
  mock.imageFailWith = undefined;
  mock.imageUnavailable = undefined;
  mock.gpuMemory = undefined;
}

interface FakeHooks {
  /** Called when a generation starts; `image` is the PNG the request's image was made into. */
  onStart?(prompt: string, maxTokens: number, image?: Uint8Array): void;
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
  const exited = new Promise<string | undefined>((resolve) => void (finish = resolve));
  const gone = new AbortController();
  const end = (reason: string | undefined) => {
    if (model.stopped) {
      return;
    }
    model.stopped = true;
    gone.abort();
    finish(reason);
  };

  /** Waits for `p`, but throws as soon as the model is gone or the client aborts. */
  async function alive(p: Promise<void> | undefined, signal: AbortSignal): Promise<void> {
    if (p && !signal.aborted) {
      let wake!: () => void;
      const aborted = new Promise<void>((resolve) => void (wake = resolve));
      signal.addEventListener("abort", wake);
      await Promise.race([p, aborted]).finally(() => signal.removeEventListener("abort", wake));
    }
    if (model.stopped) {
      throw new EngineError("generation failed: the model was unloaded during the generation");
    }
    signal.throwIfAborted();
  }

  const model: FakeModel = {
    exited,
    stopped: false,
    stop: () => end(undefined),
    kill: (reason = "the engine thread exited") => end(reason),
    // eslint-disable-next-line @typescript-eslint/require-await -- a refusal rejects, as the real engine does, rather than throwing
    async countTokens(content, image) {
      if (model.stopped) {
        throw new EngineError("the model is not loaded");
      }
      if (image && mock.imageFailWith) {
        throw new ImageInputError(mock.imageFailWith);
      }
      if (image && mock.imageUnavailable) {
        throw new ImageUnavailableError(mock.imageUnavailable);
      }
      return Array.from(content).length + TEMPLATE.length + (image ? IMAGE_TOKENS : 0);
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- same signature as the engine's
    async memory() {
      return mock.gpuMemory;
    },
    async *generate(prompt, maxTokens, client, image): AsyncGenerator<GenerationEvent> {
      const signal = client ? AbortSignal.any([client, gone.signal]) : gone.signal;
      hooks.onStart?.(prompt, maxTokens, image);
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
        if (failWith) {
          throw new EngineError(`generation failed: ${failWith}`);
        }
        yield {
          type: "done",
          finishReason,
          usage: { prompt_tokens: hooks.promptTokens?.() ?? 42, completion_tokens: chunks.length },
          timings: { prompt_ms: 12, generation_ms: 100, tokens_per_second: 70.12 },
        };
      } finally {
        if (!played && !model.stopped) {
          hooks.onAbort?.();
        }
        hooks.onEnd?.();
      }
    },
  };
  return model;
}

export const launcher: Launcher = async (model) => {
  if (mock.failLaunch) {
    throw new EngineError(mock.failLaunch);
  }
  mock.launches.push(model.id);
  while (!mock.ready) {
    await Bun.sleep(10);
  }
  return fakeModel({
    onStart: (prompt, maxTokens, image) => void mock.requests.push({ prompt, maxTokens, ...(image && { image }) }),
    onAbort: () => void mock.aborted++,
  });
};

/** A tenth of a second of silence: 22.05 kHz, mono, 16-bit PCM, as the speech engine answers. */
export function silentWav(seconds = 0.1, rate = 22_050): ArrayBuffer {
  const samples = Math.round(rate * seconds);
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(at + i, s.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return view.buffer;
}

export const mockSpeech = {
  /** What `state` reports; "unavailable" makes requests fail as when nothing is installed. */
  state: "stopped" as SpeechState,
  voices: [
    { id: "voice_01", name: "Voice 01" },
    { id: "voice_02", name: "Voice 02" },
  ] as Voice[],
  delayMs: 0,
  /** Length of the silence each utterance answers with. */
  audioSeconds: 0.1,
  failWith: undefined as string | undefined,
  /** Makes an upload fail as when the engine cannot separate the voice from the recording. */
  separationFailWith: undefined as string | undefined,
  /** The upload slots are all taken, as the real engine reports it. */
  voicesFull: false,
  /** Every utterance asked for. */
  requests: [] as SpeechRequest[],
  aborted: 0,
  /** An engine that does not stop: an utterance that started runs to its end, and `done` waits for it. */
  ignoreAbort: false,
  /** Utterances the engine is working on right now, whoever still waits for them. */
  running: 0,
};

export function resetMockSpeech(): void {
  mockSpeech.state = "stopped";
  // A test may have replaced the list (e2e control port), so restore the two built-in voices.
  mockSpeech.voices = [
    { id: "voice_01", name: "Voice 01" },
    { id: "voice_02", name: "Voice 02" },
  ];
  mockSpeech.delayMs = 0;
  mockSpeech.audioSeconds = 0.1;
  mockSpeech.failWith = undefined;
  mockSpeech.separationFailWith = undefined;
  mockSpeech.voicesFull = false;
  mockSpeech.requests.length = 0;
  mockSpeech.aborted = 0;
  mockSpeech.ignoreAbort = false;
  mockSpeech.running = 0;
}

/** Stands in for the audio.cpp speech engine: answers every utterance with silence. */
export const speechLauncher: SpeechLauncher = () => ({
  get state() {
    return mockSpeech.state;
  },
  get error() {
    return mockSpeech.state === "unavailable" ? "the speech engine is not installed" : undefined;
  },
  voices: () => Promise.resolve(mockSpeech.voices),
  // eslint-disable-next-line @typescript-eslint/require-await -- a bad sample rejects, as the real engine does, rather than throwing
  async addVoice(name, wav) {
    validateSample(wav);
    if (mockSpeech.voicesFull) {
      throw new SpeechError("too many uploaded voices");
    }
    if (mockSpeech.separationFailWith) {
      throw new SeparationError(mockSpeech.separationFailWith);
    }
    const voice = { id: `upload-${mockSpeech.voices.length}`, name };
    mockSpeech.voices.push(voice);
    return voice;
  },
  async synthesize(req, signal, done) {
    if (signal.aborted) {
      done();
      mockSpeech.aborted++;
      signal.throwIfAborted();
    }
    mockSpeech.requests.push(req);
    mockSpeech.running++;
    const work = (async () => {
      try {
        if (mockSpeech.delayMs) {
          const abort = mockSpeech.ignoreAbort
            ? new Promise(() => {})
            : new Promise((wake) => void signal.addEventListener("abort", wake));
          await Promise.race([Bun.sleep(mockSpeech.delayMs), abort]);
        }
        if (signal.aborted && !mockSpeech.ignoreAbort) {
          mockSpeech.aborted++;
          signal.throwIfAborted();
        }
        if (mockSpeech.failWith) {
          throw new SpeechError(mockSpeech.failWith);
        }
        mockSpeech.state = "ready";
        return silentWav(mockSpeech.audioSeconds);
      } finally {
        mockSpeech.running--;
        done();
      }
    })();
    if (!mockSpeech.ignoreAbort) {
      return work;
    }
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      work.then(resolve, reject);
    });
  },
  async stop() {},
});

const DEFAULT_MARKDOWN = "# Example page\n\nThe first paragraph.\n\nThe [second](https://example.com/two) paragraph.";

export const mockWebpage = {
  /** What `problem()` answers: set, every fetch is refused as when turndown is not installed. */
  problem: undefined as string | undefined,
  title: "Example page",
  markdown: DEFAULT_MARKDOWN,
  /** Where the page ends up, when not where it was asked to go: checked against the allowed domains. */
  redirectTo: undefined as string | undefined,
  delayMs: 0,
  /** Makes the fetch fail as when the page cannot be opened. */
  failWith: undefined as string | undefined,
  /** Every address asked for. */
  requests: [] as string[],
  aborted: 0,
};

export function resetMockWebpage(): void {
  mockWebpage.problem = undefined;
  mockWebpage.title = "Example page";
  mockWebpage.markdown = DEFAULT_MARKDOWN;
  mockWebpage.redirectTo = undefined;
  mockWebpage.delayMs = 0;
  mockWebpage.failWith = undefined;
  mockWebpage.requests.length = 0;
  mockWebpage.aborted = 0;
}

/** Stands in for the browser of `POST /webpage`: answers every page with `mockWebpage.markdown`. */
export const webpageFetcher: WebpageFetcher = {
  problem: () => Promise.resolve(mockWebpage.problem),
  async fetch(url, allowed, signal) {
    mockWebpage.requests.push(url.href);
    if (mockWebpage.delayMs) {
      await Promise.race([
        Bun.sleep(mockWebpage.delayMs),
        new Promise((wake) => void signal.addEventListener("abort", wake)),
      ]);
    }
    if (signal.aborted) {
      mockWebpage.aborted++;
      signal.throwIfAborted();
    }
    if (mockWebpage.failWith) {
      throw new WebpageError(mockWebpage.failWith);
    }
    const at = mockWebpage.redirectTo ?? url.href;
    if (!allowed(new URL(at))) {
      throw new WebpageForbiddenError(`the page went on to ${at}, which is not in ALLOWED_WEBPAGE_DOMAINS`);
    }
    return { url: at, title: mockWebpage.title, markdown: mockWebpage.markdown };
  },
};

export const mockSegment = {
  /** What `state` reports; "unavailable" makes requests fail as when nothing is installed. */
  state: "stopped" as SegmentState,
  delayMs: 0,
  /** Makes a request fail as when the model cannot run. */
  failWith: undefined as string | undefined,
  /** Every request's texts. */
  requests: [] as string[][],
  aborted: 0,
};

export function resetMockSegment(): void {
  mockSegment.state = "stopped";
  mockSegment.delayMs = 0;
  mockSegment.failWith = undefined;
  mockSegment.requests.length = 0;
  mockSegment.aborted = 0;
  mockAlign.state = "stopped";
  mockAlign.pairs = undefined;
  mockAlign.requests.length = 0;
}

export const mockAlign = {
  /** What the aligner's `state` reports; "unavailable" makes requests fail as when nothing is installed. */
  state: "stopped" as SegmentState,
  /** The answer to give instead of `mockPairs`. */
  pairs: undefined as AlignedPair[] | undefined,
  /** Every request's unit and items. */
  requests: [] as { unit: AlignUnit; source: string[]; target: string[] }[],
};

/**
 * What the mock aligner answers: item i with item i, and what is left over of the longer side joined to
 * the last pair (sentences) or alone, with no counterpart (paragraphs, as the model leaves a dropped one).
 */
export function mockPairs(sourceCount: number, targetCount: number, unit: AlignUnit = "sentences"): AlignedPair[] {
  const shared = Math.min(sourceCount, targetCount);
  const pairs = Array.from({ length: shared }, (_, i) => ({ source: [i], target: [i], similarity: 0.8 }));
  if (unit === "paragraphs") {
    for (let i = shared; i < sourceCount; i++) {
      pairs.push({ source: [i], target: [], similarity: 0 });
    }
    for (let i = shared; i < targetCount; i++) {
      pairs.push({ source: [], target: [i], similarity: 0 });
    }
    return pairs;
  }
  const last = pairs.at(-1)!;
  for (let i = shared; i < sourceCount; i++) {
    last.source.push(i);
  }
  for (let i = shared; i < targetCount; i++) {
    last.target.push(i);
  }
  return pairs;
}

/** Sentence punctuation with what may close it, then a space or the end; and clause punctuation. */
const MOCK_SENTENCE_END = /[.!?。！？…]["'”’)）」』】]*(?=\s|$)/gu;
const MOCK_CLAUSE_END = /[,;:，、；：]/gu;

/**
 * What the mock model answers for one text: 0.95 after sentence punctuation, 0.01 after clause
 * punctuation, as SaT roughly does on punctuated text.
 */
export function mockBoundaries(text: string): SegmentedText {
  const found = new Map<number, number>();
  for (const m of text.matchAll(MOCK_CLAUSE_END)) {
    found.set(m.index + m[0].length, 0.01);
  }
  for (const m of text.matchAll(MOCK_SENTENCE_END)) {
    found.set(m.index + m[0].length, 0.95);
  }
  const offsets = [...found.keys()].sort((a, b) => a - b);
  return { offsets, probabilities: offsets.map((o) => found.get(o)!) };
}

/** Stands in for SaT: punctuation decides, see `mockBoundaries`. */
export const segmentLauncher: SegmentLauncher = () => ({
  get state() {
    return mockSegment.state;
  },
  get error() {
    return mockSegment.state === "unavailable" ? "the segmentation model is not installed" : undefined;
  },
  async segment(texts, signal) {
    mockSegment.requests.push(texts);
    if (mockSegment.delayMs) {
      await Promise.race([
        Bun.sleep(mockSegment.delayMs),
        new Promise((wake) => void signal.addEventListener("abort", wake)),
      ]);
    }
    if (signal.aborted) {
      mockSegment.aborted++;
      signal.throwIfAborted();
    }
    if (mockSegment.failWith) {
      throw new SegmentError(mockSegment.failWith);
    }
    mockSegment.state = "ready";
    return texts.map(mockBoundaries);
  },
  aligner: {
    get state() {
      return mockAlign.state;
    },
    get error() {
      return mockAlign.state === "unavailable" ? "the alignment model is not installed" : undefined;
    },
  },
  async align(unit, source, target, signal) {
    mockAlign.requests.push({ unit, source, target });
    if (mockSegment.delayMs) {
      await Promise.race([
        Bun.sleep(mockSegment.delayMs),
        new Promise((wake) => void signal.addEventListener("abort", wake)),
      ]);
    }
    signal.throwIfAborted();
    if (mockSegment.failWith) {
      throw new SegmentError(mockSegment.failWith);
    }
    mockAlign.state = "ready";
    return mockAlign.pairs ?? mockPairs(source.length, target.length, unit);
  },
  async stop() {},
});

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
  for (let i = 0; i < 100 && app.engine.state !== "ready"; i++) {
    await Bun.sleep(20);
  }
  if (app.engine.state !== "ready") {
    throw new Error(`engine not ready: ${app.engine.state}`);
  }
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

/** The `error` of an error response. */
export async function errorOf(res: Response): Promise<ErrorBody> {
  return (await bodyOf<ErrorResponse>(res)).error;
}
