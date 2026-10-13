// Sentences the page shows about model selection, engine status and finished translations.
// Pure: no DOM access, so each branch can be unit tested.

import { mismatchMessage, paragraphMismatch } from "./paragraphs.ts";
import { CHAT_MODEL, DOCUMENT_MODEL, LONG_THRESHOLD_LETTERS, type ModelId, type Selection } from "./select-model.ts";

export const MODEL_LABELS: Record<ModelId, string> = {
  [CHAT_MODEL]: "Index-Translate-9B",
  [DOCUMENT_MODEL]: "Index-NativeLong-9B",
};

const number = new Intl.NumberFormat();

export function modelLabel(id: string): string {
  return MODEL_LABELS[id as ModelId] ?? id;
}

export function selectionMessage(s: Selection): { text: string; warn: boolean } {
  const name = MODEL_LABELS[s.model];
  const limit = number.format(LONG_THRESHOLD_LETTERS);
  const long = s.letters > LONG_THRESHOLD_LETTERS;
  switch (s.reason) {
    case "short":
      return {
        text: `Model: ${name}. The text is within ${limit} letters, which it translates reliably.`,
        warn: false,
      };
    case "long-document":
      return {
        text: `Model: ${name}. The text is over ${limit} letters, so the whole-document model is used. The first request after a switch takes a few seconds longer.`,
        warn: false,
      };
    case "long-unsupported-direction":
      return {
        text: `Warning: the text is over ${limit} letters, but Index-NativeLong-9B only translates Chinese to or from English or Japanese. Index-Translate-9B will be used and may drop or repeat paragraphs. Translate the text in parts to be safe.`,
        warn: true,
      };
    case "long-unknown-source":
      return {
        text: `Warning: the text is over ${limit} letters and its language could not be determined. Choose the source language under "From" to allow the whole-document model. Index-Translate-9B will be used and may drop or repeat paragraphs.`,
        warn: true,
      };
    case "long-options":
      return {
        text: `Warning: the text is over ${limit} letters, but a glossary, constraints or genre need Index-Translate-9B, which may drop or repeat paragraphs. Clear them to allow the whole-document model.`,
        warn: true,
      };
    case "manual":
      return long && s.model === CHAT_MODEL
        ? {
            text: `Warning: you chose ${name} for a text over ${limit} letters. It may drop or repeat paragraphs.`,
            warn: true,
          }
        : { text: `Model: ${name}, as you chose.`, warn: false };
    case "manual-document-unusable":
      return {
        text: `Warning: Index-NativeLong-9B cannot translate this. It needs a source language, a direction of Chinese to or from English or Japanese, and no glossary, constraints or genre.`,
        warn: true,
      };
  }
}

/** An explicit source equal to the target. "auto" is not compared: it may detect another language. */
export function sameLanguage(from: string, to: string): boolean {
  return from !== "" && from !== "auto" && from === to;
}

export const SAME_LANGUAGE_WARNING =
  "Warning: the source and target languages are the same, so the translation may only repeat the text. Check the From and To choices.";

/**
 * What the page says about the current inputs: only the warnings (a model that will struggle with
 * the text, equal languages, a short language list). The model in use is named in the status line.
 */
export function adviceMessage(s: Selection, from: string, to: string, languageNote: string): string {
  const parts: string[] = [];
  const { text, warn } = selectionMessage(s);
  if (warn) parts.push(text);
  if (sameLanguage(from, to)) parts.push(SAME_LANGUAGE_WARNING);
  if (languageNote) parts.push(languageNote);
  return parts.join(" ");
}

/**
 * The same for an image in place of the text. Only Index-Translate-9B reads images, so it is used
 * whatever was chosen; `documentChosen` says that the other model was.
 */
export function imageAdviceMessage(documentChosen: boolean, from: string, to: string, languageNote: string): string {
  const parts: string[] = [];
  if (documentChosen) {
    parts.push(
      `Warning: ${MODEL_LABELS[DOCUMENT_MODEL]} does not translate images. ${MODEL_LABELS[CHAT_MODEL]} will be used.`,
    );
  }
  if (sameLanguage(from, to)) parts.push(SAME_LANGUAGE_WARNING);
  if (languageNote) parts.push(languageNote);
  return parts.join(" ");
}

export interface Health {
  status: string;
  error?: string;
  model: string | null;
  queue: { running: boolean; waiting: number };
}

/** The engine status sentence, and whether a model load is in progress (which the page keeps polling). */
export function healthMessage(h: Health): { text: string; loading: boolean } {
  const model = h.model ? modelLabel(h.model) : null;
  if (h.status === "ready") {
    let text = `Engine ready${model ? `, ${model} loaded` : ""}.`;
    if (h.queue.waiting > 0) text += ` ${h.queue.waiting} waiting in the queue.`;
    return { text, loading: false };
  }
  if (h.status === "loading") return { text: "Engine loading a model…", loading: true };
  return { text: `Engine ${h.status}${h.error ? `: ${h.error}` : ""}.`, loading: false };
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export interface Done {
  finish_reason: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  timings: { queue_ms: number; generation_ms: number };
}

export interface ResultContext {
  /** `null` for an image: there is no source text to compare the translation with. */
  source: string | null;
  translation: string;
  model: ModelId;
  sourceLang: string | undefined;
  targetLang: string;
}

/** Warnings to show after a finished translation. */
export function resultNotes(done: Pick<Done, "finish_reason">, ctx: ResultContext): string[] {
  const notes: string[] = [];
  if (done.finish_reason === "length") {
    notes.push("The translation was cut off because it reached the output limit. It is incomplete.");
  }
  const mismatch = ctx.source === null ? null : paragraphMismatch(ctx.source, ctx.translation);
  if (mismatch) notes.push(mismatchMessage(mismatch));
  if (ctx.model === DOCUMENT_MODEL && ctx.sourceLang === "zh" && ctx.targetLang === "en") {
    notes.push(
      "Long Chinese-to-English output can silently lose content. Check that every part of the source is present.",
    );
  }
  return notes;
}

export function metaLine(model: ModelId, done: Done): string {
  return `${MODEL_LABELS[model]} · ${number.format(done.usage.prompt_tokens)} prompt tokens · ${number.format(done.usage.completion_tokens)} generated · ${seconds(done.timings.generation_ms + done.timings.queue_ms)}`;
}

export const STOPPED_NOTE = "You stopped the translation. The text above is incomplete.";
export const INTERRUPTED_NOTE =
  "The translation is incomplete because an error interrupted it. The text above is partial.";

/** What the page keeps on screen when a translation ends early, by a stop or by an error. */
export function interruption(translation: string, stopped: boolean): { note: string | null; showCopy: boolean } {
  if (!translation) return { note: null, showCopy: false };
  return { note: stopped ? STOPPED_NOTE : INTERRUPTED_NOTE, showCopy: true };
}
