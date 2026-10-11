// The web app: one page, talking to the REST/SSE API of the same server.

import {
  CHAT_MODEL,
  DOCUMENT_MODEL,
  LONG_THRESHOLD_LETTERS,
  selectModel,
  type Choice,
  type ModelId,
  type Selection,
} from "./select-model.js";
import { parseGlossary } from "./glossary.js";

const API = "/api/v1";
const MODEL_LABELS: Record<ModelId, string> = {
  [CHAT_MODEL]: "Index-Translate-9B",
  [DOCUMENT_MODEL]: "Index-NativeLong-9B",
};
const HEALTH_LOADING_POLL_MS = 2000;
let healthTimer: ReturnType<typeof setTimeout> | undefined;
const number = new Intl.NumberFormat();

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const form = $<HTMLFormElement>("form");
const fromSelect = $<HTMLSelectElement>("from");
const toSelect = $<HTMLSelectElement>("to");
const textInput = $<HTMLTextAreaElement>("text");
const countEl = $("count");
const textError = $("text-error");
const selectionEl = $("selection");
const options = $<HTMLFieldSetElement>("options");
const glossaryInput = $<HTMLTextAreaElement>("glossary");
const glossaryError = $("glossary-error");
const hardInput = $<HTMLTextAreaElement>("hard");
const softInput = $<HTMLTextAreaElement>("soft");
const genreInput = $<HTMLInputElement>("genre");
const translateBtn = $<HTMLButtonElement>("translate");
const stopBtn = $<HTMLButtonElement>("stop");
const copyBtn = $<HTMLButtonElement>("copy");
const engineEl = $("engine");
const progressEl = $("progress");
const errorEl = $("error");
const outputEl = $("output");
const placeholderEl = $("placeholder");
const metaEl = $("meta");
const notesEl = $("notes");

// ---- small helpers ---------------------------------------------------------------------------

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage is only a convenience
  }
}

function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

function showFieldError(error: HTMLElement, input: HTMLElement, message: string | null) {
  error.hidden = message === null;
  error.textContent = message ?? "";
  if (message === null) input.removeAttribute("aria-invalid");
  else input.setAttribute("aria-invalid", "true");
}

