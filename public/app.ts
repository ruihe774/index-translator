// The web app: one page, talking to the REST/SSE API of the same server.
// Everything with logic that can be tested without a DOM lives in the sibling modules; this file
// reads the form, calls the API and writes the results to the page.

import "./elements/index.js";
import type { SpeechControls } from "./elements/speech-controls.js";
import type { ViewSwitch } from "./elements/view-switch.js";
import { type ApiErrorBody, describeError } from "./errors.js";
import { confirmLink } from "./link-dialog.js";
import { type LinkReference, linkReference } from "./links.js";
import { looksLikeMarkdown } from "./markdown.js";
import { checkLinks, createOutput, type OutputView, renderText } from "./markdown-dom.js";
import {
  adviceMessage,
  type Done,
  type Health,
  healthMessage,
  interruption,
  metaLine,
  modelLabel,
  resultNotes,
  selectionMessage,
} from "./messages.js";
import { type Alignment, alignBlocks } from "./paragraphs.js";
import { createRender } from "./render.js";
import { buildRequest, hasOptions as formHasOptions, glossaryMessage } from "./request.js";
import { CHAT_MODEL, type Choice, DOCUMENT_MODEL, detectSource, type Selection, selectModel } from "./select-model.js";
import { SpeechPlayer, type SpeechSettings } from "./speech.js";
import { canSpeak, speechSegments } from "./speech-text.js";
import { sseEvents } from "./sse.js";
import { bindRender, setState, state } from "./state.js";
import { clearLinked, hoveredBlock, markLinked, type Pane, syncFrom, textareaPane, viewPane } from "./sync-scroll.js";
import { audioToWav, MicRecorder, uploadVoice } from "./voice-sample.js";

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
const modelSwitch = $<ViewSwitch>("model-switch");
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
const sourceSwitch = $<ViewSwitch>("source-switch");
const sourceArea = $("source-area");
const sourceView = $("source-view");
const outputSwitch = $<ViewSwitch>("output-switch");
const outputArea = $("output-area");
const engineEl = $("engine");
const outputEl = $("output");
const placeholderEl = $("placeholder");
const metaEl = $("meta");
const notesEl = $("notes");
const speechSettings = $("speech-settings");
const voiceSelect = $<HTMLSelectElement>("voice");
const speedSelect = $<HTMLSelectElement>("speed");
const voiceFile = $<HTMLInputElement>("voice-file");
const voiceFileButton = $("voice-file-button");
const voiceRecord = $("voice-record");
const cloneStatus = $("clone-status");

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
  markScrollable();
}

/** The line scrolls sideways when it is longer than its room; then keyboard users must be able to reach it. */
function markScrollable() {
  if (metaEl.scrollWidth > metaEl.clientWidth) metaEl.tabIndex = 0;
  else metaEl.removeAttribute("tabindex");
}
new ResizeObserver(markScrollable).observe(metaEl);

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
  modelSwitch.value = choice;
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

/** The source text's language: the selected one, else a guess. Unknown leaves `lang` to the page. */
function sourceLangOf(): string | undefined {
  return fromSelect.value === "auto" ? detectSource(textInput.value) : fromSelect.value;
}

/** Sets or clears `lang`, which picks glyph forms and the CJK line-layout rules in style.css. */
function setLang(el: HTMLElement, lang: string | undefined) {
  if (lang) el.lang = lang;
  else el.removeAttribute("lang");
}

