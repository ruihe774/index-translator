// The fake model that stands in for the one libllama would load, and a launcher that makes one per model
// load. No GPU, library or model files are needed.
//
// The fake counts one token per code point and the chat template adds TEMPLATE.length tokens.
// `mock` is module state shared by every test file in the run: tests that change it must restore it
// (or call resetMock() in afterEach/finally), because bun runs test files in one process.

import {
  EngineError,
  type FinishReason,
  type GenerationEvent,
  ImageInputError,
  ImageUnavailableError,
  type Launcher,
  type Running,
} from "../../src/llama";
import { until } from "./harness";

export const TEMPLATE = "<user></user>";
/** What the fake counts for an image, whatever its size. */
export const IMAGE_TOKENS = 64;
/** A white 2 × 2 PNG: the smallest thing the API takes as an image. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQAAAABazTCJAAAADElEQVQI12M4wHAAAAMEAYHFO6KpAAAAAElFTkSuQmCC",
  "base64",
);

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

/** Also forgets the recorded requests, aborts and launches: a fresh start for the e2e control port. */
export function resetMockCounters(): void {
  mock.requests.length = 0;
  mock.aborted = 0;
  mock.launches.length = 0;
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
  await until(() => mock.ready, "mock.ready (a test left a model load pending)", 60_000);
  return fakeModel({
    onStart: (prompt, maxTokens, image) => void mock.requests.push({ prompt, maxTokens, ...(image && { image }) }),
    onAbort: () => void mock.aborted++,
  });
};
