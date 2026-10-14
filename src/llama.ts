// The engine: one model at a time, loaded in-process through libllama (bun:ffi), with token
// counting and streamed generation. Switching models frees the loaded one and loads the other.
// The library runs on a worker thread (src/llama-worker.ts); this file is the server-thread side.

import { join } from "node:path";

import type { Config } from "./config";
import type { WorkerReply, WorkerRequest } from "./llama-worker";
import type { ModelSpec } from "./models";
import { fetchCommand } from "./preflight";

export type EngineState = "stopped" | "loading" | "ready" | "error";

export type FinishReason = "stop" | "length";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

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

type Send<T> = T extends unknown ? Omit<T, "req"> : never;

/** The worker thread that owns libllama, and the requests waiting on it. */
class NativeWorker {
  /** Resolves with the reason if the thread dies; every model it held is gone then. */
  readonly lost: Promise<string>;

  private worker: Worker;
  private waiting = new Map<number, (reply: WorkerReply) => void>();
  private lastReq = 0;
  private lastModel = 0;

  constructor(onLost: () => void) {
    // Not referenced: the server decides when the process ends, not an idle engine thread.
    this.worker = new Worker(new URL("./llama-worker.ts", import.meta.url).href, { ref: false });
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => this.waiting.get(event.data.req)?.(event.data);
    this.lost = new Promise((resolve) => {
      const fail = (reason: string) => {
        onLost();
        resolve(reason);
        for (const [req, deliver] of this.waiting) {
          deliver({ type: "error", req, message: reason });
        }
      };
      this.worker.onerror = (event) => fail(`the engine thread failed: ${event.message}`);
      this.worker.addEventListener("close", () => fail("the engine thread exited"));
    });
  }

  private send(msg: Send<WorkerRequest>, deliver: (reply: WorkerReply) => void): number {
    const req = ++this.lastReq;
    this.waiting.set(req, deliver);
    this.worker.postMessage({ ...msg, req });
    return req;
  }

  /** One request, one reply. */
  private call(msg: Send<WorkerRequest>): Promise<WorkerReply> {
    return new Promise((resolve, reject) => {
      const req = this.send(msg, (reply) => {
        this.waiting.delete(req);
        if (reply.type === "error") {
          reject(new (reply.image ? ImageInputError : EngineError)(reply.message));
        } else {
          resolve(reply);
        }
      });
    });
  }

