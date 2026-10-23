// Sentence boundaries with SaT (Segment any Text, sat-3l-sm), and sentence alignment with LaBSE, in-process
// through ONNX Runtime's C API (bun:ffi). The library runs on a worker thread (src/segment-worker.ts);
// this file is the server-thread side. Each model is loaded by the first request that needs it and freed
// again after `SEGMENT_IDLE_UNLOAD` seconds without one. They run on the processor, beside the
// translation and speech engines.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AlignedPair, AlignUnit, SegmentedText, SegmentStatus } from "./api";
import type { Config } from "./config";
import { inferenceThreads } from "./cpu";
import { libraryPath } from "./onnxruntime-ffi";
import { fetchCommand } from "./preflight";
import type { SegmentModel, SegmentWorkerReply, SegmentWorkerRequest } from "./segment-worker";

/** Most UTF-16 code units one request may hold in all its texts: about a second of work on a few cores. */
export const MAX_SEGMENT_CHARS = 20_000;
/** Most texts in one request. */
export const MAX_SEGMENT_TEXTS = 256;
/** Positions less likely than this to end a sentence are not reported. */
export const MIN_BOUNDARY_PROBABILITY = 0.001;
/** Most sentences or paragraphs on each side of one `POST /align`. */
export const MAX_ALIGN_SENTENCES = 256;
/**
 * Most UTF-16 code units in all the sentences of one `POST /align`. Paragraphs are not limited by it:
 * only their openings are read, at most 2 × 256 of a few hundred characters.
 */
export const MAX_ALIGN_CHARS = MAX_SEGMENT_CHARS;

export class SegmentError extends Error {}

/**
 * `unavailable`: turned off, or ONNX Runtime or the model is missing (`error` says which);
 * `stopped`: installed, the model is not loaded; `starting`: loading it; `ready`; `error`: the
 * last load failed.
 */
export type SegmentState = SegmentStatus;

export interface ModelStatus {
  readonly state: SegmentState;
  readonly error: string | undefined;
}

export interface Segmenter extends ModelStatus {
  /** The alignment model's status. */
  readonly aligner: ModelStatus;
  /**
   * The likely sentence ends of each text, in UTF-16 code units, as `POST /segment` answers them.
   * Rejects with SegmentError, or with the signal's reason when aborted: a request not started is
   * never run, a running one stops after its current batch.
   */
  segment(texts: string[], signal: AbortSignal): Promise<SegmentedText[]>;
  /** Which sentences or paragraphs of `target` translate which of `source`, as `POST /align` answers it; rejects as `segment` does. */
  align(unit: AlignUnit, source: string[], target: string[], signal: AbortSignal): Promise<AlignedPair[]>;
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

/** What each model is called in messages and logs, what it needs, and how to get it. */
const MODELS: Record<
  SegmentModel,
  { name: string; files: string[]; fetchId: string; enabled: (cfg: Config) => boolean; dir: (cfg: Config) => string }
> = {
  sat: {
    name: "segmentation",
    files: ["model.onnx", "tokenizer.json"],
    fetchId: "sat-3l-sm",
    enabled: (cfg) => cfg.segment,
    dir: (cfg) => cfg.segmentModelDir,
  },
  labse: {
    name: "alignment",
    files: ["model.onnx", "vocab.txt", "dense.safetensors"],
    fetchId: "labse",
    enabled: (cfg) => cfg.align,
    dir: (cfg) => cfg.alignModelDir,
  },
};

/** The `fetch_models.ts` ids of the segmentation and alignment models that are turned on and not installed. */
export function missingSegmentModels(cfg: Config): string[] {
  return Object.values(MODELS)
    .filter((m) => m.enabled(cfg) && m.files.some((f) => !existsSync(join(m.dir(cfg), f))))
    .map((m) => m.fetchId);
}

/** One model's life on the shared worker: loaded by the first request, freed when idle. */
class ModelSlot implements ModelStatus {
  loaded = false;
  private loading: Promise<void> | null = null;
  failure: string | undefined;
  /** Requests for this model handed to the worker that it has not answered. */
  private pending = 0;
  private idle: Timer | undefined;

  constructor(
    private readonly model: SegmentModel,
    private readonly cfg: Config,
    private readonly call: (msg: Send<SegmentWorkerRequest>) => Promise<SegmentWorkerReply>,
  ) {}

  private get spec() {
    return MODELS[this.model];
  }

