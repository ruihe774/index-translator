// The engine: one model at a time, loaded in-process through libllama (bun:ffi), with token
// counting and streamed generation. Switching models frees the loaded one and loads the other.
// The library runs on a worker thread (src/llama-worker.ts); this file is the server-thread side.

import { join } from "node:path";

import type { FinishReason, Usage } from "./api";
import type { Config } from "./config";
import { inferenceThreads } from "./cpu";
import type { GpuMemory } from "./llama-ffi";
import type { LlamaProtocol } from "./llama-worker";
import type { ModelSpec } from "./models";
import { fetchAdvice } from "./preflight";
import { messageOf, startWorker, WorkerClient } from "./worker-rpc";

type EngineState = "stopped" | "loading" | "ready" | "error";

export type { FinishReason, GpuMemory, Usage };

/** How long a memory reading is reused, and how long a health check waits for the engine thread. */
const MEMORY_TTL_MS = 1000;
const MEMORY_WAIT_MS = 500;

export interface EngineTimings {
  prompt_ms: number;
  generation_ms: number;
  tokens_per_second: number;
}

export type GenerationEvent =
  { type: "delta"; text: string } | { type: "done"; finishReason: FinishReason; usage: Usage; timings: EngineTimings };

export class EngineError extends Error {}

/** The model cannot be given images here: it has no image encoder, or the encoder's file is not downloaded. */
export class ImageUnavailableError extends EngineError {}

/** The engine could not read the image it was given; the engine itself is fine. */
export class ImageInputError extends EngineError {}

const asEngineError = (e: unknown): EngineError => (e instanceof EngineError ? e : new EngineError(messageOf(e)));

/** A loaded model, as seen by the engine. */
export interface Running {
  /** Resolves once the model is gone: with `undefined` after stop(), otherwise with what went wrong. */
  exited: Promise<string | undefined>;
  /** Asks for the model to be freed; the engine waits on `exited`. */
  stop(): void;
  /**
   * Tokens a user message with this content occupies in the context, chat template included.
   * `image` is a PNG file that follows the content in the message; counting it waits for a running
   * generation, counting text alone does not.
   */
  countTokens(content: string, image?: Uint8Array): Promise<number>;
  /** Free and total GPU memory, or undefined when there is no GPU or the engine thread is too busy to say. */
  memory(): Promise<GpuMemory | undefined>;
  /** Answers one user message, greedily, with at most `maxTokens` tokens. Aborting rejects with the signal's reason. */
  generate(
    content: string,
    maxTokens: number,
    signal?: AbortSignal,
    image?: Uint8Array,
  ): AsyncGenerator<GenerationEvent>;
}

/** Loads one model. Replaceable so tests can run without the library or the weights. */
export type Launcher = (model: ModelSpec, cfg: Config) => Promise<Running>;

type LlamaClient = WorkerClient<LlamaProtocol>;

/** Starts the engine thread; replaceable in tests. */
type EngineWorkerFactory = () => Worker;

const defaultWorker: EngineWorkerFactory = () => startWorker("llama-worker.ts");

/** One reading of the GPU memory, shared by whoever asks within a second. */
class MemoryReader {
  private reading?: { at: number; pending: Promise<GpuMemory | undefined> };

  constructor(private readonly client: LlamaClient) {}

  /**
   * Shared by concurrent callers and reused for a second, so polling `/health` does not queue a
   * request per call. A loading model blocks the thread: that reading is given up after a moment.
   */
  read(): Promise<GpuMemory | undefined> {
    const now = performance.now();
    if (!this.reading || now - this.reading.at > MEMORY_TTL_MS) {
      const ask = async (): Promise<GpuMemory | undefined> => {
        try {
          return (await this.client.call("memory")).memory;
        } catch {
          return undefined;
        }
      };
      const timeout = new Promise<undefined>((resolve) => void setTimeout(resolve, MEMORY_WAIT_MS));
      this.reading = { at: now, pending: Promise.race([ask(), timeout]) };
    }
    return this.reading.pending;
  }
}

