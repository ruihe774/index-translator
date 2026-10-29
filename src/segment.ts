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
import { fetchAdvice } from "./preflight";
import type { SegmentModel, SegmentProtocol } from "./segment-worker";
import { abortable, LazyModel, startWorker, WorkerClient } from "./worker-rpc";

/** Most UTF-16 code units one request may hold in all its texts: about a second of work on a few cores. */
export const MAX_SEGMENT_CHARS = 20_000;
/** Most texts in one request. */
export const MAX_SEGMENT_TEXTS = 256;
/** Positions less likely than this to end a sentence are not reported. */
const MIN_BOUNDARY_PROBABILITY = 0.001;
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

interface ModelStatus {
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

/** Starts the thread that owns ONNX Runtime; replaceable in tests. */
type SegmentWorkerFactory = () => Worker;

const defaultWorker: SegmentWorkerFactory = () => startWorker("segment-worker.ts");

type SegmentClient = WorkerClient<SegmentProtocol>;

/** What each model is called in messages and logs, what it needs, and how to get it. */
const MODELS: Record<
  SegmentModel,
  {
    name: string;
    /** What `missing` says when the setting turns the model off. */
    disabledMessage: string;
    files: string[];
    fetchId: string;
    enabled: (cfg: Config) => boolean;
    dir: (cfg: Config) => string;
  }
> = {
  sat: {
    name: "segmentation",
    disabledMessage: "sentence segmentation is turned off (SEGMENT=0)",
    files: ["model.onnx", "tokenizer.json"],
    fetchId: "sat-3l-sm",
    enabled: (cfg) => cfg.segment,
    dir: (cfg) => cfg.segmentModelDir,
  },
  labse: {
    name: "alignment",
    disabledMessage: "sentence alignment is turned off (ALIGN=0)",
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

/** One model on the shared worker. */
class ModelSlot implements ModelStatus {
  private readonly lazy: LazyModel;

  constructor(
    private readonly model: SegmentModel,
    private readonly cfg: Config,
    client: SegmentClient,
  ) {
    const { name } = MODELS[model];
    this.lazy = new LazyModel({
      tag: "segment",
      model: `${name} model`,
      missing: () => this.missing(),
      idleUnload: cfg.segmentIdleUnload,
      load: async () => {
        const threads = inferenceThreads(cfg.segmentThreads);
        const { version } = await client.call("load", {
          model,
          options: { runtimeDir: cfg.onnxruntimeDir, modelDir: MODELS[model].dir(cfg), threads },
        });
        return `, ${threads} threads${version ? `, ONNX Runtime ${version}` : ""}`;
      },
      unload: () => client.call("unload", { model }),
      error: (message) => new SegmentError(message),
    });
  }

  /** Why the model cannot run at all, checked each time so an install does not need a restart. */
  private missing(): string | undefined {
    const { disabledMessage, name, files, fetchId, enabled, dir } = MODELS[this.model];
    if (!enabled(this.cfg)) {
      return disabledMessage;
    }
    if (!existsSync(libraryPath(this.cfg.onnxruntimeDir))) {
      return "ONNX Runtime is not installed; run bun scripts/fetch_onnxruntime.ts";
    }
    if (files.some((f) => !existsSync(join(dir(this.cfg), f)))) {
      return `the ${name} model is not installed; ${fetchAdvice([fetchId])}`;
    }
    return undefined;
  }

  get state(): SegmentState {
    return this.lazy.state;
  }

  get error(): string | undefined {
    return this.lazy.error;
  }

  /**
   * Runs one request of the model once it is loaded. An aborted request is answered at once with the
   * signal's reason; the worker gives up after its current batch, and says so with `aborted`, which
   * nobody receives and which is therefore an error here.
   */
  run<R extends { type: string }>(
    send: (abort: SharedArrayBuffer) => Promise<R>,
    signal: AbortSignal,
  ): Promise<Exclude<R, { type: "aborted" }>> {
    const missing = this.missing();
    if (missing) {
      return Promise.reject(new SegmentError(missing));
    }
    return abortable(signal, async (abort) => {
      const unhold = this.lazy.hold();
      try {
        await this.lazy.ready();
        // Gone while the model was loading: the request is never sent.
        signal.throwIfAborted();
        const reply = await send(abort);
        if (reply.type === "aborted") {
          throw new SegmentError("the request was stopped");
        }
        return reply as Exclude<R, { type: "aborted" }>;
      } finally {
        unhold();
      }
    });
  }

  /** The thread holding the model died. */
  workerLost(reason: string): void {
    this.lazy.workerLost(reason);
  }

  /** The thread was stopped, and the model with it. */
  stopped(): void {
    this.lazy.unloaded();
  }
}

export class NativeSegmenter implements Segmenter {
  /** The thread that owns ONNX Runtime, started by the first request. */
  private readonly worker: SegmentClient;
  readonly sentences: ModelSlot;
  readonly aligner: ModelSlot;

  constructor(cfg: Config, makeWorker: SegmentWorkerFactory = defaultWorker) {
    // If the thread dies its models are gone with it; the next request starts another.
    this.worker = new WorkerClient({
      start: makeWorker,
      label: "segmentation thread",
      fail: (reply) => new SegmentError(reply.message),
      onLost: (reason) => {
        this.sentences.workerLost(reason);
        this.aligner.workerLost(reason);
        console.error(`[segment] ${reason}`);
      },
    });
    this.sentences = new ModelSlot("sat", cfg, this.worker);
    this.aligner = new ModelSlot("labse", cfg, this.worker);
  }

  get state(): SegmentState {
    return this.sentences.state;
  }

  get error(): string | undefined {
    return this.sentences.error;
  }

  async segment(texts: string[], signal: AbortSignal): Promise<SegmentedText[]> {
    const reply = await this.sentences.run(
      (abort) => this.worker.call("segment", { texts, minProbability: MIN_BOUNDARY_PROBABILITY, abort }),
      signal,
    );
    return reply.texts;
  }

  async align(unit: AlignUnit, source: string[], target: string[], signal: AbortSignal): Promise<AlignedPair[]> {
    const reply = await this.aligner.run((abort) => this.worker.call("align", { unit, source, target, abort }), signal);
    return reply.pairs;
  }

  async stop(): Promise<void> {
    if (this.worker.started) {
      // Waits for a running request, then frees the models.
      await Promise.all(
        (Object.keys(MODELS) as SegmentModel[]).map((model) => this.worker.call("unload", { model }).catch(() => {})),
      );
      this.worker.terminate();
    }
    this.sentences.stopped();
    this.aligner.stopped();
  }
}

export const nativeSegmenter: SegmentLauncher = (cfg) => new NativeSegmenter(cfg);