  /** Why the model cannot run at all, checked each time so an install does not need a restart. */
  missing(): string | undefined {
    const { name, files, fetchId, enabled, dir } = this.spec;
    if (!enabled(this.cfg)) {
      return this.model === "sat"
        ? "sentence segmentation is turned off (SEGMENT=0)"
        : "sentence alignment is turned off (ALIGN=0)";
    }
    if (!existsSync(libraryPath(this.cfg.onnxruntimeDir))) {
      return "ONNX Runtime is not installed; run bun scripts/fetch_onnxruntime.ts";
    }
    if (files.some((f) => !existsSync(join(dir(this.cfg), f)))) {
      return `the ${name} model is not installed; run ${fetchCommand()} --model ${fetchId}`;
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

  private async load(): Promise<void> {
    const started = performance.now();
    const threads = inferenceThreads(this.cfg.segmentThreads);
    let reply: SegmentWorkerReply;
    try {
      reply = await this.call({
        type: "load",
        model: this.model,
        options: { runtimeDir: this.cfg.onnxruntimeDir, modelDir: this.spec.dir(this.cfg), threads },
      });
    } catch (e) {
      this.failure = `the ${this.spec.name} model could not be loaded: ${messageOf(e)}`;
      console.error(`[segment] ${this.failure}`);
      throw new SegmentError(this.failure);
    }
    this.loaded = true;
    this.failure = undefined;
    const version = reply.type === "ok" && reply.version ? `, ONNX Runtime ${reply.version}` : "";
    console.error(
      `[segment] ${this.spec.name} model ready (${Math.round(performance.now() - started)} ms, ${threads} threads${version})`,
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
      this.call({ type: "unload", model: this.model }).then(
        () => console.error(`[segment] ${this.spec.name} model unloaded after being idle`),
        () => {},
      );
    }, this.cfg.segmentIdleUnload * 1000);
    this.idle.unref();
  }

  /**
   * Runs `msg` once the model is loaded. An aborted request is answered at once with the signal's
   * reason; the worker gives up after its current batch.
   */
  run(msg: (abort: SharedArrayBuffer) => Send<SegmentWorkerRequest>, signal: AbortSignal): Promise<SegmentWorkerReply> {
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
    const work = (async () => {
      await this.ready();
      // Gone while the model was loading: the request is never sent.
      signal.throwIfAborted();
      const reply = await this.call(msg(abort.buffer));
      // Nobody receives this: the caller was answered with the signal's reason when it aborted.
      if (reply.type === "aborted") {
        throw new SegmentError("the request was stopped");
      }
      return reply;
    })().finally(() => {
      this.pending--;
      this.unloadWhenIdle();
    });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        Atomics.store(abort, 0, 1);
        reject(signal.reason as Error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  stopped(): void {
    clearTimeout(this.idle);
    this.loaded = false;
  }
}

export class NativeSegmenter implements Segmenter {
  /** The thread that owns ONNX Runtime, started by the first request. */
  private worker: Worker | null = null;
  private readonly waiting = new Map<number, (reply: SegmentWorkerReply) => void>();
  private lastReq = 0;
  private readonly sat: ModelSlot;
  readonly aligner: ModelSlot;

  constructor(
    cfg: Config,
    private readonly makeWorker: SegmentWorkerFactory = defaultWorker,
  ) {
    const call = (msg: Send<SegmentWorkerRequest>) => this.call(msg);
    this.sat = new ModelSlot("sat", cfg, call);
    this.aligner = new ModelSlot("labse", cfg, call);
  }

  get state(): SegmentState {
    return this.sat.state;
  }

  get error(): string | undefined {
    return this.sat.error;
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
    // If the thread dies its models are gone with it; the next request starts another.
    const lost = (reason: string) => {
      if (this.worker !== worker) {
        return;
      }
      this.worker = null;
      for (const slot of [this.sat, this.aligner]) {
        slot.loaded = false;
        slot.failure = reason;
      }
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

  async segment(texts: string[], signal: AbortSignal): Promise<SegmentedText[]> {
    const reply = await this.sat.run(
      (abort) => ({ type: "segment", texts, minProbability: MIN_BOUNDARY_PROBABILITY, abort }),
      signal,
    );
    if (reply.type !== "boundaries") {
      throw new SegmentError(`unexpected ${reply.type} reply to a segmentation`);
    }
    return reply.texts;
  }

  async align(unit: AlignUnit, source: string[], target: string[], signal: AbortSignal): Promise<AlignedPair[]> {
    const reply = await this.aligner.run((abort) => ({ type: "align", unit, source, target, abort }), signal);
    if (reply.type !== "alignment") {
      throw new SegmentError(`unexpected ${reply.type} reply to an alignment`);
    }
    return reply.pairs;
  }

  async stop(): Promise<void> {
    const { worker } = this;
    if (worker) {
      // Waits for a running request, then frees the models.
      await Promise.all([
        this.call({ type: "unload", model: "sat" }).catch(() => {}),
        this.call({ type: "unload", model: "labse" }).catch(() => {}),
      ]);
      if (this.worker === worker) {
        this.worker = null;
      }
      worker.terminate();
    }
    this.sat.stopped();
    this.aligner.stopped();
  }
}

export const nativeSegmenter: SegmentLauncher = (cfg) => new NativeSegmenter(cfg);
