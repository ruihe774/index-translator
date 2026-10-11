// The web app: one page, talking to the REST/SSE API of the same server.
// Everything with logic that can be tested without a DOM lives in the sibling modules; this file
// reads the form, calls the API and writes the results to the page.

import { CHAT_MODEL, DOCUMENT_MODEL, selectModel, type Choice, type Selection } from "./select-model.js";
import { describeError, type ApiErrorBody } from "./errors.js";
import { sseEvents } from "./sse.js";
import { buildRequest, glossaryMessage, hasOptions as formHasOptions } from "./request.js";
import { looksLikeMarkdown } from "./markdown.js";
import { createOutput, type OutputView } from "./markdown-dom.js";
import {
  doneMessage,
  healthMessage,
  interruption,
  metaLine,
  modelLabel,
  resultNotes,
  selectionMessage,
  selectionStatus,
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
    choice: modelChoice(),
  });
}

/** Set when /languages could not be loaded and the built-in short list is offered instead. */
let languageNote = "";

function refreshSelection() {
  const s = currentSelection();
  setText(countEl, `${number.format(s.letters)} letters`);
  const { text, warn } = selectionStatus(s, fromSelect.value, toSelect.value, languageNote);
  setText(selectionEl, text);
  selectionEl.classList.toggle("warn", warn);
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

function setRunning(on: boolean) {
  setTranslateEnabled();
  stopBtn.hidden = !on;
  if (on) stopBtn.focus();
}

/** Markdown is rendered when the source looks written in it; the copied text stays the raw output. */
function clearResult(markdown: boolean) {
  translation = "";
  output = createOutput(outputEl, markdown);
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

/** Output already on screen when a translation ends early is kept, but it must not look finished. */
function showInterruption(stopped: boolean) {
  const { note, showCopy } = interruption(translation, stopped);
  copyBtn.hidden = !showCopy;
  if (note) addNote(note);
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
  clearResult(looksLikeMarkdown(text));
  outputEl.lang = toSelect.value;
  setRunning(true);
  setText(progressEl, `Translating with ${modelLabel(sel.model)}…`);

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
        setText(progressEl, `Waiting in the queue, position ${data.position}…`);
      } else if (event === "start") {
        setText(progressEl, `Translating with ${modelLabel(data.model)}…`);
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
    setText(metaEl, metaLine(sel.model, done));
    copyBtn.hidden = translation.length === 0;
    setText(progressEl, doneMessage(notes));
  } catch (e) {
    if (stopped) {
      showInterruption(true);
      setText(progressEl, "Stopped.");
    } else {
      const message =
        e instanceof ApiFailure
          ? describeError(e.body, e.status)
          : e instanceof TypeError
            ? "The server cannot be reached."
            : e instanceof Error
              ? e.message
              : String(e);
      showInterruption(false);
      fail(message);
    }
  } finally {
    output?.finish();
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
