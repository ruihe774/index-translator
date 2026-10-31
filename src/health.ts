// The two read-only status endpoints: `GET /health` (polled by the page) and `GET /models`.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Health, ModelList } from "./api";
import type { Config } from "./config";
import { json } from "./http";
import { IMAGE_FORMATS, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from "./image";
import type { Engine } from "./llama";
import { defaultModelSpec, MODELS } from "./models";
import { launchMode } from "./preflight";
import type { SlotQueue } from "./queue";
import { MAX_ALIGN_CHARS, MAX_SEGMENT_CHARS, missingSegmentModels, type Segmenter } from "./segment";
import {
  MAX_TRANSCRIBE_BYTES,
  MAX_TRANSCRIBE_RATE,
  MAX_TRANSCRIBE_SECONDS,
  MIN_TRANSCRIBE_RATE,
  missingSpeechModels,
  type Speech,
} from "./speech";
import { limits } from "./translate";

/** How long the list of missing model files is reused: the page polls `/health`, and the files change rarely. */
const MISSING_CACHE_MS = 2000;

export interface HealthDeps {
  cfg: Config;
  engine: Engine;
  speech: Speech;
  segmenter: Segmenter;
  queue: SlotQueue;
  /** Why `POST /webpage` cannot be used, or undefined when it can. */
  webpageProblem(): Promise<string | undefined>;
}

export function createStatus(d: HealthDeps) {
  const { cfg, engine, speech, segmenter, queue } = d;
  const defaultModel = defaultModelSpec(cfg);
  let missing: { at: number; value: Health["missing_models"] } | undefined;

  /** The file system is read at most once per MISSING_CACHE_MS: `existsSync` blocks the polled endpoint. */
  function missingModels(): Health["missing_models"] {
    const now = Date.now();
    if (!missing || now - missing.at > MISSING_CACHE_MS) {
      missing = {
        at: now,
        value: {
          required: MODELS.filter((m) =>
            [m.file, m.mmproj].some((f) => f !== undefined && !existsSync(join(cfg.modelsDir, f))),
          ).map((m) => m.id),
          optional: [...missingSpeechModels(cfg), ...missingSegmentModels(cfg)],
        },
      };
    }
    return missing.value;
  }

  function transcribeStatus(): Health["transcribe"] {
    const problem = speech.transcribeProblem();
    return {
      ...(problem ? { status: "unavailable", error: problem } : { status: "available" }),
      separation: speech.canSeparate(),
      max_seconds: MAX_TRANSCRIBE_SECONDS,
      max_bytes: MAX_TRANSCRIBE_BYTES,
      sample_rate: { min: MIN_TRANSCRIBE_RATE, max: MAX_TRANSCRIBE_RATE },
    };
  }

  async function health(): Promise<Response> {
    const [memory, webpageStatus] = await Promise.all([engine.gpuMemory(), d.webpageProblem()]);
    return json<Health>(
      {
        status: engine.state,
        error: engine.error,
        model: engine.loaded?.id ?? null,
        limits: limits(cfg),
        missing_models: missingModels(),
        started_from: launchMode(),
        ...(memory && { gpu_memory: { total_bytes: memory.total, free_bytes: memory.free } }),
        queue: { running: queue.running, waiting: queue.depth, max_waiting: cfg.maxQueue },
        speech: { status: speech.state, error: speech.error },
        segment: { status: segmenter.state, error: segmenter.error, max_chars: MAX_SEGMENT_CHARS },
        align: { status: segmenter.aligner.state, error: segmenter.aligner.error, max_chars: MAX_ALIGN_CHARS },
        transcribe: transcribeStatus(),
        webpage: webpageStatus ? { status: "unavailable", error: webpageStatus } : { status: "available" },
      },
      engine.state === "ready" ? 200 : 503,
    );
  }

  function models(): Response {
    return json<ModelList>({
      default: defaultModel.id,
      loaded: engine.loaded?.id ?? null,
      models: MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        kind: m.kind,
        image: m.mmproj !== undefined,
        ...(m.directions && { directions: m.directions }),
      })),
      image: {
        formats: IMAGE_FORMATS.map((f) => `image/${f}`),
        max_bytes: MAX_IMAGE_BYTES,
        max_pixels: MAX_IMAGE_PIXELS,
      },
    });
  }

  return { health, models };
}