/** Generates on the engine thread: deltas as they arrive, ending with `done`, an error or the abort. */
async function* generateOn(
  client: LlamaClient,
  model: number,
  content: string,
  maxTokens: number,
  signal: AbortSignal | undefined,
  image: Uint8Array | undefined,
  checkImage: (image: Uint8Array | undefined) => Promise<void>,
): AsyncGenerator<GenerationEvent> {
  signal?.throwIfAborted();
  await checkImage(image);
  signal?.throwIfAborted();
  /** What the thread sent, in order; its failure is the last. */
  const replies: (GenerationEvent | EngineError)[] = [];
  let wake: (() => void) | undefined;
  const { req, close } = client.stream("generate", { model, content, maxTokens, image }, (reply) => {
    if (reply.type === "error") {
      replies.push(
        reply.image ? new ImageInputError(reply.message) : new EngineError(`generation failed: ${reply.message}`),
      );
    } else {
      replies.push(reply);
    }
    wake?.();
  });
  const onAbort = () => wake?.();
  signal?.addEventListener("abort", onAbort);
  let ended = false;
  try {
    for (;;) {
      while (replies.length === 0 && !signal?.aborted) {
        await new Promise<void>((resolve) => void (wake = resolve));
      }
      signal?.throwIfAborted();
      const event = replies.shift()!;
      if (event instanceof EngineError) {
        ended = true;
        throw event;
      }
      if (event.type === "done") {
        ended = true;
      }
      yield event;
      if (ended) {
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    close();
    // Aborted, or the consumer stopped reading: the worker gives up at its next token.
    if (!ended) {
      client.send("cancel", { target: req });
    }
  }
}

/**
 * The launcher of libllama on its own engine thread, started by the first model it loads and again
 * by the first after the thread was lost.
 */
export function createNativeLauncher(makeWorker: EngineWorkerFactory = defaultWorker): Launcher {
  const client: LlamaClient = new WorkerClient({
    start: makeWorker,
    label: "engine thread",
    fail: (reply) => (reply.image ? new ImageInputError(reply.message) : new EngineError(reply.message)),
  });
  const memory = new MemoryReader(client);
  let lastModel = 0;

  return async (model, cfg) => {
    const modelPath = join(cfg.modelsDir, model.file);
    if (!(await Bun.file(modelPath).exists())) {
      throw new EngineError(`model not found at ${modelPath}; ${fetchAdvice()}`);
    }
    const no = ++lastModel;
    const mmproj = model.mmproj && join(cfg.modelsDir, model.mmproj);
    /** Before an image goes to the engine thread: a missing encoder is the user's to download, not an engine failure. */
    const checkImage = async (image: Uint8Array | undefined) => {
      if (!image) {
        return;
      }
      if (!mmproj) {
        throw new ImageUnavailableError(`${model.id} does not translate images`);
      }
      if (!(await Bun.file(mmproj).exists())) {
        throw new ImageUnavailableError(
          `the image encoder of ${model.id} is not at ${mmproj}; ${fetchAdvice([model.id])}`,
        );
      }
    };
    // Taken before the load, which is what starts the thread, so a loss in between is not missed.
    const lost = client.whenLost();
    await client.call("load", {
      model: no,
      options: {
        dir: cfg.llamaDir,
        path: modelPath,
        mmproj,
        gpuLayers: cfg.gpuLayers,
        ctxSize: cfg.ctxSize,
        threads: inferenceThreads(cfg.threads),
        mtp: cfg.mtp && model.mtp === true,
      },
    });

    let finish!: (reason: string | undefined) => void;
    const exited = new Promise<string | undefined>((resolve) => void (finish = resolve));
    void lost.then(finish);
    return {
      exited,
      stop: () => void client.call("unload", { model: no }).then(() => finish(undefined), finish),
      countTokens: async (content, image) => {
        await checkImage(image);
        return (await client.call("count", { model: no, content, image })).tokens;
      },
      memory: () => memory.read(),
      generate: (content, maxTokens, signal, image) =>
        generateOn(client, no, content, maxTokens, signal, image, checkImage),
    };
  };
}

/** Loads the model with libllama on the engine thread, which is started on first use. */
export const launchNative: Launcher = createNativeLauncher();

/** What the engine holds: nothing, a model on its way, a model, or the reason the last one is gone. */
type Current =
  | { state: "stopped" }
  | { state: "loading"; model: ModelSpec }
  | { state: "ready"; model: ModelSpec; running: Running }
  | { state: "error"; error: string };

export class Engine {
  private current: Current = { state: "stopped" };
  /** Bumped by every load() and unload(); a load that finds it changed has been superseded. */
  private epoch = 0;

  constructor(
    private readonly cfg: Config,
    private readonly launch: Launcher = launchNative,
  ) {}

  get state(): EngineState {
    return this.current.state;
  }

  /** The model that is loaded or loading. */
  get loaded(): ModelSpec | undefined {
    const { current } = this;
    return current.state === "loading" || current.state === "ready" ? current.model : undefined;
  }

  get error(): string | undefined {
    return this.current.state === "error" ? this.current.error : undefined;
  }

  /**
   * Makes `model` the loaded one, replacing any other. Callers must hold the queue slot, so no
   * generation runs while the model is being swapped.
   */
  async load(model: ModelSpec): Promise<void> {
    if (this.current.state === "ready" && this.current.model.id === model.id) {
      return;
    }
    // A client that gave up frees the queue slot while its load is still in flight, so a later load
    // can start before this one ends. Whichever load is newest wins; an older one frees its own
    // model and leaves the engine state alone.
    const epoch = ++this.epoch;
    await this.stopRunning();
    this.current = { state: "loading", model };
    const launched = await this.launch(model, this.cfg).then(
      (running) => ({ running, failure: undefined }),
      (e: unknown) => ({ running: undefined, failure: asEngineError(e) }),
    );
    if (epoch !== this.epoch) {
      if (launched.running) {
        launched.running.stop();
        await launched.running.exited;
        throw new EngineError("the model load was superseded by a newer one");
      }
      throw launched.failure;
    }
    if (!launched.running) {
      const { failure } = launched;
      this.current = { state: "error", error: failure.message };
      console.error(`[engine] could not load ${model.id}: ${failure.message}`);
      throw failure;
    }
    const { running } = launched;
    this.current = { state: "ready", model, running };
    void running.exited.then((reason) => {
      if (this.current.state === "ready" && this.current.running === running) {
        const error = reason ?? "the model was unloaded";
        this.current = { state: "error", error };
        console.error(`[engine] ${error}`);
      }
    });
    console.error(`[engine] ${model.id} ready`);
  }

  /** Frees the loaded model, if any. */
  async unload(): Promise<void> {
    this.epoch++;
    await this.stopRunning();
  }

  private async stopRunning(): Promise<void> {
    const { current } = this;
    this.current = { state: "stopped" };
    if (current.state === "ready") {
      current.running.stop();
      await current.running.exited;
    }
  }

  /** The loaded model, or an EngineError while there is none to use. */
  private ready(): Running {
    if (this.current.state !== "ready") {
      throw new EngineError(`the engine is ${this.current.state}`);
    }
    return this.current.running;
  }

  /**
   * Tokens a user message with this content occupies in the context, chat template included.
   * Counted by the model that is loaded now, without waiting for a generation. Throws EngineError
   * when no model is ready or it goes away before answering.
   */
  async countPromptTokens(content: string, image?: Uint8Array): Promise<number> {
    return this.ready().countTokens(content, image);
  }

  /** GPU memory of the machine, from the loaded model's engine thread; undefined when no model is ready. */
  async gpuMemory(): Promise<GpuMemory | undefined> {
    if (this.current.state !== "ready") {
      return undefined;
    }
    try {
      return await this.current.running.memory();
    } catch {
      return undefined;
    }
  }

  /** `image` is a PNG file that follows the prompt in the user message. */
  async *generate(
    prompt: string,
    maxTokens: number,
    signal?: AbortSignal,
    image?: Uint8Array,
  ): AsyncGenerator<GenerationEvent> {
    yield* this.ready().generate(prompt, maxTokens, signal, image);
  }
}