function refreshSelection() {
  const s = currentSelection();
  setLang(textInput, sourceLangOf());
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
  const has = (select: HTMLSelectElement, v: string | null) =>
    v !== null && [...select.options].some((o) => o.value === v);
  const savedFrom = stored("from");
  const savedTo = stored("to");
  fromSelect.value = has(fromSelect, savedFrom) ? savedFrom! : "auto";
  const fallbackTo = navigator.language.toLowerCase().startsWith("en") ? "zh" : "en";
  toSelect.value = has(toSelect, savedTo)
    ? savedTo!
    : has(toSelect, fallbackTo)
      ? fallbackTo
      : toSelect.options[0]!.value;
  setState({ languagesReady: true });
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

let output: OutputView | null = null;

// ---- raw and preview views -------------------------------------------------------------------
//
// After Translate, a source that looks like Markdown is shown rendered in place of the textarea,
// and so is the translation. Each side has its own Raw / Preview switch; Raw on the source side is
// the editable textarea. Clear returns the source to the plain textarea.

type View = "raw" | "preview";

/** Whether the text is rendered as Markdown (it looked like it), and the chosen view. */
const views = {
  source: { available: false, view: "raw" as View },
  output: { available: false, view: "preview" as View },
};

function showSwitch(el: ViewSwitch, side: keyof typeof views) {
  el.value = views[side].view;
}

/**
 * Takes the text box into the state, which renders the controls (render.ts). The box is the one
 * input the state does not own, so everything that changes it or the view around it comes here.
 */
function refreshControls() {
  setState({ source: textInput.value });
}

function showSource() {
  const preview = views.source.view === "preview" && textInput.value.length > 0;
  showSwitch(sourceSwitch, "source");
  setLang(sourceView, sourceLangOf());
  if (preview) renderText(sourceView, textInput.value, views.source.available);
  else sourceView.replaceChildren();
  sourceArea.hidden = !preview;
  textInput.hidden = preview;
  refreshControls();
  refreshSync();
  showSpeaking();
}

/** Rebuilds the output in the chosen view; text still streaming is appended to the new view. */
function showOutput() {
  showSwitch(outputSwitch, "output");
  refreshControls();
  output = createOutput(outputEl, views.output.available && views.output.view === "preview");
  if (state.translation) {
    output.append(state.translation);
    output.finish();
    applyLinkCheck();
    showSpeaking();
  }
}

/** Output links open only after the dialog is confirmed; its wording depends on the link check. */
function onOutputLink(e: MouseEvent) {
  const a = (e.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!a || !outputEl.contains(a) || (e.type === "auxclick" && e.button !== 1)) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  void confirmLink(href, a.dataset.linkPaired === "true").then((ok) => {
    if (ok) window.open(a.href, "_blank", "noopener,noreferrer");
  });
}
outputEl.addEventListener("click", onOutputLink);
outputEl.addEventListener("auxclick", onOutputLink);

/** Set when a translation ends: what the output's links are checked against. */
let linkCheck: { translation: string; ref: LinkReference } | null = null;

function applyLinkCheck() {
  if (linkCheck && linkCheck.translation === state.translation && outputEl.classList.contains("markdown")) {
    checkLinks(outputEl, linkCheck.ref);
  }
}

function wireSwitch(el: ViewSwitch, side: keyof typeof views, show: () => void) {
  el.addEventListener("change", () => {
    if (side === "source") views.source.available = looksLikeMarkdown(textInput.value);
    views[side].view = el.value as View;
    show();
  });
}

// ---- click to sync scrolling -----------------------------------------------------------------

/** Set after a finished translation whose blocks match the source's, for that source and output. */
let synced: { source: string; translation: string; alignment: Alignment } | null = null;

function syncActive(): Alignment | null {
  return synced && synced.source === textInput.value && synced.translation === state.translation
    ? synced.alignment
    : null;
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

/** Hovering a block of one rendered pane shades the block it maps to in the other rendered pane. */
function onHover(e: MouseEvent, fromView: HTMLElement, toView: HTMLElement, side: "source" | "output") {
  const a = syncActive();
  const k = a ? hoveredBlock(e, fromView, a[side]) : null;
  if (!a || k === null) clearLinked(toView);
  else markLinked(toView, a[side === "source" ? "output" : "source"], k);
}

sourceArea.addEventListener("mouseover", (e) => onHover(e, sourceView, outputEl, "source"));
outputArea.addEventListener("mouseover", (e) => onHover(e, outputEl, sourceView, "output"));
sourceArea.addEventListener("mouseleave", () => clearLinked(outputEl));
outputArea.addEventListener("mouseleave", () => clearLinked(sourceView));

// ---- follow the stream -----------------------------------------------------------------------

/** While a translation streams, the output stays scrolled to its end until the user scrolls. */
let following = true;
const stopFollowing = () => {
  following = false;
};
for (const type of ["wheel", "touchmove", "pointerdown", "keydown"]) {
  outputArea.addEventListener(type, stopFollowing, { passive: true });
}
// The output element is stretched to the scroller's height, so its size does not change as text
// arrives; the content does.
new MutationObserver(() => {
  if (state.running && following) outputArea.scrollTop = outputArea.scrollHeight;
}).observe(outputEl, { childList: true, subtree: true, characterData: true });

/** Markdown is rendered when the source looks written in it; the copied text stays the raw output. */
function clearResult(markdown: boolean) {
  synced = null;
  linkCheck = null;
  views.output = { available: markdown, view: "preview" };
  setState({ translation: "" });
  showOutput();
  setMeta("");
  notesEl.replaceChildren();
  placeholderEl.hidden = true;
}

function addNote(text: string) {
  const li = document.createElement("li");
  li.textContent = text;
  notesEl.append(li);
}

/** Output already on screen when a translation ends early is kept, but it must not look finished. */
function showInterruption(stopped: boolean, message = "") {
  const { note } = interruption(state.translation, stopped);
  setMeta([message, note ?? (stopped ? "Stopped." : "")].filter(Boolean).join(" "), !stopped);
}

function fail(message: string) {
  setMeta(message, true);
}

/** A failed request as a sentence for the user. */
function failureMessage(e: unknown): string {
  if (e instanceof ApiFailure) return describeError(e.body, e.status);
  if (e instanceof TypeError) return "The server cannot be reached.";
  return e instanceof Error ? e.message : String(e);
}

async function translate() {
  if (state.running) return;
  if (!state.languagesReady) {
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

  stopSpeech();
  const controller = new AbortController();
  setState({ running: controller });
  following = true;
  const markdown = looksLikeMarkdown(text);
  clearResult(markdown);
  views.source = { available: markdown, view: markdown ? "preview" : "raw" };
  showSource();
  outputEl.lang = toSelect.value;
  stopBtn.focus();
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
        // Only the first token changes what the controls show; the rest just grows the copied text.
        if (state.translation.length === 0) setState({ translation: data.text });
        else state.translation += data.text;
        output!.append(data.text);
      } else if (event === "done") {
        done = data;
      } else if (event === "error") {
        throw new ApiFailure(data, 0);
      }
    }
    if (!done) throw new Error("the connection closed before the translation finished");

    const translation = state.translation;
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
    if (markdown) linkCheck = { translation, ref: linkReference(text, alignBlocks(text, translation)) };
  } catch (e) {
    if (stopped) {
      showInterruption(true);
    } else {
      showInterruption(false, failureMessage(e));
    }
  } finally {
    output?.finish();
    // After the last render, which rebuilds the open tail and would drop the marks.
    applyLinkCheck();
    stopBtn.onclick = null;
    // Taken before the state changes: Stop is hidden then, and a hidden button loses focus.
    const hadFocus = document.activeElement === stopBtn || document.activeElement === document.body;
    setState({ running: null });
    if (hadFocus) translateBtn.focus();
    placeholderEl.hidden = state.translation.length > 0;
    refreshSync();
    void pollHealth();
  }
}