function modelChoice(): Choice {
  return (form.elements.namedItem("model") as RadioNodeList).value as Choice;
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Glossary, hard or soft constraints need the chat model. Genre does not count here: the backend
 * (src/prompt.ts buildPrompt) only uses genre inside the constraint prompt, so with no glossary or
 * constraints it is ignored, and the document model rejects it (src/app.ts checkDocumentRequest).
 */
function hasOptions(): boolean {
  return Boolean(glossaryInput.value.trim() || hardInput.value.trim() || softInput.value.trim());
}

// ---- model selection display -----------------------------------------------------------------

function currentSelection(): Selection {
  return selectModel({
    text: textInput.value,
    sourceLang: fromSelect.value,
    targetLang: toSelect.value,
    hasOptions: hasOptions(),
    choice: modelChoice(),
  });
}

function selectionMessage(s: Selection): { text: string; warn: boolean } {
  const name = MODEL_LABELS[s.model];
  const limit = number.format(LONG_THRESHOLD_LETTERS);
  const long = s.letters > LONG_THRESHOLD_LETTERS;
  switch (s.reason) {
    case "short":
      return { text: `Model: ${name}. The text is within ${limit} letters, which it translates reliably.`, warn: false };
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
function sameLanguage(): boolean {
  const from = fromSelect.value;
  return from !== "" && from !== "auto" && from === toSelect.value;
}

/** Set when /languages could not be loaded and the built-in short list is offered instead. */
let languageNote = "";

function refreshSelection() {
  const s = currentSelection();
  setText(countEl, `${number.format(s.letters)} letters`);
  const { text, warn } = selectionMessage(s);
  const same = sameLanguage();
  const parts = [text];
  if (same) {
    parts.push("Warning: the source and target languages are the same, so the translation may only repeat the text. Check the From and To choices.");
  }
  if (languageNote) parts.push(languageNote);
  setText(selectionEl, parts.join(" "));
  selectionEl.classList.toggle("warn", warn || same);
  const documentModel = s.model === DOCUMENT_MODEL && s.reason !== "manual-document-unusable";
  options.disabled = documentModel;
  return s;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshSelection, 150);
}

// ---- languages and engine status -------------------------------------------------------------

interface Language {
  code: string;
  name: string;
}

/** False until the selects hold the language options; Translate stays aria-disabled until then. */
let languagesReady = false;

async function loadLanguages() {
  let languages: Language[] = [];
  try {
    const res = await fetch(`${API}/languages`);
    const body = (await res.json()) as { languages?: unknown };
    if (!Array.isArray(body.languages)) throw new Error("no language list");
    languages = body.languages as Language[];
  } catch {
    languages = [
      { code: "en", name: "English" },
      { code: "zh", name: "Chinese" },
      { code: "ja", name: "Japanese" },
    ];
    languageNote = "Could not load the full language list, so only English, Chinese and Japanese are offered.";
  }
  const add = (select: HTMLSelectElement, code: string, name: string) => {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = name;
    select.append(o);
  };
  add(fromSelect, "auto", "Detect language");
  for (const l of languages) {
    add(fromSelect, l.code, l.name);
    add(toSelect, l.code, l.name);
  }
  const has = (select: HTMLSelectElement, v: string | null) => v !== null && [...select.options].some((o) => o.value === v);
  const savedFrom = stored("from");
  const savedTo = stored("to");
  fromSelect.value = has(fromSelect, savedFrom) ? savedFrom! : "auto";
  const fallbackTo = navigator.language.toLowerCase().startsWith("en") ? "zh" : "en";
  toSelect.value = has(toSelect, savedTo) ? savedTo! : has(toSelect, fallbackTo) ? fallbackTo : toSelect.options[0]!.value;
  languagesReady = true;
  setTranslateEnabled();
  refreshSelection();
}

/** Counts up for each poll; a response from an earlier poll is stale and must not overwrite a newer one. */
let healthSeq = 0;

async function pollHealth() {
  // One chain at a time: any pending follow-up poll is replaced by this one.
  clearTimeout(healthTimer);
  healthTimer = undefined;
  const seq = ++healthSeq;
  if (document.hidden) return;
  let text: string;
  let loading = false;
  try {
    const res = await fetch(`${API}/health`);
    const h = (await res.json()) as {
      status: string;
      error?: string;
      model: string | null;
      queue: { running: boolean; waiting: number };
    };
    const model = h.model ? MODEL_LABELS[h.model as ModelId] ?? h.model : null;
    if (h.status === "ready") {
      text = `Engine ready${model ? `, ${model} loaded` : ""}.`;
      if (h.queue.waiting > 0) text += ` ${h.queue.waiting} waiting in the queue.`;
    } else if (h.status === "loading") {
      text = "Engine loading a model…";
      loading = true;
    } else text = `Engine ${h.status}${h.error ? `: ${h.error}` : ""}.`;
  } catch {
    text = "The server cannot be reached.";
  }
  if (seq !== healthSeq) return;
  // Only a load in progress is followed automatically; otherwise the status is refreshed on
  // page load, on return to the tab and after each translation, so nothing updates by itself.
  if (loading) healthTimer = setTimeout(pollHealth, HEALTH_LOADING_POLL_MS);
  setText(engineEl, text);
}

// ---- translating -----------------------------------------------------------------------------

interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

class ApiFailure extends Error {
  constructor(
    public body: ApiErrorBody,
    public status: number,
  ) {
    super(body.message ?? `HTTP ${status}`);
  }
}

function describeError(e: ApiErrorBody | undefined, status?: number): string {
  const d = e?.details ?? {};
  switch (e?.code) {
    case "input_too_long":
      return d.prompt_tokens && d.max_input_tokens
        ? `The text is too long for one translation: ${number.format(Number(d.prompt_tokens))} tokens, and the limit is ${number.format(Number(d.max_input_tokens))}. Shorten it or translate it in parts.`
        : "The text is too long for one translation. Shorten it or translate it in parts.";
    case "queue_full":
      return "The translator is busy and its queue is full. Try again in a minute.";
    case "engine_unavailable":
      return "The translation engine is loading or switching models. Try again in a moment.";
    case "body_too_large":
      return "The request is too large to send.";
    default:
      if (e?.message) return e.message;
      return status ? `The server answered with an error (HTTP ${status}).` : "Something went wrong.";
  }
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: any }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: JSON.parse(data.join("\n")) };
    }
  }
}

