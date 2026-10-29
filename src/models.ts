// The models this backend can run. Only one is loaded at a time (16 GiB of VRAM holds one 9B
// Q6_K with its long context, not two), so a request for another model swaps the engine.

import type { ModelId, ModelKind } from "./api";
import { DOCUMENT_DIRECTIONS } from "./prompt";

export interface ModelSpec {
  /** Public identifier used in requests and responses. */
  id: ModelId;
  label: string;
  /** File name inside the models directory. */
  file: string;
  /**
   * "chat": free-form translation with glossary and constraints.
   * "document": the NativeLong checkpoint, fixed prompt templates for whole-document translation.
   */
  kind: ModelKind;
  /** Directions a document model accepts, as "<source>-<target>" codes. */
  directions?: string[];
  /**
   * File name, inside the models directory, of the model's image encoder and projector. A model
   * that has one translates the text in an image; the file is loaded when the first image arrives.
   */
  mmproj?: string;
  /** The GGUF has an MTP layer, which drafts tokens for faster decoding where the GPU has room for it. */
  mtp?: boolean;
}

/** Keyed by the API's model ids: a model the spec adds or drops is a type error here. */
const SPECS: Record<ModelId, Omit<ModelSpec, "id">> = {
  "index-translate-9b": {
    label: "Index-Translate-9B (Q6_K)",
    file: "Index-Translate-9B.Q6_K.gguf",
    kind: "chat",
    mmproj: "Index-Translate-9B.mmproj-Q8_0.gguf",
    mtp: true,
  },
  "index-nailong-9b": {
    label: "Index-NativeLong-9B (Q6_K)",
    file: "Index-Nailong-9B.Q6_K.gguf",
    kind: "document",
    directions: DOCUMENT_DIRECTIONS,
  },
};

export const MODELS: ModelSpec[] = (Object.keys(SPECS) as ModelId[]).map((id) => ({ id, ...SPECS[id] }));

export const DEFAULT_MODEL_ID: ModelId = "index-translate-9b";

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

/** The spec of the configured default model; `loadConfig` has refused an unknown id, so it exists. */
export function defaultModelSpec(cfg: { defaultModel: string }): ModelSpec {
  const model = findModel(cfg.defaultModel);
  if (!model) {
    throw new Error(`unknown default model "${cfg.defaultModel}"`);
  }
  return model;
}
