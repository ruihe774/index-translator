// Sentence boundaries with SaT (Segment any Text, sat-3l-sm), in-process through ONNX Runtime's C API
// (bun:ffi). The library runs on a worker thread (src/segment-worker.ts); this file is the server-thread
// side. The model is loaded by the first request and freed again after `SEGMENT_IDLE_UNLOAD` seconds
// without one. It runs on the processor, beside the translation and speech engines.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SegmentedText, SegmentStatus } from "./api";
import type { Config } from "./config";
import { inferenceThreads } from "./cpu";
import { libraryPath } from "./onnxruntime-ffi";
import { fetchCommand } from "./preflight";
import type { SegmentWorkerReply, SegmentWorkerRequest } from "./segment-worker";

/** What `SEGMENT_MODEL_DIR` must hold (scripts/fetch_models.ts, model `sat-3l-sm`). */
const MODEL_FILES = ["model.onnx", "tokenizer.json"];

/** Most UTF-16 code units one request may hold in all its texts: about a second of work on a few cores. */
export const MAX_SEGMENT_CHARS = 20_000;
/** Most texts in one request. */
export const MAX_SEGMENT_TEXTS = 256;
/** Positions less likely than this to end a sentence are not reported. */
export const MIN_BOUNDARY_PROBABILITY = 0.001;

export class SegmentError extends Error {}

/**
 * `unavailable`: turned off, or ONNX Runtime or the model is missing (`error` says which);
 * `stopped`: installed, the model is not loaded; `starting`: loading it; `ready`; `error`: the
 * last load failed.
 */
export type SegmentState = SegmentStatus;

export interface Segmenter {
  readonly state: SegmentState;
  readonly error: string | undefined;
  /**
   * The likely sentence ends of each text, in UTF-16 code units, as `POST /segment` answers them.
   * Rejects with SegmentError, or with the signal's reason when aborted: a request not started is
   * never run, a running one stops after its current batch.
   */
  segment(texts: string[], signal: AbortSignal): Promise<SegmentedText[]>;
  stop(): Promise<void>;
}

export type SegmentLauncher = (cfg: Config) => Segmenter;

type Send<T> = T extends unknown ? Omit<T, "req"> : never;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Starts the thread that owns ONNX Runtime; replaceable in tests. */
export type SegmentWorkerFactory = () => Worker;

const defaultWorker: SegmentWorkerFactory = () =>
  // Not referenced: the server decides when the process ends, not an idle segmentation thread.
  new Worker(new URL("segment-worker.ts", import.meta.url).href, { ref: false });

export class NativeSegmenter implements Segmenter {
  /** The thread that owns ONNX Runtime, started by the first request. */
  private worker: Worker | null = null;
  private readonly waiting = new Map<number, (reply: SegmentWorkerReply) => void>();
  private lastReq = 0;

  private loaded = false;
  private loading: Promise<void> | null = null;
  private failure: string | undefined;
  /** Requests handed to the worker that it has not answered. */
  private pending = 0;
  private idle: Timer | undefined;

  constructor(
    private readonly cfg: Config,
    private readonly makeWorker: SegmentWorkerFactory = defaultWorker,
  ) {}

  /** Why segmentation cannot run at all, checked each time so an install does not need a restart. */
  private missing(): string | undefined {
    if (!this.cfg.segment) {
      return "sentence segmentation is turned off (SEGMENT=0)";
    }
    if (!existsSync(libraryPath(this.cfg.onnxruntimeDir))) {
      return "ONNX Runtime is not installed; run bun scripts/fetch_onnxruntime.ts";
    }
    if (MODEL_FILES.some((f) => !existsSync(join(this.cfg.segmentModelDir, f)))) {
      return `the segmentation model is not installed; run ${fetchCommand()} --model sat-3l-sm`;
    }
    return undefined;
  }

  get state(): SegmentState {
    if (this.missing()) {
      return "unavailable";
    }
    if (this.loaded) {
      return "ready";
    }
    if (this.loading) {
      return "starting";
    }
    return this.failure ? "error" : "stopped";
  }

  get error(): string | undefined {
    return this.missing() ?? (this.loaded || this.loading ? undefined : this.failure);
  }

  /** One request to the worker, one reply. */
  private call(msg: Send<SegmentWorkerRequest>): Promise<SegmentWorkerReply> {
    const worker = this.worker ?? this.startWorker();
    return new Promise((resolve, reject) => {
      const req = ++this.lastReq;
      this.waiting.set(req, (reply) => {
        this.waiting.delete(req);
        if (reply.type === "error") {
          reject(new SegmentError(reply.message));
        } else {
          resolve(reply);
        }
      });
      worker.postMessage({ ...msg, req });
    });
  }

