// Chooses the model for a request from the input length. Pure, so bun test can import it
// straight from the same file the browser loads.
//
// The backend never picks a model by looking at the text (README, "Models"); the client does.

export const CHAT_MODEL = "index-translate-9b";
export const DOCUMENT_MODEL = "index-nailong-9b";

/**
 * Largest input, in letters, that index-translate-9b translated completely in one pass: 20
 * paragraphs, 11.1K letters. All 30 paragraphs (16.6K letters) lost 11 paragraphs and repeated 2
 * with finish_reason "stop". The real limit lies somewhere between the two and was not measured, so
 * this is the largest size verified good, not a measured failure point. See README, "Long inputs".
 */
export const LONG_THRESHOLD_LETTERS = 11_000;

/** Directions index-nailong-9b has templates for; mirrors DOCUMENT_DIRECTIONS in src/prompt.ts. */
export const DOCUMENT_DIRECTIONS = ["zh-en", "en-zh", "zh-ja", "ja-zh"];

export type ModelId = typeof CHAT_MODEL | typeof DOCUMENT_MODEL;
export type Choice = "auto" | ModelId;

export type Reason =
  /** Within the single-pass range: the general model. */
  | "short"
  /** Over the threshold in a direction the document model supports. */
  | "long-document"
  /** Over the threshold, but the direction has no document template. Warn. */
  | "long-unsupported-direction"
  /** Over the threshold, but the source language could not be determined. Warn. */
  | "long-unknown-source"
  /** Over the threshold, but glossary or constraints rule out the document model. Warn. */
  | "long-options"
  /** The user picked the model. */
  | "manual"
  /** The user picked the document model but the request cannot be sent to it. */
  | "manual-document-unusable";

export interface Selection {
  model: ModelId;
  reason: Reason;
  letters: number;
  /** The source language to send: the chosen one, or the detected one when "auto" was chosen. */
  sourceLang: string | undefined;
  /** True for reasons that tell the user the result may be incomplete or the request will fail. */
  warn: boolean;
}

export interface SelectionInput {
  text: string;
  /** A language code, or "auto". */
  sourceLang: string;
  targetLang: string;
  /** Glossary, constraints or genre were entered; the document model rejects all of them. */
  hasOptions: boolean;
  choice: Choice;
}

const LETTER = /\p{L}/u;

/** Unicode letters in the trimmed text: spaces, digits and punctuation do not count. */
export function countLetters(text: string): number {
  let n = 0;
  for (const ch of text) if (LETTER.test(ch)) n++;
  return n;
}

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HAN = /\p{Script=Han}/gu;
const LATIN_LETTER = /[A-Za-z]/g;
const ENGLISH_WORDS = new Set(["the", "and", "of", "to", "in", "is", "that", "it", "was", "for", "with", "as", "on"]);

/**
 * Best-effort source language for the four document directions. Returns undefined when the text is
 * not clearly Chinese, Japanese or English; Latin-script text counts as English only when it is
 * plain ASCII and full of common English words, so French or German is not taken for English.
 */
export function detectSource(text: string): "zh" | "ja" | "en" | undefined {
  const letters = countLetters(text);
  if (letters === 0) return undefined;
  const kana = text.match(KANA)?.length ?? 0;
  const han = text.match(HAN)?.length ?? 0;
  if (kana / letters > 0.05) return "ja";
  if (han / letters > 0.3) return "zh";
  const ascii = text.match(LATIN_LETTER)?.length ?? 0;
  if (ascii / letters < 0.98) return undefined;
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return undefined;
  let common = 0;
  for (const w of words) if (ENGLISH_WORDS.has(w)) common++;
  return common / words.length > 0.1 ? "en" : undefined;
}

export function selectModel(input: SelectionInput): Selection {
  const text = input.text.trim();
  const letters = countLetters(text);
  const target = input.targetLang.toLowerCase();
  const explicit = input.sourceLang !== "auto";
  const sourceLang = explicit ? input.sourceLang.toLowerCase() : detectSource(text);
  const supported = sourceLang !== undefined && DOCUMENT_DIRECTIONS.includes(`${sourceLang}-${target}`);
  const make = (model: ModelId, reason: Reason, warn: boolean): Selection => ({
    model,
    reason,
    letters,
    // Only the document model needs the source spelled out; the chat model detects it itself.
    sourceLang: explicit ? sourceLang : model === DOCUMENT_MODEL ? sourceLang : undefined,
    warn,
  });

  if (input.choice === CHAT_MODEL) return make(CHAT_MODEL, "manual", letters > LONG_THRESHOLD_LETTERS);
  if (input.choice === DOCUMENT_MODEL) {
    const usable = supported && !input.hasOptions;
    return make(DOCUMENT_MODEL, usable ? "manual" : "manual-document-unusable", !usable);
  }

  if (letters <= LONG_THRESHOLD_LETTERS) return make(CHAT_MODEL, "short", false);
  if (input.hasOptions) return make(CHAT_MODEL, "long-options", true);
  if (sourceLang === undefined) return make(CHAT_MODEL, "long-unknown-source", true);
  if (!supported) return make(CHAT_MODEL, "long-unsupported-direction", true);
  return make(DOCUMENT_MODEL, "long-document", false);
}
