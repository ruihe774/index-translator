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
  /** A language code, or "auto". Case and surrounding spaces are ignored, as the backend does. */
  sourceLang: string;
  targetLang: string;
  /** Glossary, constraints or genre were entered; the document model rejects all of them. */
  hasOptions: boolean;
  choice: Choice;
}

/**
 * Language detection looks only at the first this many letters. Detection needs a representative
 * sample, not the whole text, and a bounded sample keeps a multi-megabyte paste cheap on every
 * debounced keystroke. The length threshold still counts every letter.
 */
const SAMPLE_LETTERS = 20_000;

// Sticky regexes: test one code point at `lastIndex` without slicing the text. Only non-ASCII code
// points reach them; ASCII is decided by a char-code range check.
const LETTER_AT = /\p{L}/uy;
const KANA_AT = /[\p{Script=Hiragana}\p{Script=Katakana}]/uy;
const HAN_AT = /\p{Script=Han}/uy;

function matchesAt(re: RegExp, text: string, i: number): boolean {
  re.lastIndex = i;
  return re.test(text);
}

interface Scan {
  /** Letters counted: the whole text, or only the sample when the scan stopped at the sample. */
  letters: number;
  /** Letters classified as kana, Han and ASCII: at most SAMPLE_LETTERS. */
  sampleLetters: number;
  kana: number;
  han: number;
  ascii: number;
  /** Index just past the last classified letter. */
  sampleEnd: number;
}

/**
 * One pass over the text. Counts letters, and classifies the first SAMPLE_LETTERS of them as kana,
 * Han or ASCII. No per-match arrays are built. With stopAtSample, the scan ends at the sample.
 *
 * Measured with Bun 1.4.2 on a 4,000,000-code-unit input, median of 7 runs of selectModel(auto):
 * English 175 ms -> 4 ms, Chinese 313 ms -> 60 ms, mixed English and Chinese 146 ms -> 20 ms.
 * The original used one regex test per code point and three global match() arrays per call.
 * Chinese stays the slowest because every CJK letter still needs one sticky regex test for the
 * exact \p{L} check.
 */
function scan(text: string, stopAtSample: boolean): Scan {
  const n = text.length;
  let letters = 0;
  let sampleLetters = 0;
  let kana = 0;
  let han = 0;
  let ascii = 0;
  let sampleEnd = n;
  let i = 0;
  while (i < n) {
    // eslint-disable-next-line unicorn/prefer-code-point -- UTF-16 code units: surrogate pairs are combined by hand below
    const c = text.charCodeAt(i);
    let width = 1;
    let letter: boolean;
    if (c < 0x80) {
      const lower = c | 0x20; // maps 'A'..'Z' onto 'a'..'z' and nothing else onto a letter
      letter = lower >= 0x61 && lower <= 0x7a;
    } else {
      if (c >= 0xd8_00 && c <= 0xdb_ff && i + 1 < n) {
        // eslint-disable-next-line unicorn/prefer-code-point -- the low half of the pair, as a code unit
        const d = text.charCodeAt(i + 1);
        if (d >= 0xdc_00 && d <= 0xdf_ff) {
          width = 2;
        }
      }
      letter = matchesAt(LETTER_AT, text, i);
    }
    if (letter) {
      letters++;
      if (sampleLetters < SAMPLE_LETTERS) {
        sampleLetters++;
        if (c < 0x80) {
          ascii++;
        } else if (matchesAt(KANA_AT, text, i)) {
          kana++;
        } else if (matchesAt(HAN_AT, text, i)) {
          han++;
        }
        if (sampleLetters === SAMPLE_LETTERS) {
          sampleEnd = i + width;
          if (stopAtSample) {
            break;
          }
        }
      }
    }
    i += width;
  }
  return { letters, sampleLetters, kana, han, ascii, sampleEnd };
}

/** Unicode letters in the trimmed text: spaces, digits and punctuation do not count. Exact. */
export function countLetters(text: string): number {
  return scan(text, false).letters;
}

const ENGLISH_WORDS = new Set(["the", "and", "of", "to", "in", "is", "that", "it", "was", "for", "with", "as", "on"]);

/**
 * True when the lower-cased text has more than 10% common English words among its words. A word is
 * a run of a-z and apostrophes, the same tokens the regex /[a-z']+/g produced.
 */
function hasCommonEnglish(lower: string): boolean {
  let words = 0;
  let common = 0;
  let start = -1;
  for (let i = 0; i <= lower.length; i++) {
    // eslint-disable-next-line unicorn/prefer-code-point -- ASCII word characters are single code units
    const c = i < lower.length ? lower.charCodeAt(i) : 0;
    const wordChar = (c >= 0x61 && c <= 0x7a) || c === 0x27;
    if (wordChar) {
      if (start < 0) {
        start = i;
      }
      continue;
    }
    if (start >= 0) {
      words++;
      const len = i - start;
      if (len >= 2 && len <= 4 && ENGLISH_WORDS.has(lower.slice(start, i))) {
        common++;
      }
      start = -1;
    }
  }
  return words > 0 && common / words > 0.1;
}

/**
 * Best-effort source language for the four document directions. Returns undefined when the text is
 * not clearly Chinese, Japanese or English; Latin-script text counts as English only when it is
 * plain ASCII and full of common English words, so French or German is not taken for English.
 * Decided from the first SAMPLE_LETTERS letters only.
 */
export function detectSource(text: string): "zh" | "ja" | "en" | undefined {
  const s = scan(text, true);
  const sample = s.sampleLetters;
  if (sample === 0) {
    return undefined;
  }
  if (s.kana / sample > 0.05) {
    return "ja";
  }
  if (s.han / sample > 0.3) {
    return "zh";
  }
  if (s.ascii / sample < 0.98) {
    return undefined;
  }
  return hasCommonEnglish(text.slice(0, s.sampleEnd).toLowerCase()) ? "en" : undefined;
}

export function selectModel(input: SelectionInput): Selection {
  const text = input.text.trim();
  const letters = countLetters(text);
  const target = input.targetLang.trim().toLowerCase();
  const source = input.sourceLang.trim().toLowerCase();
  const explicit = source !== "auto";
  const sourceLang = explicit ? source : detectSource(text);
  const supported = sourceLang !== undefined && DOCUMENT_DIRECTIONS.includes(`${sourceLang}-${target}`);
  const make = (model: ModelId, reason: Reason, warn: boolean): Selection => ({
    model,
    reason,
    letters,
    // Only the document model needs the source spelled out; the chat model detects it itself.
    sourceLang: explicit ? sourceLang : model === DOCUMENT_MODEL ? sourceLang : undefined,
    warn,
  });

  if (input.choice === CHAT_MODEL) {
    return make(CHAT_MODEL, "manual", letters > LONG_THRESHOLD_LETTERS);
  }
  if (input.choice === DOCUMENT_MODEL) {
    const usable = supported && !input.hasOptions;
    return make(DOCUMENT_MODEL, usable ? "manual" : "manual-document-unusable", !usable);
  }

  if (letters <= LONG_THRESHOLD_LETTERS) {
    return make(CHAT_MODEL, "short", false);
  }
  if (input.hasOptions) {
    return make(CHAT_MODEL, "long-options", true);
  }
  if (sourceLang === undefined) {
    return make(CHAT_MODEL, "long-unknown-source", true);
  }
  if (!supported) {
    return make(CHAT_MODEL, "long-unsupported-direction", true);
  }
  return make(DOCUMENT_MODEL, "long-document", false);
}