  async load(model: ModelSpec, cfg: Config): Promise<Running> {
    const no = ++this.lastModel;
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
          `the image encoder of ${model.id} is not at ${mmproj}; download it with: ${fetchCommand()} --model ${model.id}`,
        );
      }
    };
    await this.call({
      type: "load",
      model: no,
      options: {
        dir: cfg.llamaDir,
        path: join(cfg.modelsDir, model.file),
        mmproj,
        gpuLayers: cfg.gpuLayers,
        ctxSize: cfg.ctxSize,
        // Physical cores, roughly: hyperthreads do not help llama.cpp.
        threads: cfg.threads || Math.max(1, Math.floor(navigator.hardwareConcurrency / 2)),
      },
    });

    let finish!: (reason: string | undefined) => void;
    const exited = new Promise<string | undefined>((resolve) => {
      finish = resolve;
    });
    void this.lost.then(finish);
    return {
      exited,
      stop: () => void this.call({ type: "unload", model: no }).then(() => finish(undefined), finish),
      countTokens: async (content, image) => {
        await checkImage(image);
        const reply = await this.call({ type: "count", model: no, content, image });
        if (reply.type !== "count") {
          throw new EngineError(`unexpected ${reply.type} reply to a token count`);
        }
        return reply.tokens;
      },
      generate: (content, maxTokens, signal, image) => this.generate(no, content, maxTokens, signal, image, checkImage),
    };
  }

  private async *generate(
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
    const replies: WorkerReply[] = [];
    let wake: (() => void) | undefined;
    const req = this.send({ type: "generate", model, content, maxTokens, image }, (reply) => {
      replies.push(reply);
      wake?.();
    });
    const onAbort = () => wake?.();
    signal?.addEventListener("abort", onAbort);
    let ended = false;
    try {
      for (;;) {
        while (replies.length === 0 && !signal?.aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        signal?.throwIfAborted();
        const reply = replies.shift()!;
        if (reply.type === "delta") {
          yield { type: "delta", text: reply.text };
        } else if (reply.type === "done") {
          ended = true;
          yield { type: "done", finishReason: reply.finishReason, usage: reply.usage, timings: reply.timings };
          return;
        } else if (reply.type === "error") {
          ended = true;
          if (reply.image) {
            throw new ImageInputError(reply.message);
          }
          throw new EngineError(`generation failed: ${reply.message}`);
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.waiting.delete(req);
      // Aborted, or the consumer stopped reading: the worker gives up at its next token.
      if (!ended) {
        this.worker.postMessage({ type: "cancel", req } satisfies WorkerRequest);
      }
    }
  }
}

let nativeWorker: NativeWorker | undefined;

/** Loads the model with libllama on the engine thread, which is started on first use. */
export const launchNative: Launcher = async (model, cfg) => {
  const modelPath = join(cfg.modelsDir, model.file);
  if (!(await Bun.file(modelPath).exists())) {
    throw new EngineError(`model not found at ${modelPath}; run: ${fetchCommand()}`);
  }
  nativeWorker ??= new NativeWorker(() => {
    if (nativeWorker === worker) {
      nativeWorker = undefined;
    }
  });
  const worker = nativeWorker;
  return worker.load(model, cfg);
};

export class Engine {
  state: EngineState = "stopped";
  /** The model that is loaded or loading. */
  loaded?: ModelSpec;
  error?: string;

  private running?: Running;
  /** Bumped by every load() and unload(); a load that finds it changed has been superseded. */
  private epoch = 0;

  constructor(
    private cfg: Config,
    private launch: Launcher = launchNative,
  ) {}

  /**
   * Makes `model` the loaded one, replacing any other. Callers must hold the queue slot, so no
   * generation runs while the model is being swapped.
   */
  async load(model: ModelSpec): Promise<void> {
    if (this.state === "ready" && this.loaded?.id === model.id) {
      return;
    }
    // A client that gave up frees the queue slot while its load is still in flight, so a later load
    // can start before this one ends. Whichever load is newest wins; an older one frees its own
    // model and leaves the engine state alone.
    const epoch = ++this.epoch;
    await this.stopRunning();
    this.state = "loading";
    this.loaded = model;
    this.error = undefined;
    try {
      const running = await this.launch(model, this.cfg);
      if (epoch !== this.epoch) {
        running.stop();
        await running.exited;
        throw new EngineError("the model load was superseded by a newer one");
      }
      this.running = running;
      void running.exited.then((reason) => {
        if (this.running !== running) {
          return;
        }
        this.running = undefined;
        this.loaded = undefined;
        this.state = "error";
        this.error = reason ?? "the model was unloaded";
        console.error(`[engine] ${this.error}`);
      });
      this.state = "ready";
      console.error(`[engine] ${model.id} ready`);
    } catch (e) {
      if (epoch !== this.epoch) {
        throw e instanceof EngineError ? e : new EngineError(String(e));
      }
      const message = e instanceof Error ? e.message : String(e);
      await this.stopRunning();
      this.state = "error";
      this.error = message;
      console.error(`[engine] could not load ${model.id}: ${message}`);
      throw e instanceof EngineError ? e : new EngineError(message);
    }
  }

  /** Frees the loaded model, if any. */
  async unload(): Promise<void> {
    this.epoch++;
    await this.stopRunning();
  }

  private async stopRunning(): Promise<void> {
    const { running } = this;
    this.running = undefined;
    this.loaded = undefined;
    this.state = "stopped";
    if (!running) {
      return;
    }
    running.stop();
    await running.exited;
  }

  /** The loaded model, or an EngineError while there is none to use. */
  private ready(): Running {
    if (this.state !== "ready" || !this.running) {
      throw new EngineError(`the engine is ${this.state}`);
    }
    return this.running;
  }

  /**
   * Tokens a user message with this content occupies in the context, chat template included.
   * Counted by the model that is loaded now, without waiting for a generation. Throws EngineError
   * when no model is ready or it goes away before answering.
   */
  async countPromptTokens(content: string, image?: Uint8Array): Promise<number> {
    return this.ready().countTokens(content, image);
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