  private startWorker(): Worker {
    const worker = this.makeWorker();
    worker.onmessage = (event: MessageEvent<SegmentWorkerReply>) => this.waiting.get(event.data.req)?.(event.data);
    // If the thread dies its model is gone with it; the next request starts another.
    const lost = (reason: string) => {
      if (this.worker !== worker) {
        return;
      }
      this.worker = null;
      this.loaded = false;
      this.failure = reason;
      console.error(`[segment] ${reason}`);
      for (const [req, deliver] of this.waiting) {
        deliver({ type: "error", req, message: reason });
      }
    };
    worker.onerror = (event) => lost(`the segmentation thread failed: ${event.message}`);
    worker.addEventListener("close", () => lost("the segmentation thread exited"));
    this.worker = worker;
    return worker;
  }

  private async load(): Promise<void> {
    const started = performance.now();
    const threads = inferenceThreads(this.cfg.segmentThreads);
    let reply: SegmentWorkerReply;
    try {
      reply = await this.call({
        type: "load",
        options: { runtimeDir: this.cfg.onnxruntimeDir, modelDir: this.cfg.segmentModelDir, threads },
      });
    } catch (e) {
      this.failure = `the segmentation model could not be loaded: ${messageOf(e)}`;
      console.error(`[segment] ${this.failure}`);
      throw new SegmentError(this.failure);
    }
    this.loaded = true;
    this.failure = undefined;
    const version = reply.type === "ok" && reply.version ? `, ONNX Runtime ${reply.version}` : "";
    console.error(
      `[segment] model ready (${Math.round(performance.now() - started)} ms, ${threads} threads${version})`,
    );
  }

  private ready(): Promise<void> {
    if (this.loaded) {
      return Promise.resolve();
    }
    this.loading ??= this.load().finally(() => void (this.loading = null));
    return this.loading;
  }

  /** Frees the model once nothing has been asked of it for `SEGMENT_IDLE_UNLOAD` seconds. */
  private unloadWhenIdle(): void {
    clearTimeout(this.idle);
    if (this.pending > 0 || !this.loaded || this.cfg.segmentIdleUnload <= 0) {
      return;
    }
    this.idle = setTimeout(() => {
      if (this.pending > 0 || !this.loaded) {
        return;
      }
      // A request that arrives from here on loads the model again; the worker frees it first.
      this.loaded = false;
      this.call({ type: "unload" }).then(
        () => console.error("[segment] model unloaded after being idle"),
        () => {},
      );
    }, this.cfg.segmentIdleUnload * 1000);
    this.idle.unref();
  }

  private async run(texts: string[], signal: AbortSignal, abort: Int32Array): Promise<SegmentedText[]> {
    await this.ready();
    // Gone while the model was loading: the request is never sent.
    signal.throwIfAborted();
    const reply = await this.call({
      type: "segment",
      texts,
      minProbability: MIN_BOUNDARY_PROBABILITY,
      abort: abort.buffer as SharedArrayBuffer,
    });
    // Nobody receives this: the caller was answered with the signal's reason when it aborted.
    if (reply.type === "aborted") {
      throw new SegmentError("the request was stopped");
    }
    if (reply.type !== "boundaries") {
      throw new SegmentError(`unexpected ${reply.type} reply to a segmentation`);
    }
    return reply.texts;
  }

  segment(texts: string[], signal: AbortSignal): Promise<SegmentedText[]> {
    const missing = this.missing();
    if (missing) {
      return Promise.reject(new SegmentError(missing));
    }
    if (signal.aborted) {
      return Promise.reject(signal.reason as Error);
    }
    clearTimeout(this.idle);
    this.pending++;
    // Shared with the worker thread, which is inside the runtime and reads no messages meanwhile.
    const abort = new Int32Array(new SharedArrayBuffer(4));
    const work = this.run(texts, signal, abort).finally(() => {
      this.pending--;
      this.unloadWhenIdle();
    });
    // An aborted request is answered at once; the worker gives up after its current batch.
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        Atomics.store(abort, 0, 1);
        reject(signal.reason as Error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  async stop(): Promise<void> {
    clearTimeout(this.idle);
    const { worker } = this;
    if (worker) {
      // Waits for a running request, then frees the model.
      await this.call({ type: "unload" }).catch(() => {});
      if (this.worker === worker) {
        this.worker = null;
      }
      worker.terminate();
    }
    this.loaded = false;
  }
}

export const nativeSegmenter: SegmentLauncher = (cfg) => new NativeSegmenter(cfg);