/** Empties the source and the result and returns the source to the plain textarea. */
function clearAll() {
  if (state.running || clearBtn.getAttribute("aria-disabled") === "true") return;
  stopSpeech();
  textInput.value = "";
  showFieldError(textError, textInput, null);
  views.source = { available: false, view: "raw" };
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

// ---- reading aloud ---------------------------------------------------------------------------
//
// Each side has a Listen button; one side is read at a time. What is spoken comes from
// `speechSegments`: the parsed Markdown when the text is shown rendered, never its raw markers.
// The block being read is shaded in the rendered view. Voice and speed are shared by both sides.

type Side = "source" | "output";
const SIDES: Side[] = ["source", "output"];
const SIDE_NAME: Record<Side, string> = { source: "source text", output: "translation" };

const speechControls: Record<Side, SpeechControls> = {
  source: $<SpeechControls>("speech-source"),
  output: $<SpeechControls>("speech-output"),
};

/** Why nothing can be read aloud at all (not installed, no voices); empty when it can. */
let speechProblem = "Checking whether reading aloud is available…";
/** The side being read and the first line of the block being spoken. */
let speaking: { side: Side; line: number | null } | null = null;

async function synthesize(text: string, settings: SpeechSettings, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(`${API}/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, lang: settings.lang, voice: settings.voice || undefined, speed: settings.speed }),
    signal,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
    throw new ApiFailure(payload?.error ?? {}, res.status);
  }
  return res.arrayBuffer();
}

const player = new SpeechPlayer(synthesize, {
  onState(state) {
    if (state === "idle") speaking = null;
    refreshSpeech();
  },
  onSegment(segment) {
    if (speaking) speaking.line = segment?.line ?? null;
    showSpeaking(true);
    refreshSpeech();
  },
  onError(e) {
    flashMeta(failureMessage(e));
    voicesStale = true;
  },
});

function speechTarget(side: Side): { text: string; lang: string | undefined } {
  return side === "source"
    ? { text: textInput.value, lang: sourceLangOf() }
    : { text: state.translation, lang: outputEl.lang || undefined };
}

/** Why this side cannot be read aloud right now; empty when it can. */
function speechBlocked(side: Side): string {
  if (speechProblem) return speechProblem;
  const { text, lang } = speechTarget(side);
  if (!text.trim()) return `There is no ${SIDE_NAME[side]} to read aloud yet.`;
  if (side === "output" && state.running) return "The translation can be read aloud once it is finished.";
  if (!lang) return "Choose the language under From to have this text read aloud.";
  if (!canSpeak(lang)) return "Reading aloud is available for Chinese, English, Japanese, Spanish and Arabic.";
  return "";
}

function refreshSpeech() {
  for (const side of SIDES) {
    const mine = speaking?.side === side;
    speechControls[side].show({
      reading: mine,
      state: mine ? player.state : "idle",
      blocked: mine ? "" : speechBlocked(side),
      canPrev: mine && player.canJump(-1),
      canNext: mine && player.canJump(1),
    });
  }
}

/** Shades the block being read in the rendered view, and scrolls its pane to it when asked. */
function showSpeaking(scroll = false) {
  for (const el of document.querySelectorAll(".speaking")) {
    el.classList.remove("speaking");
    el.removeAttribute("aria-current");
  }
  if (!speaking || speaking.line === null) return;
  const [view, area] = speaking.side === "source" ? [sourceView, sourceArea] : [outputEl, outputArea];
  const block = view.querySelector<HTMLElement>(`:scope > [data-line="${speaking.line}"]`);
  if (!block) return;
  block.classList.add("speaking");
  block.setAttribute("aria-current", "true");
  if (!scroll) return;
  const pane = area.getBoundingClientRect();
  const box = block.getBoundingClientRect();
  if (box.top < pane.top || box.bottom > pane.bottom) area.scrollTop += box.top - pane.top - 8;
}

function toggleSpeech(side: Side) {
  if (speaking?.side === side) {
    player.stop();
    return;
  }
  const blocked = speechBlocked(side);
  if (blocked) {
    flashMeta(blocked);
    // Reading aloud may have become available since the page loaded.
    if (speechProblem) void recheckVoicesNow(true);
    return;
  }
  // After a failure the voice list may be out of date; the reading goes on with what is selected.
  if (voicesStale) void loadVoices();
  const { text, lang } = speechTarget(side);
  // Read as it is shown: rendered Markdown when the text looks like Markdown, else line by line.
  const markdown = side === "source" ? looksLikeMarkdown(text) : views.output.available;
  const segments = speechSegments(text, markdown, lang!);
  if (segments.length === 0) {
    flashMeta("There is nothing to read aloud in this text.");
    return;
  }
  player.stop();
  speaking = { side, line: null };
  player.start(segments, { lang: lang!, voice: voiceSelect.value, speed: Number(speedSelect.value) });
}

/** Jumps a block back or forward and says where that is, since the shaded block may be out of view. */
function jumpSpeech(direction: -1 | 1) {
  if (!player.jump(direction)) return;
  const at = player.position();
  if (at) flashMeta(`Block ${at.block} of ${at.blocks}`);
  refreshSpeech();
}

function stopSpeech(side?: Side) {
  if (speaking && (side === undefined || speaking.side === side)) player.stop();
}

/** A reading failed: the voice list or the engine may have changed, so look again at the next chance. */
let voicesStale = false;
let voicesCheck: Promise<void> | null = null;
let voicesCheckedAt = 0;
/** Events (focus, visibility) can come in bursts; a passive re-check is at most this often. */
const VOICES_RECHECK_MS = 3000;

/**
 * Asks the server for the voices and brings the Listen buttons and the voice list in line with the
 * answer, every time: speech may have been installed, or a voice added or lost, since the last look.
 */
function loadVoices(): Promise<void> {
  voicesCheck ??= (async () => {
    try {
      const res = await fetch(`${API}/voices`);
      const body = (await res.json()) as { status: string; error?: string; voices: { id: string; name: string }[] };
      if (body.status === "unavailable") {
        speechProblem = `Reading aloud is not available: ${body.error ?? "it is not installed"}.`;
      } else {
        if (body.voices.length === 0) {
          speechProblem = "Reading aloud needs a voice: upload or record a sample under Model and options.";
        } else speechProblem = "";
        const before = voiceSelect.value;
        const wanted = [before, stored("voice")].find((id) => body.voices.some((v) => v.id === id));
        voiceSelect.replaceChildren(...body.voices.map((v) => new Option(v.name, v.id)));
        if (wanted) voiceSelect.value = wanted;
        // The voice being read with is gone: the next piece uses the one now selected.
        if (voiceSelect.value !== before && voiceSelect.value) player.update({ voice: voiceSelect.value });
        speechSettings.hidden = false;
      }
      voicesStale = false;
    } catch {
      speechProblem = "Reading aloud is not available: the server cannot be reached.";
    }
    voicesCheckedAt = Date.now();
    refreshSpeech();
  })().finally(() => {
    voicesCheck = null;
  });
  return voicesCheck;
}

/** On focus or visibility: look again only when reading aloud is not working, and not in a burst. */
function recheckVoices() {
  if (!speechProblem && !voicesStale) return;
  if (Date.now() - voicesCheckedAt < VOICES_RECHECK_MS) return;
  void loadVoices();
}

/** The person tried to use reading aloud while it was blocked or after it failed: look again now. */
async function recheckVoicesNow(announce: boolean) {
  const had = speechProblem;
  await loadVoices();
  if (announce && had && !speechProblem) flashMeta("Reading aloud is available now. Press Listen to start.");
}

/** Adds an uploaded voice to the list, selects it and tells the player. */
async function addSampleVoice(name: string, audio: ArrayBuffer) {
  // The server may first take the voice out of music and noise, which takes a few seconds.
  cloneStatus.textContent = "Processing the sample…";
  try {
    const voice = await uploadVoice(API, name, await audioToWav(audio));
    voiceSelect.append(new Option(voice.name, voice.id));
    voiceSelect.value = voice.id;
    store("voice", voice.id);
    player.update({ voice: voice.id });
    speechProblem = "";
    refreshSpeech();
    cloneStatus.textContent = `Voice "${voice.name}" added. It is kept until the server stops.`;
  } catch (e) {
    cloneStatus.textContent = e instanceof Error ? e.message : String(e);
  }
}

const recorder = new MicRecorder();
async function finishRecording() {
  // Idempotent: the 30 s limit and a click on Stop may both arrive; the first one wins.
  if (!recorder.recording) return;
  voiceRecord.textContent = "Record";
  let audio: ArrayBuffer;
  try {
    audio = await recorder.stop();
  } catch (e) {
    cloneStatus.textContent = e instanceof Error ? e.message : String(e);
    return;
  }
  await addSampleVoice(`Recording ${new Date().toLocaleTimeString()}`, audio);
}

voiceFileButton.addEventListener("click", () => voiceFile.click());
voiceFile.addEventListener("change", async () => {
  const file = voiceFile.files?.[0];
  voiceFile.value = "";
  if (!file) return;
  await addSampleVoice(file.name.replace(/\.[^.]*$/, ""), await file.arrayBuffer());
});
voiceRecord.addEventListener("click", async () => {
  if (recorder.recording) return finishRecording();
  if (recorder.starting || recorder.stopping) return; // a permission prompt or a stop is already under way
  cloneStatus.textContent = "Waiting for the microphone…";
  try {
    await recorder.start(() => void finishRecording());
  } catch (e) {
    cloneStatus.textContent = e instanceof Error ? e.message : String(e);
    return;
  }
  voiceRecord.textContent = "Stop recording";
  cloneStatus.textContent = "Recording… speak for 5 to 30 seconds, then stop.";
});

// ---- wiring ----------------------------------------------------------------------------------

for (const side of SIDES) {
  const controls = speechControls[side];
  controls.addEventListener("listen", () => toggleSpeech(side));
  controls.addEventListener("prev", () => jumpSpeech(-1));
  controls.addEventListener("next", () => jumpSpeech(1));
  controls.addEventListener("pause", () => {
    if (player.state === "paused") player.resume();
    else player.pause();
  });
}
voiceSelect.addEventListener("change", () => {
  store("voice", voiceSelect.value);
  player.update({ voice: voiceSelect.value });
  if (speechProblem || voicesStale) void recheckVoicesNow(false);
});
speedSelect.addEventListener("change", () => {
  store("speed", speedSelect.value);
  player.update({ speed: Number(speedSelect.value) });
  if (speechProblem || voicesStale) void recheckVoicesNow(false);
});
const savedSpeed = stored("speed");
if ([...speedSelect.options].some((o) => o.value === savedSpeed)) speedSelect.value = savedSpeed!;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void translate();
});

textInput.addEventListener("input", () => {
  if (!textError.hidden && textInput.value.trim()) showFieldError(textError, textInput, null);
  stopSpeech("source");
  refreshControls();
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
fromSelect.addEventListener("change", () => {
  stopSpeech("source");
  refreshSelection();
  refreshSpeech();
});
toSelect.addEventListener("change", refreshSelection);
modelSwitch.addEventListener("change", () => {
  setModelChoice(modelSwitch.value as Choice);
  refreshSelection();
  store("model", modelChoice);
});

copyBtn.addEventListener("click", async () => {
  if (copyBtn.getAttribute("aria-disabled") === "true") return;
  try {
    await navigator.clipboard.writeText(state.translation);
    flashMeta("Translation copied to the clipboard.");
  } catch {
    flashMeta("Copying failed. Select the translation and copy it by hand.");
  }
});

const savedModel = stored("model");
if (CHOICES.includes(savedModel as Choice)) setModelChoice(savedModel as Choice);

bindRender(
  createRender({
    translate: translateBtn,
    stop: stopBtn,
    clear: clearBtn,
    copy: copyBtn,
    sourceSwitch,
    outputSwitch,
    after: refreshSpeech,
  }),
);
refreshControls();
void loadLanguages();
void loadVoices();
void pollHealth();
document.addEventListener("visibilitychange", () => {
  void pollHealth();
  if (document.visibilityState === "visible") recheckVoices();
});
window.addEventListener("focus", recheckVoices);