function paragraphs(text: string): number {
  return text.split(/\n\s*\n/).filter((p) => p.trim()).length;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

let running: AbortController | null = null;
let translation = "";
let outputText: Text | null = null;

/** Translate is aria-disabled while a translation runs or before the languages are loaded. */
function setTranslateEnabled() {
  translateBtn.setAttribute("aria-disabled", String(running !== null || !languagesReady));
}

function setRunning(on: boolean) {
  setTranslateEnabled();
  stopBtn.hidden = !on;
  if (on) stopBtn.focus();
}

function clearResult() {
  translation = "";
  outputText = document.createTextNode("");
  outputEl.replaceChildren(outputText);
  setText(metaEl, "");
  notesEl.replaceChildren();
  copyBtn.hidden = true;
  placeholderEl.hidden = true;
}

function addNote(text: string) {
  const li = document.createElement("li");
  li.textContent = text;
  notesEl.append(li);
}

function fail(message: string) {
  setText(progressEl, "");
  setText(errorEl, message);
}

async function translate() {
  if (running) return;
  setText(errorEl, "");
  if (!languagesReady) {
    fail("The languages are still loading. Try again in a moment.");
    return;
  }

  const text = textInput.value;
  if (!text.trim()) {
    showFieldError(textError, textInput, "Enter some text to translate.");
    textInput.focus();
    return;
  }
  showFieldError(textError, textInput, null);

  const sel = refreshSelection();
  if (sel.reason === "manual-document-unusable") {
    fail(selectionMessage(sel).text);
    return;
  }

  const body: Record<string, unknown> = {
    model: sel.model,
    text,
    target_lang: toSelect.value,
    stream: true,
  };
  if (sel.sourceLang) body.source_lang = sel.sourceLang;
  if (sel.model === CHAT_MODEL) {
    const { glossary, error } = parseGlossary(glossaryInput.value);
    if (error) {
      advancedOpen();
      const message =
        error.kind === "duplicate"
          ? `Glossary line ${error.line} repeats the source term "${error.term}". Each source term may appear only once.`
          : `Glossary line ${error.line} must look like: source term = target term.`;
      showFieldError(glossaryError, glossaryInput, message);
      glossaryInput.focus();
      return;
    }
    showFieldError(glossaryError, glossaryInput, null);
    const hasGlossary = Object.keys(glossary).length > 0;
    if (hasGlossary) body.glossary = glossary;
    if (hardInput.value.trim()) body.hard_constraints = lines(hardInput.value);
    if (softInput.value.trim()) body.soft_constraints = lines(softInput.value);
    // Genre is sent only with a glossary or constraints; alone the backend ignores it (see hasOptions).
    if (genreInput.value.trim() && (hasGlossary || body.hard_constraints || body.soft_constraints)) {
      body.genre = genreInput.value.trim();
    }
  }

  store("from", fromSelect.value);
  store("to", toSelect.value);

  const controller = new AbortController();
  running = controller;
  clearResult();
  outputEl.lang = toSelect.value;
  setRunning(true);
  setText(progressEl, `Translating with ${MODEL_LABELS[sel.model]}…`);

  let stopped = false;
  stopBtn.onclick = () => {
    stopped = true;
    controller.abort();
  };

  try {
    const res = await fetch(`${API}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const payload = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
      throw new ApiFailure(payload?.error ?? {}, res.status);
    }

    let done: { finish_reason: string; usage: { prompt_tokens: number; completion_tokens: number }; timings: { queue_ms: number; generation_ms: number } } | null = null;
    for await (const { event, data } of sseEvents(res.body)) {
      if (event === "queued") {
        setText(progressEl, `Waiting in the queue, position ${data.position}…`);
      } else if (event === "start") {
        setText(progressEl, `Translating with ${MODEL_LABELS[data.model as ModelId] ?? data.model}…`);
      } else if (event === "delta") {
        translation += data.text;
        outputText!.appendData(data.text);
      } else if (event === "done") {
        done = data;
      } else if (event === "error") {
        throw new ApiFailure(data, 0);
      }
    }
    if (!done) throw new Error("the connection closed before the translation finished");

    const notes: string[] = [];
    if (done.finish_reason === "length") {
      notes.push("The translation was cut off because it reached the output limit. It is incomplete.");
    }
    const sourceParagraphs = paragraphs(text);
    const outParagraphs = paragraphs(translation);
    if (sourceParagraphs >= 3 && sourceParagraphs !== outParagraphs) {
      notes.push(
        `The source has ${sourceParagraphs} paragraphs and the translation has ${outParagraphs}. Parts may have been dropped, merged or repeated; check it against the source.`,
      );
    }
    if (sel.model === DOCUMENT_MODEL && sel.sourceLang === "zh" && toSelect.value === "en") {
      notes.push("Long Chinese-to-English output can silently lose content. Check that every part of the source is present.");
    }
    for (const n of notes) addNote(n);
    setText(
      metaEl,
      `${MODEL_LABELS[sel.model]} · ${number.format(done.usage.prompt_tokens)} prompt tokens · ${number.format(done.usage.completion_tokens)} generated · ${seconds(done.timings.generation_ms + done.timings.queue_ms)}`,
    );
    copyBtn.hidden = translation.length === 0;
    setText(
      progressEl,
      notes.length ? `Done, with ${notes.length === 1 ? "a warning" : `${notes.length} warnings`}: ${notes.join(" ")}` : "Done.",
    );
  } catch (e) {
    if (stopped) {
      copyBtn.hidden = translation.length === 0;
      if (translation) addNote("You stopped the translation. The text above is incomplete.");
      setText(progressEl, "Stopped.");
    } else if (e instanceof ApiFailure) {
      fail(describeError(e.body, e.status));
    } else if (e instanceof TypeError) {
      fail("The server cannot be reached.");
    } else {
      fail(e instanceof Error ? e.message : String(e));
    }
  } finally {
    running = null;
    stopBtn.onclick = null;
    const hadFocus = document.activeElement === stopBtn || document.activeElement === document.body;
    setRunning(false);
    if (hadFocus) translateBtn.focus();
    placeholderEl.hidden = translation.length > 0;
    void pollHealth();
  }
}

function advancedOpen() {
  $<HTMLDetailsElement>("advanced").open = true;
}

// ---- wiring ----------------------------------------------------------------------------------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void translate();
});

textInput.addEventListener("input", () => {
  if (!textError.hidden && textInput.value.trim()) showFieldError(textError, textInput, null);
  refreshSoon();
});
for (const el of [glossaryInput, hardInput, softInput, genreInput]) el.addEventListener("input", refreshSoon);
fromSelect.addEventListener("change", refreshSelection);
toSelect.addEventListener("change", refreshSelection);
for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="model"]')) {
  radio.addEventListener("change", () => {
    refreshSelection();
    store("model", radio.value);
  });
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(translation);
    setText(progressEl, "Translation copied to the clipboard.");
  } catch {
    setText(progressEl, "Copying failed. Select the translation and copy it by hand.");
  }
});

const savedModel = stored("model");
const savedRadio = savedModel && form.querySelector<HTMLInputElement>(`input[name="model"][value="${CSS.escape(savedModel)}"]`);
if (savedRadio) savedRadio.checked = true;

setTranslateEnabled();
void loadLanguages();
void pollHealth();
document.addEventListener("visibilitychange", () => void pollHealth());
