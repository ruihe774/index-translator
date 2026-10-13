// The models this backend can run. Only one is loaded at a time (16 GiB of VRAM holds one 9B
// Q6_K with its long context, not two), so a request for another model swaps the engine.

export interface ModelSpec {
  /** Public identifier used in requests and responses. */
  id: string;
  label: string;
  /** File name inside the models directory. */
  file: string;
  /**
   * "chat": free-form translation with glossary and constraints.
   * "document": the NativeLong checkpoint, fixed prompt templates for whole-document translation.
   */
  kind: "chat" | "document";
  /** Directions a document model accepts, as "<source>-<target>" codes. */
  directions?: string[];
  /**
   * File name, inside the models directory, of the model's image encoder and projector. A model
   * that has one translates the text in an image; the file is loaded when the first image arrives.
   */
  mmproj?: string;
}

export const MODELS: ModelSpec[] = [
  {
    id: "index-translate-9b",
    label: "Index-Translate-9B (Q6_K)",
    file: "Index-Translate-9B.Q6_K.gguf",
    kind: "chat",
    mmproj: "Index-Translate-9B.mmproj-Q8_0.gguf",
  },
  {
    id: "index-nailong-9b",
    label: "Index-NativeLong-9B (Q6_K)",
    file: "Index-Nailong-9B.Q6_K.gguf",
    kind: "document",
    directions: ["zh-en", "en-zh", "zh-ja", "ja-zh"],
  },
];

export const DEFAULT_MODEL_ID = "index-translate-9b";

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}
