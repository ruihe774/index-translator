// Builds the /translate request body from the form's values. Pure: no DOM access.

import { type GlossaryProblem, parseGlossary } from "./glossary.js";
import { CHAT_MODEL, type ModelId } from "./select-model.js";

export interface FormValues {
  text: string;
  targetLang: string;
  glossary: string;
  hard: string;
  soft: string;
  genre: string;
}

/**
 * Glossary, hard or soft constraints need the chat model. Genre does not count here: the backend
 * (src/prompt.ts buildPrompt) only uses genre inside the constraint prompt, so with no glossary or
 * constraints it is ignored, and the document model rejects it (src/app.ts checkDocumentRequest).
 */
export function hasOptions(v: Pick<FormValues, "glossary" | "hard" | "soft">): boolean {
  return Boolean(v.glossary.trim() || v.hard.trim() || v.soft.trim());
}

export function lines(value: string): string[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function glossaryMessage(p: GlossaryProblem): string {
  return p.kind === "duplicate"
    ? `Glossary line ${p.line} repeats the source term "${p.term}". Each source term may appear only once.`
    : `Glossary line ${p.line} must look like: source term = target term.`;
}

export type RequestResult = { body: Record<string, unknown> } | { glossaryProblem: GlossaryProblem };

/**
 * The request for a text. The options (glossary, constraints, genre) go only to the chat model; the
 * document model rejects them. A malformed glossary stops the request. `sourceLang` is what the
 * selection decided to send.
 */
export function buildRequest(model: ModelId, sourceLang: string | undefined, v: FormValues): RequestResult {
  return build({ model, text: v.text, target_lang: v.targetLang, stream: true }, sourceLang, v);
}

/**
 * The request for an image (a `data:` URL of the file) in place of a text. Only the chat model reads
 * images; it takes the glossary and the constraints with one, but no genre, and no text is sent.
 */
export function buildImageRequest(
  image: string,
  sourceLang: string | undefined,
  v: Omit<FormValues, "text" | "genre">,
): RequestResult {
  const body = { model: CHAT_MODEL, image, target_lang: v.targetLang, stream: true };
  return build(body, sourceLang, { ...v, genre: "" });
}

function build(
  body: Record<string, unknown>,
  sourceLang: string | undefined,
  v: Omit<FormValues, "text">,
): RequestResult {
  if (sourceLang) body.source_lang = sourceLang;
  if (body.model !== CHAT_MODEL) return { body };

  const { glossary, error } = parseGlossary(v.glossary);
  if (error) return { glossaryProblem: error };
  const hasGlossary = Object.keys(glossary).length > 0;
  if (hasGlossary) body.glossary = glossary;
  if (v.hard.trim()) body.hard_constraints = lines(v.hard);
  if (v.soft.trim()) body.soft_constraints = lines(v.soft);
  // Genre is sent only with a glossary or constraints; alone the backend ignores it (see hasOptions).
  if (v.genre.trim() && (hasGlossary || body.hard_constraints || body.soft_constraints)) body.genre = v.genre.trim();
  return { body };
}
