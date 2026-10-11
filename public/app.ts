// The web app: one page, talking to the REST/SSE API of the same server.
// Everything with logic that can be tested without a DOM lives in the sibling modules; this file
// reads the form, calls the API and writes the results to the page.

import { CHAT_MODEL, DOCUMENT_MODEL, selectModel, type Choice, type Selection } from "./select-model.js";
import { describeError, type ApiErrorBody } from "./errors.js";
import { sseEvents } from "./sse.js";
import { buildRequest, glossaryMessage, hasOptions as formHasOptions } from "./request.js";
import { looksLikeMarkdown } from "./markdown.js";
import { createOutput, renderText, type OutputView } from "./markdown-dom.js";
import { alignBlocks, type Alignment } from "./paragraphs.js";
import { syncFrom, textareaPane, viewPane, type Pane } from "./sync-scroll.js";
import {
  adviceMessage,
  healthMessage,
  interruption,
  metaLine,
  modelLabel,
  resultNotes,
  selectionMessage,
  type Done,
  type Health,
} from "./messages.js";

const API = "/api/v1";
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
const adviceEl = $("advice");
const modelSwitch = $("model-switch");
const options = $<HTMLFieldSetElement>("options");
const glossaryInput = $<HTMLTextAreaElement>("glossary");
const glossaryError = $("glossary-error");
const hardInput = $<HTMLTextAreaElement>("hard");
const softInput = $<HTMLTextAreaElement>("soft");
const genreInput = $<HTMLInputElement>("genre");
const translateBtn = $<HTMLButtonElement>("translate");
const stopBtn = $<HTMLButtonElement>("stop");
const copyBtn = $<HTMLButtonElement>("copy");
const clearBtn = $<HTMLButtonElement>("clear");
const sourceSwitch = $("source-switch");
const sourceArea = $("source-area");
const sourceView = $("source-view");
const outputSwitch = $("output-switch");
const outputArea = $("output-area");
const engineEl = $("engine");
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

let metaTimer: ReturnType<typeof setTimeout> | undefined;
let metaShown: { text: string; error: boolean } = { text: "", error: false };

/** The one line under the translation: progress, the result's numbers, a stop or an error. */
function setMeta(text: string, error = false) {
  clearTimeout(metaTimer);
  metaShown = { text, error };
  metaEl.classList.toggle("error", error);
  metaEl.setAttribute("role", error ? "alert" : "status");
  setText(metaEl, text);
}

/** A short message that gives the line back to what it showed before. */
function flashMeta(text: string) {
  const before = metaShown;
  setMeta(text);
  metaTimer = setTimeout(() => setMeta(before.text, before.error), 3000);
}

function showFieldError(error: HTMLElement, input: HTMLElement, message: string | null) {
  error.hidden = message === null;
  error.textContent = message ?? "";
  if (message === null) input.removeAttribute("aria-invalid");
  else input.setAttribute("aria-invalid", "true");
}

const CHOICES: Choice[] = ["auto", CHAT_MODEL, DOCUMENT_MODEL];
let modelChoice: Choice = "auto";

function setModelChoice(choice: Choice) {
  modelChoice = choice;
  for (const b of modelSwitch.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.model === choice));
}

function hasOptions(): boolean {
  return formHasOptions({ glossary: glossaryInput.value, hard: hardInput.value, soft: softInput.value });
}

// ---- model selection display -----------------------------------------------------------------

function currentSelection(): Selection {
  return selectModel({
    text: textInput.value,
    sourceLang: fromSelect.value,
    targetLang: toSelect.value,
    hasOptions: hasOptions(),
    choice: modelChoice,
  });
}

/** Set when /languages could not be loaded and the built-in short list is offered instead. */
let languageNote = "";

function refreshSelection() {
  const s = currentSelection();
  setText(countEl, `${number.format(s.letters)} letters`);
  setText(adviceEl, adviceMessage(s, fromSelect.value, toSelect.value, languageNote));
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
    ({ text, loading } = healthMessage((await res.json()) as Health));
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

class ApiFailure extends Error {
  constructor(
    public body: ApiErrorBody,
    public status: number,
  ) {
    super(body.message ?? `HTTP ${status}`);
  }
}

let running: AbortController | null = null;
let translation = "";
let output: OutputView | null = null;

/** Translate is aria-disabled while a translation runs or before the languages are loaded. */
function setTranslateEnabled() {
  translateBtn.setAttribute("aria-disabled", String(running !== null || !languagesReady));
}

// ---- raw and preview views -------------------------------------------------------------------
//
// After Translate, a source that looks like Markdown is shown rendered in place of the textarea,
// and so is the translation. Each side has its own Raw / Preview switch; Raw on the source side is
// the editable textarea. Clear returns the source to the plain textarea.

type View = "raw" | "preview";

/** Whether the switch is offered (the source looked like Markdown), and the chosen view. */
const views = {
  source: { available: false, view: "preview" as View },
  output: { available: false, view: "preview" as View },
};

function showSwitch(el: HTMLElement, side: keyof typeof views) {
  const { available, view } = views[side];
  el.hidden = !available;
  for (const b of el.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
}

function showSource() {
  const preview = views.source.available && views.source.view === "preview";
  showSwitch(sourceSwitch, "source");
  if (preview) renderText(sourceView, textInput.value, true);
  else sourceView.replaceChildren();
  sourceArea.hidden = !preview;
  textInput.hidden = preview;
  refreshSync();
}

/** Rebuilds the output in the chosen view; text still streaming is appended to the new view. */
function showOutput() {
  showSwitch(outputSwitch, "output");
  output = createOutput(outputEl, views.output.available && views.output.view === "preview");
  if (translation) {
    output.append(translation);
    output.finish();
  }
}

function wireSwitch(el: HTMLElement, side: keyof typeof views, show: () => void) {
  for (const b of el.querySelectorAll<HTMLButtonElement>("button")) {
    b.addEventListener("click", () => {
      const view = b.dataset.view as View;
      if (views[side].view === view) return;
      views[side].view = view;
      show();
    });
  }
}

// ---- click to sync scrolling -----------------------------------------------------------------

/** Set after a finished translation whose blocks match the source's, for that source and output. */
let synced: { source: string; translation: string; alignment: Alignment } | null = null;

function syncActive(): Alignment | null {
  return synced && synced.source === textInput.value && synced.translation === translation ? synced.alignment : null;
}

function refreshSync() {
  const on = syncActive() !== null;
  for (const el of [textInput, sourceArea, outputArea]) el.classList.toggle("synced", on);
}

function sourcePane(): Pane {
  return textInput.hidden ? viewPane(sourceView, sourceArea) : textareaPane(textInput);
}

function onSourceClick(e: MouseEvent) {
  const a = syncActive();
  if (a) syncFrom(e, sourcePane(), a.source, viewPane(outputEl, outputArea), a.output);
}

function onOutputClick(e: MouseEvent) {
  const a = syncActive();
  if (a) syncFrom(e, viewPane(outputEl, outputArea), a.output, sourcePane(), a.source);
}

function setRunning(on: boolean) {
  setTranslateEnabled();
  // Stop takes Clear's place while a translation runs; the two are never shown together.
  stopBtn.hidden = !on;
  clearBtn.hidden = on;
  if (on) stopBtn.focus();
}

/** Markdown is rendered when the source looks written in it; the copied text stays the raw output. */
function clearResult(markdown: boolean) {
  translation = "";
  synced = null;
  views.output = { available: markdown, view: "preview" };
  showOutput();
  setMeta("");
  notesEl.replaceChildren();
  copyBtn.hidden = true;
  placeholderEl.hidden = true;
}

function addNote(text: string) {
  const li = document.createElement("li");
  li.textContent = text;
  notesEl.append(li);
}

/** Output already on screen when a translation ends early is kept, but it must not look finished. */
function showInterruption(stopped: boolean, message = "") {
  const { note, showCopy } = interruption(translation, stopped);
  copyBtn.hidden = !showCopy;
  setMeta([message, note ?? (stopped ? "Stopped." : "")].filter(Boolean).join(" "), !stopped);
}

function fail(message: string) {
  setMeta(message, true);
}

async function translate() {
  if (running) return;
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

  const built = buildRequest(sel.model, sel.sourceLang, {
    text,
    targetLang: toSelect.value,
    glossary: glossaryInput.value,
    hard: hardInput.value,
    soft: softInput.value,
    genre: genreInput.value,
  });
  if ("glossaryProblem" in built) {
    advancedOpen();
    showFieldError(glossaryError, glossaryInput, glossaryMessage(built.glossaryProblem));
    glossaryInput.focus();
    return;
  }
  showFieldError(glossaryError, glossaryInput, null);

  store("from", fromSelect.value);
  store("to", toSelect.value);

  const controller = new AbortController();
  running = controller;
  const markdown = looksLikeMarkdown(text);
  clearResult(markdown);
  views.source = { available: markdown, view: "preview" };
  showSource();
  outputEl.lang = toSelect.value;
  setRunning(true);
  setMeta(`Translating with ${modelLabel(sel.model)}…`);

  let stopped = false;
  stopBtn.onclick = () => {
    stopped = true;
    controller.abort();
  };

  try {
    const res = await fetch(`${API}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(built.body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const payload = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
      throw new ApiFailure(payload?.error ?? {}, res.status);
    }

    let done: Done | null = null;
    for await (const { event, data } of sseEvents(res.body)) {
      if (event === "queued") {
        setMeta(`Waiting in the queue, position ${data.position}…`);
      } else if (event === "start") {
        setMeta(`Translating with ${modelLabel(data.model)}…`);
      } else if (event === "delta") {
        translation += data.text;
        output!.append(data.text);
      } else if (event === "done") {
        done = data;
      } else if (event === "error") {
        throw new ApiFailure(data, 0);
      }
    }
    if (!done) throw new Error("the connection closed before the translation finished");

    const notes = resultNotes(done, {
      source: text,
      translation,
      model: sel.model,
      sourceLang: sel.sourceLang,
      targetLang: toSelect.value,
    });
    for (const n of notes) addNote(n);
    const alignment = done.finish_reason === "stop" ? alignBlocks(text, translation) : null;
    if (alignment) synced = { source: text, translation, alignment };
    setMeta(metaLine(sel.model, done));
    copyBtn.hidden = translation.length === 0;
  } catch (e) {
    if (stopped) {
      showInterruption(true);
    } else {
      const message =
        e instanceof ApiFailure
          ? describeError(e.body, e.status)
          : e instanceof TypeError
            ? "The server cannot be reached."
            : e instanceof Error
              ? e.message
              : String(e);
      showInterruption(false, message);
    }
  } finally {
    output?.finish();
    running = null;
    stopBtn.onclick = null;
    const hadFocus = document.activeElement === stopBtn || document.activeElement === document.body;
    setRunning(false);
    if (hadFocus) translateBtn.focus();
    placeholderEl.hidden = translation.length > 0;
    refreshSync();
    void pollHealth();
  }
}

/** Empties the source and the result and returns the source to the plain textarea. */
function clearAll() {
  if (running) return;
  textInput.value = "";
  showFieldError(textError, textInput, null);
  views.source = { available: false, view: "preview" };
  showSource();
  clearResult(false);
  placeholderEl.hidden = false;
  refreshSync();
  refreshSelection();
  textInput.focus();
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
  refreshSync();
  refreshSoon();
});
textInput.addEventListener("click", onSourceClick);
sourceArea.addEventListener("click", onSourceClick);
outputArea.addEventListener("click", onOutputClick);
wireSwitch(sourceSwitch, "source", showSource);
wireSwitch(outputSwitch, "output", () => {
  showOutput();
  refreshSync();
});
clearBtn.addEventListener("click", clearAll);
for (const el of [glossaryInput, hardInput, softInput, genreInput]) el.addEventListener("input", refreshSoon);
fromSelect.addEventListener("change", refreshSelection);
toSelect.addEventListener("change", refreshSelection);
for (const b of modelSwitch.querySelectorAll<HTMLButtonElement>("button")) {
  b.addEventListener("click", () => {
    setModelChoice(b.dataset.model as Choice);
    refreshSelection();
    store("model", modelChoice);
  });
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(translation);
    flashMeta("Translation copied to the clipboard.");
  } catch {
    flashMeta("Copying failed. Select the translation and copy it by hand.");
  }
});

const savedModel = stored("model");
if (CHOICES.includes(savedModel as Choice)) setModelChoice(savedModel as Choice);

setTranslateEnabled();
void loadLanguages();
void pollHealth();
document.addEventListener("visibilitychange", () => void pollHealth());
