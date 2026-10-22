// The web app: one page, talking to the REST/SSE API of the same server.
// Everything with logic that can be tested without a DOM lives in the sibling modules; this file
// reads the form, calls the API and writes the results to the page.

import type { Health, Language, Webpage } from "../src/api.ts";
import { API, ApiFailure, failureMessage } from "./api.ts";
// eslint-disable-next-line import/no-unassigned-import -- custom element definitions
import "./elements/index.ts";
import type { MetaLine } from "./elements/meta-line.ts";
import type { PdfPages } from "./elements/pdf-pages.ts";
import type { SpeechControls } from "./elements/speech-controls.ts";
import type { ViewSwitch } from "./elements/view-switch.ts";
import type { VoiceSettings } from "./elements/voice-settings.ts";
import { type ApiErrorBody, describeWebpageError } from "./errors.ts";
import { initHistoryUi } from "./history-ui.ts";
import { type HistoryEntry, loadHistory, newId, saveHistory, withEntry } from "./history.ts";
import { ask, confirmLink } from "./link-dialog.ts";
import { type LinkReference, linkReference } from "./links.ts";
import { checkLinks, createOutput, type OutputView, renderText } from "./markdown-dom.ts";
import { looksLikeMarkdown } from "./markdown.ts";
import {
  adviceMessage,
  type Done,
  healthMessage,
  imageAdviceMessage,
  interruption,
  metaLine,
  modelLabel,
  resultNotes,
  selectionMessage,
  type Vram,
} from "./messages.ts";
import { initOpenUi } from "./open-ui.ts";
import {
  alignBlocks,
  alignFromPairs,
  type Alignment,
  blockTexts,
  counterpart,
  detailedMismatchMessage,
  matchable,
  mismatchMessage,
  paragraphMismatch,
  unitOf,
} from "./paragraphs.ts";
import { registerServiceWorker } from "./pwa.ts";
import { createRender } from "./render.ts";
import { buildImageRequest, buildRequest, glossaryMessage, hasOptions as formHasOptions } from "./request.ts";
import { resumableEvents, TRANSLATION_ID_HEADER } from "./resume.ts";
import { focusableWhenScrolling } from "./scroll-focus.ts";
import { SentenceBoundaries } from "./segment.ts";
import { CHAT_MODEL, type Choice, detectSource, DOCUMENT_MODEL, type Selection, selectModel } from "./select-model.ts";
import { MAX_SENTENCES, postAlign, SentenceAligner } from "./sentence-align.ts";
import { initSentenceHover } from "./sentence-hover.ts";
import { initSpeechUi, type SpeechUi } from "./speech-ui.ts";
import { bindRender, setState, type Side, state } from "./state.ts";
import { store, stored } from "./storage.ts";
import { clearLinked, hoveredLine, markLinked, type Pane, syncFrom, textareaPane, viewPane } from "./sync-scroll.ts";
import { webpageLink } from "./webpage-link.ts";

const HEALTH_LOADING_POLL_MS = 2000;
const HEALTH_POLL_MS = 5000;
let healthTimer: ReturnType<typeof setTimeout> | undefined;
const number = new Intl.NumberFormat();

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing #${id}`);
  }
  return el as T;
}

const form = $<HTMLFormElement>("form");
const fromSelect = $<HTMLSelectElement>("from");
const toSelect = $<HTMLSelectElement>("to");
const textInput = $<HTMLTextAreaElement>("text");
const countEl = $("count");
/** Says what happens to the source box (a page being fetched) to screen readers; `#count` shows it. */
const sourceStatus = $("source-status");
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
// The panes scroll when the text is longer than they are: then they take focus, so the keyboard can scroll them.
focusableWhenScrolling(sourceArea, "Source text, rendered", true);
focusableWhenScrolling(outputArea, "Translation text", true);
focusableWhenScrolling(countEl, "Source status", true);
/** The one line under the translation: progress, the result's numbers, a stop or an error. */
const metaEl = $<MetaLine>("meta");
const notesEl = $("notes");

// ---- small helpers ---------------------------------------------------------------------------

function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) {
    el.textContent = text;
  }
}

function showFieldError(error: HTMLElement, input: HTMLElement, message: string | null) {
  error.hidden = message === null;
  error.textContent = message ?? "";
  if (message === null) {
    input.removeAttribute("aria-invalid");
  } else {
    input.setAttribute("aria-invalid", "true");
  }
}

// ---- an image as the source ------------------------------------------------------------------
//
// An opened image stands where the text box is, drawn on a canvas (the page's CSP allows no
// `blob:` or `data:` picture). The box stays empty under it. Translate sends the file, and only
// then does it leave the browser; everything that puts a text in the box (`loadSource`, a restored
// history entry) takes the image away.

const imageArea = $("source-image");
const imageCanvas = $<HTMLCanvasElement>("source-canvas");
/** The longer side of the canvas at most: the picture is for looking at, the file is what is sent. */
const MAX_CANVAS_SIDE = 2048;
let sourceImage: File | null = null;

function setSourceImage(file: File | null, picture?: ImageBitmap) {
  sourceImage = file;
  if (file && picture) {
    const scale = Math.min(1, MAX_CANVAS_SIDE / Math.max(picture.width, picture.height));
    imageCanvas.width = Math.max(1, Math.round(picture.width * scale));
    imageCanvas.height = Math.max(1, Math.round(picture.height * scale));
    imageCanvas.getContext("2d")?.drawImage(picture, 0, 0, imageCanvas.width, imageCanvas.height);
    imageCanvas.setAttribute("aria-label", `Image to translate: ${file.name}`);
  } else {
    // Gives the pixels back.
    imageCanvas.width = 0;
    imageCanvas.height = 0;
  }
  picture?.close();
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`${file.name} could not be read`));
    reader.readAsDataURL(file);
  });
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
  if (lang) {
    el.lang = lang;
  } else {
    el.removeAttribute("lang");
  }
}

function refreshSelection() {
  const s = currentSelection();
  setLang(textInput, sourceLangOf());
  if (sourceImage) {
    const { width, height } = imageCanvas;
    setText(countEl, `${sourceImage.name}, ${number.format(width)} × ${number.format(height)} pixels`);
    const documentChosen = modelChoice === DOCUMENT_MODEL;
    setText(adviceEl, imageAdviceMessage(documentChosen, fromSelect.value, toSelect.value, languageNote));
    options.disabled = false;
    return s;
  }
  // While a page is fetched the count says so instead (`fetchWebpage`).
  if (!fetchingPage) {
    setText(countEl, `${number.format(s.letters)} letters`);
  }
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

async function loadLanguages() {
  let languages: Language[];
  try {
    const res = await fetch(`${API}/languages`);
    const { languages: list } = (await res.json()) as { languages?: Language[] };
    if (!Array.isArray(list)) {
      throw new TypeError("no language list");
    }
    languages = list;
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
  add(fromSelect, "auto", "Detect");
  // "Detect" is not a language, so a rule separates it from the list.
  fromSelect.append(document.createElement("hr"));
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
  historyUi.show(history); // now with the language names
}

/** Counts up for each poll; a response from an earlier poll is stale and must not overwrite a newer one. */
let healthSeq = 0;
/** The server can fetch web pages (`webpage` in /health): only then is an address in the box offered as one. */
let webpageAvailable = false;
/** A page is being fetched into the source box. */
let fetchingPage = false;

async function pollHealth() {
  // One chain at a time: any pending follow-up poll is replaced by this one.
  clearTimeout(healthTimer);
  healthTimer = undefined;
  const seq = ++healthSeq;
  if (document.hidden) {
    return;
  }
  let text: string;
  let loading = false;
  let vram: Vram | null = null;
  let problem: boolean;
  try {
    const res = await fetch(`${API}/health`);
    const health = (await res.json()) as Health;
    ({ text, loading, vram, problem } = healthMessage(health));
    webpageAvailable = health.webpage?.status === "available";
    boundaries.configure(health.segment);
    aligner.configure(health.align);
  } catch {
    text = "The server cannot be reached.";
    problem = true;
  }
  if (seq !== healthSeq) {
    return;
  }
  // The next poll follows by itself, faster during a load; a hidden tab stops the chain (the
  // check at the top) and `visibilitychange` starts it again. Page load and each finished
  // translation poll at once besides.
  healthTimer = setTimeout(pollHealth, loading ? HEALTH_LOADING_POLL_MS : HEALTH_POLL_MS);
  showEngine(text, loading, vram, problem);
}

/**
 * The engine status: a bar when the GPU memory is known or while a model loads (indeterminate), the
 * sentence otherwise (a warning when `problem`). The words are the link's name and tooltip. The page
 * starts with an indeterminate bar (`index.html`), which a load keeps, so its animation does not restart.
 */
function showEngine(text: string, loading: boolean, vram: Vram | null, problem: boolean) {
  const key = `${text}|${loading}|${vram?.label}|${vram?.used}|${problem}`;
  if (engineEl.dataset.shown === key) {
    return;
  }
  engineEl.dataset.shown = key;
  engineEl.classList.toggle("problem", problem);
  if (!loading && !vram) {
    engineEl.replaceChildren(text);
    engineEl.removeAttribute("title");
    return;
  }
  const words = vram ? `${text} ${vram.label}.` : text;
  const running = engineEl.querySelector(".bar.indeterminate");
  if (loading && running) {
    engineEl.querySelector(".sr-only")!.textContent = words;
    engineEl.title = words;
    return;
  }
  const bar = document.createElement("span");
  bar.className = loading ? "bar indeterminate" : vram?.tight ? "bar tight" : "bar";
  bar.setAttribute("aria-hidden", "true");
  const fill = document.createElement("span");
  fill.className = "fill";
  if (vram) {
    fill.style.inlineSize = `${((vram.used / vram.total) * 100).toFixed(1)}%`;
  }
  bar.append(fill);
  const name = document.createElement("span");
  name.className = "sr-only";
  name.textContent = words;
  engineEl.replaceChildren(bar, name);
  engineEl.title = words;
}

// ---- translating -----------------------------------------------------------------------------

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
  setState({ source: textInput.value, image: sourceImage !== null });
}

function showSource() {
  const image = sourceImage !== null;
  const preview = !image && views.source.view === "preview" && textInput.value.length > 0;
  showSwitch(sourceSwitch, "source");
  setLang(sourceView, sourceLangOf());
  if (preview) {
    renderText(sourceView, textInput.value, views.source.available);
  } else {
    sourceView.replaceChildren();
  }
  sourceArea.hidden = !preview;
  imageArea.hidden = !image;
  textInput.hidden = preview || image;
  refreshControls();
  refreshSync();
  speech.showSpeaking();
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
    speech.showSpeaking();
  }
}

/** Output links open only after the dialog is confirmed; its wording depends on the link check. */
function onOutputLink(e: MouseEvent) {
  const a = (e.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!a || !outputEl.contains(a) || (e.type === "auxclick" && e.button !== 1)) {
    return;
  }
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  void confirmLink(href, a.dataset.linkPaired === "true").then((ok) => {
    if (ok) {
      window.open(a.href, "_blank", "noopener,noreferrer");
    }
  });
}
outputEl.addEventListener("click", onOutputLink);
outputEl.addEventListener("auxclick", onOutputLink);

/** Set when a translation ends: what the output's links are checked against. */
let linkCheck: { translation: string; ref: LinkReference } | null = null;

function applyLinkCheck() {
  if (linkCheck?.translation === state.translation && outputEl.classList.contains("markdown")) {
    checkLinks(outputEl, linkCheck.ref);
  }
}

function wireSwitch(el: ViewSwitch, side: keyof typeof views, show: () => void) {
  el.addEventListener("change", () => {
    if (side === "source") {
      views.source.available = looksLikeMarkdown(textInput.value);
    }
    views[side].view = el.value as View;
    // The source is read only from Preview: its Raw text box is for writing.
    if (side === "source" && el.value === "raw") {
      speech.stop("source");
    }
    show();
  });
}

// ---- click to sync scrolling -----------------------------------------------------------------

/** Set after a finished translation whose blocks match the source's, for that source and output. */
let synced: { source: string; translation: string; alignment: Alignment } | null = null;

function syncActive(): Alignment | null {
  return synced?.source === textInput.value && synced.translation === state.translation ? synced.alignment : null;
}

function refreshSync() {
  const on = syncActive() !== null;
  for (const el of [textInput, sourceArea, outputArea]) {
    el.classList.toggle("synced", on);
  }
}

function sourcePane(): Pane {
  return textInput.hidden ? viewPane(sourceView, sourceArea) : textareaPane(textInput);
}

function onSourceClick(e: MouseEvent) {
  const a = syncActive();
  if (a) {
    syncFrom(e, sourcePane(), viewPane(outputEl, outputArea), a, "source");
  }
}

function onOutputClick(e: MouseEvent) {
  const a = syncActive();
  if (a) {
    syncFrom(e, viewPane(outputEl, outputArea), sourcePane(), a, "output");
  }
}

/** Hovering a block of one rendered pane shades the blocks it maps to in the other rendered pane. */
function onHover(e: MouseEvent, fromView: HTMLElement, toView: HTMLElement, side: Side) {
  const a = syncActive();
  const line = a ? hoveredLine(e, fromView) : null;
  const match = a && line !== null ? counterpart(a, side, line) : null;
  if (match) {
    markLinked(toView, match.other);
  } else {
    clearLinked(toView);
  }
}

/**
 * Asked when a finished translation does not have as many blocks as its source: which blocks match
 * which (`POST /align`). The answer, for that source and translation, turns on what matched blocks
 * allow (sync, the hovered block's counterpart, the link check by block) and replaces the paragraph
 * note with the places the translation went wrong. Without an answer the note stays as it was. Only
 * asked where the matching was measured to be reliable (`matchable`): a wrong place is worse than none.
 */
let blockMatch = new AbortController();

async function matchBlocks(source: string, translation: string, note: HTMLLIElement | undefined) {
  const unit = unitOf(source);
  const sourceBlocks = blockTexts(source, unit);
  const outputBlocks = blockTexts(translation, unit);
  if (
    !aligner.available ||
    !matchable(sourceBlocks) ||
    [sourceBlocks, outputBlocks].some((blocks) => blocks.length === 0 || blocks.length > MAX_SENTENCES)
  ) {
    return;
  }
  const { signal } = blockMatch;
  let alignment: Alignment | null;
  try {
    alignment = alignFromPairs(source, translation, await postAlign(sourceBlocks, outputBlocks, signal, "paragraphs"));
  } catch {
    return;
  }
  if (!alignment || signal.aborted) {
    return;
  }
  synced = { source, translation, alignment };
  refreshSync();
  const mismatch = paragraphMismatch(source, translation);
  if (note && mismatch) {
    note.textContent = detailedMismatchMessage(mismatch, alignment);
  }
  if (linkCheck?.translation === translation) {
    linkCheck = { translation, ref: linkReference(source, alignment) };
    // Checked links are changed in place (a missing one loses its target), so the view is rebuilt first.
    if (outputEl.querySelector("[data-link-problem], [data-link-paired]")) {
      showOutput();
    }
  }
}

/**
 * The sentence boundaries the server tells (`POST /segment`, SaT), for marking the sentence under the
 * pointer and for cutting what is read aloud. A new translation or Clear drops what is still waiting.
 */
const boundaries = new SentenceBoundaries();
/** Which sentences of the translation translate which of the source (`POST /align`), asked for the hovered block. */
const aligner = new SentenceAligner();

const sentenceHover = initSentenceHover(
  [
    { scroller: sourceArea, view: sourceView, side: "source" },
    { scroller: outputArea, view: outputEl, side: "output" },
  ],
  () => !state.running,
  boundaries,
  { aligner, blocks: syncActive },
);

/**
 * Asks for the sentence boundaries of what both sides show, once a translation is finished (or a kept one
 * is put back): they are there when the pointer rests on a sentence or a reading starts.
 */
function prefetchSentences() {
  sentenceHover.prefetch();
  speech.prefetch();
}

sourceArea.addEventListener("mouseover", (e) => onHover(e, sourceView, outputEl, "source"));
outputArea.addEventListener("mouseover", (e) => onHover(e, outputEl, sourceView, "output"));
sourceArea.addEventListener("mouseleave", () => clearLinked(outputEl));
outputArea.addEventListener("mouseleave", () => clearLinked(sourceView));

// ---- follow the stream -----------------------------------------------------------------------

/** While a translation streams, the output stays scrolled to its end until the user scrolls. */
let following = true;
const stopFollowing = () => void (following = false);
for (const type of ["wheel", "touchmove", "pointerdown", "keydown"]) {
  outputArea.addEventListener(type, stopFollowing, { passive: true });
}
// The output element is stretched to the scroller's height, so its size does not change as text
// arrives; the content does.
new MutationObserver(() => {
  if (state.running && following) {
    outputArea.scrollTop = outputArea.scrollHeight;
  }
}).observe(outputEl, { childList: true, subtree: true, characterData: true });

/** Markdown is rendered when the source looks written in it; the copied text stays the raw output. */
function clearResult(markdown: boolean) {
  synced = null;
  linkCheck = null;
  blockMatch.abort();
  blockMatch = new AbortController();
  boundaries.abort();
  aligner.abort();
  views.output = { available: markdown, view: "preview" };
  setState({ translation: "" });
  showOutput();
  metaEl.show("");
  notesEl.replaceChildren();
  placeholderEl.hidden = true;
}

function addNote(text: string): HTMLLIElement {
  const li = document.createElement("li");
  li.textContent = text;
  notesEl.append(li);
  return li;
}

/** Output already on screen when a translation ends early is kept, but it must not look finished. */
function showInterruption(stopped: boolean, message = "") {
  const { note } = interruption(state.translation, stopped);
  metaEl.show([message, note ?? (stopped ? "Stopped." : "")].filter(Boolean).join(" "), !stopped);
}

function fail(message: string) {
  metaEl.show(message, true);
}

async function translate() {
  if (state.running) {
    return;
  }
  if (!state.languagesReady) {
    fail("The languages are still loading. Try again in a moment.");
    return;
  }

  const image = sourceImage;
  const text = textInput.value;
  if (!image && !text.trim()) {
    showFieldError(textError, textInput, "Enter some text to translate.");
    textInput.focus();
    return;
  }
  showFieldError(textError, textInput, null);

  // Nothing but a web address: the page itself may be what is meant.
  const link = image || !webpageAvailable ? null : webpageLink(text);
  if (link) {
    const answer = await askWebpage(link);
    if (answer === "fetch") {
      await fetchWebpage(link);
      return;
    }
    if (answer !== "text") {
      return;
    }
  }

  const sel = refreshSelection();
  if (!image && sel.reason === "manual-document-unusable") {
    fail(selectionMessage(sel).text);
    return;
  }
  // Only the chat model reads images.
  const model = image ? CHAT_MODEL : sel.model;

  const values = {
    text,
    targetLang: toSelect.value,
    glossary: glossaryInput.value,
    hard: hardInput.value,
    soft: softInput.value,
    genre: genreInput.value,
  };
  // The image itself is put in when the request is sent.
  const built = image
    ? buildImageRequest("", fromSelect.value === "auto" ? undefined : fromSelect.value, values)
    : buildRequest(sel.model, sel.sourceLang, values);
  if ("glossaryProblem" in built) {
    advancedOpen();
    showFieldError(glossaryError, glossaryInput, glossaryMessage(built.glossaryProblem));
    glossaryInput.focus();
    return;
  }
  showFieldError(glossaryError, glossaryInput, null);

  store("from", fromSelect.value);
  store("to", toSelect.value);

  speech.stop();
  const controller = new AbortController();
  setState({ running: controller });
  following = true;
  const markdown = !image && looksLikeMarkdown(text);
  clearResult(markdown);
  views.source = { available: markdown, view: markdown ? "preview" : "raw" };
  showSource();
  outputEl.lang = toSelect.value;
  stopBtn.focus();
  metaEl.show(`Translating with ${modelLabel(model)}…`);

  let stopped = false;
  /** Whether the translation came to its end, and so has sentences worth asking the server about. */
  let finished = false;
  let translationId: string | null = null;
  stopBtn.onclick = () => {
    stopped = true;
    controller.abort();
    // The server keeps a resumable translation running without a reader, so it is told to stop.
    if (translationId) {
      void fetch(`${API}/translations/${translationId}`, { method: "DELETE", keepalive: true }).catch(() => {});
    }
  };

  try {
    const body = JSON.stringify({
      ...built.body,
      ...(image && { image: await readDataUrl(image) }),
      resumable: true,
    });
    controller.signal.throwIfAborted();
    const events = resumableEvents({
      signal: controller.signal,
      visible: () => document.visibilityState === "visible",
      wake: (callback) => {
        const listener = () => {
          if (document.visibilityState === "visible") {
            callback();
          }
        };
        document.addEventListener("visibilitychange", listener);
        window.addEventListener("pageshow", listener);
        return () => {
          document.removeEventListener("visibilitychange", listener);
          window.removeEventListener("pageshow", listener);
        };
      },
      onReconnecting: () => metaEl.show("Connection lost. Reconnecting…"),
      onReconnected: () => metaEl.show(`Translating with ${modelLabel(model)}…`),
      connect: async (lastId, signal) => {
        const res = translationId
          ? await fetch(`${API}/translations/${translationId}/events`, {
              headers: { "last-event-id": String(lastId) },
              signal,
            })
          : await fetch(`${API}/translate`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
              signal,
            });
        if (!res.ok || !res.body) {
          const payload = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
          throw new ApiFailure(payload?.error ?? {}, res.status);
        }
        translationId ??= res.headers.get(TRANSLATION_ID_HEADER);
        return res;
      },
    });

    let done: Done | null = null;
    for await (const { event, data } of events) {
      if (event === "queued") {
        metaEl.show(`Waiting in the queue, position ${data.position}…`);
      } else if (event === "start") {
        metaEl.show(`Translating with ${modelLabel(data.model)}…`);
      } else if (event === "delta") {
        // Only the first token changes what the controls show; the rest just grows the copied text.
        if (state.translation.length === 0) {
          setState({ translation: data.text });
        } else {
          state.translation += data.text;
        }
        output!.append(data.text);
      } else if (event === "done") {
        done = data;
      } else if (event === "error") {
        throw new ApiFailure(data, 0);
      }
    }
    if (!done) {
      throw new Error("the connection closed before the translation finished");
    }

    const { translation } = state;
    const notes = resultNotes(done, {
      source: image ? null : text,
      translation,
      model,
      sourceLang: sel.sourceLang,
      targetLang: toSelect.value,
    });
    const mismatch = image ? null : paragraphMismatch(text, translation);
    const mismatchNote = notes.map(addNote).find((li) => mismatch && li.textContent === mismatchMessage(mismatch));
    const matched = !image && done.finish_reason === "stop";
    const alignment = matched ? alignBlocks(text, translation) : null;
    if (alignment) {
      synced = { source: text, translation, alignment };
    } else if (matched) {
      void matchBlocks(text, translation, mismatchNote);
    }
    metaEl.show(metaLine(model, done));
    finished = true;
    if (markdown) {
      linkCheck = { translation, ref: linkReference(text, alignBlocks(text, translation)) };
    }
    // An image's translation is not kept: the history holds texts, and the picture stays out of local storage.
    if (!image && translation.trim()) {
      addToHistory({
        id: newId(),
        at: Date.now(),
        from: fromSelect.value,
        to: toSelect.value,
        model: sel.model,
        source: text,
        translation,
      });
    }
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
    if (finished) {
      // With the views as they stay: the sentences asked about are those of their final text.
      prefetchSentences();
    }
    stopBtn.onclick = null;
    // Taken before the state changes: Stop is hidden then, and a hidden button loses focus.
    const hadFocus = document.activeElement === stopBtn || document.activeElement === document.body;
    setState({ running: null });
    if (hadFocus) {
      translateBtn.focus();
    }
    placeholderEl.hidden = state.translation.length > 0;
    refreshSync();
    void pollHealth();
  }
}

// ---- a web page as the source ----------------------------------------------------------------
//
// An address alone in the box is offered as a page to fetch. The server opens it (POST /webpage)
// and answers its content as Markdown, which goes into the box like an opened file, shown as a
// preview; translating it is a second Translate. Only the address goes to the server. What happens
// is said under the box, where the letter count is, and errors as the box's own; the status line
// under the translation keeps the last translation's.

function askWebpage(link: string): Promise<string> {
  return ask({
    title: "Fetch this web page?",
    message:
      "The text is a web address. The server can open the page and put its text in the box, ready to translate. Or the address can be translated as it is.",
    target: link,
    choices: [
      { value: "text", label: "Translate as text" },
      { value: "fetch", label: "Fetch page" },
    ],
  });
}

async function fetchWebpage(url: string) {
  speech.stop();
  const controller = new AbortController();
  setState({ running: controller });
  stopBtn.focus();
  fetchingPage = true;
  setText(countEl, "Fetching the page…");
  sourceStatus.textContent = "Fetching the page…";
  /** Said when the fetch ends, unless the page took the box (its preview says enough). */
  let outcome = "";
  let stopped = false;
  stopBtn.onclick = () => {
    stopped = true;
    controller.abort();
  };
  try {
    const res = await fetch(`${API}/webpage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
      throw new ApiFailure(payload?.error ?? {}, res.status);
    }
    const page = (await res.json()) as Webpage;
    if (!page.markdown.trim()) {
      outcome = "The page has no text to translate.";
      showFieldError(textError, textInput, outcome);
      return;
    }
    fetchingPage = false;
    loadSource(page.markdown, true);
    openUi.deselect();
    outcome = `Fetched “${page.title || page.url}”. Translate it when you are ready.`;
  } catch (e) {
    if (stopped) {
      outcome = "Stopped.";
    } else {
      outcome = e instanceof ApiFailure ? describeWebpageError(e.body, e.status) : failureMessage(e);
      showFieldError(textError, textInput, outcome);
    }
  } finally {
    fetchingPage = false;
    refreshSelection();
    sourceStatus.textContent = outcome;
    stopBtn.onclick = null;
    const hadFocus = document.activeElement === stopBtn || document.activeElement === document.body;
    setState({ running: null });
    if (hadFocus) {
      translateBtn.focus();
    }
  }
}

/**
 * Puts `text` in place of the source and drops the result: a new start. It is shown in the text
 * box, or with `preview` rendered as after Translate (Markdown when it looks like it).
 */
function loadSource(text: string, preview = false) {
  speech.stop();
  setSourceImage(null);
  textInput.value = text;
  textInput.scrollTop = 0;
  sourceArea.scrollTop = 0;
  showFieldError(textError, textInput, null);
  views.source = { available: preview && looksLikeMarkdown(text), view: preview && text ? "preview" : "raw" };
  showSource();
  clearResult(false);
  placeholderEl.hidden = false;
  refreshSync();
  refreshSelection();
}

/** Puts an opened image in place of the source box: a new start like `loadSource`, with no text. */
function loadImage(file: File, picture: ImageBitmap) {
  loadSource("");
  setSourceImage(file, picture);
  showSource();
  refreshSelection();
}

/** Empties the source and the result and returns the source to the plain textarea. */
function clearAll() {
  if (state.running || clearBtn.getAttribute("aria-disabled") === "true") {
    return;
  }
  loadSource("");
  openUi.deselect();
  openUi.clearNote();
  textInput.focus();
}

// ---- opening a file --------------------------------------------------------------------------
//
// open-ui.ts: the Open button, and the page thumbnails of a PDF beside the source box. A file's
// text reaches the box the way Clear empties it; nothing about the file goes to the server.

const openUi = initOpenUi({
  button: $("open"),
  input: $<HTMLInputElement>("open-file"),
  pages: $<PdfPages>("pdf-pages"),
  note: $("file-note"),
  area: $("source-field"),
  load: loadSource,
  loadImage,
});

// ---- history ---------------------------------------------------------------------------------
//
// history.ts: finished translations in this browser's local storage; nothing goes to the server.

let history: HistoryEntry[] = loadHistory();

// Pausing only stops new entries; the kept ones stay and can be restored or deleted.
const PAUSED_KEY = "history-paused";
const pauseButton = $("history-pause");
let historyPaused = stored(PAUSED_KEY) === "1";

function showPaused() {
  pauseButton.textContent = historyPaused ? "Resume" : "Pause";
  pauseButton.setAttribute("aria-label", historyPaused ? "Resume history" : "Pause history");
  $("history-empty").textContent = historyPaused
    ? "History is paused: finished translations are not being kept."
    : "Finished translations appear here. They are kept in this browser only and never sent to the server.";
}
pauseButton.addEventListener("click", () => {
  historyPaused = !historyPaused;
  store(PAUSED_KEY, historyPaused ? "1" : "0");
  showPaused();
});
showPaused();

function languageName(code: string): string {
  if (code === "auto") {
    return "Detected language";
  }
  return [...toSelect.options].find((o) => o.value === code)?.textContent ?? code;
}

const historyUi = initHistoryUi({
  list: $("history-list"),
  empty: $("history-empty"),
  count: $("history-count"),
  clear: $("history-clear"),
  languageName,
  restore: restoreEntry,
  remove: (entry) => {
    setHistory(history.filter((e) => e.id !== entry.id));
    const next = document.querySelector<HTMLElement>("#history-list [data-delete]");
    (next ?? $("history-clear")).focus();
  },
  clearAll: () => {
    setHistory([]);
    $("history-clear").focus();
  },
});

/** Saves the list; a browser that refuses all storage still keeps it until the page is closed. */
function setHistory(list: HistoryEntry[]) {
  const kept = saveHistory(list);
  history = kept.length === 0 && list.length > 0 ? list : kept;
  historyUi.show(history);
}

function addToHistory(entry: HistoryEntry) {
  if (historyPaused) {
    return;
  }
  setHistory(withEntry(history, entry));
}

/** Puts a kept translation back on the page as if it had just finished. */
function restoreEntry(entry: HistoryEntry) {
  if (state.running) {
    return;
  }
  speech.stop();
  openUi.deselect();
  setSourceImage(null);
  textInput.value = entry.source;
  showFieldError(textError, textInput, null);
  const has = (select: HTMLSelectElement, v: string) => [...select.options].some((o) => o.value === v);
  if (has(fromSelect, entry.from)) {
    fromSelect.value = entry.from;
  }
  if (has(toSelect, entry.to)) {
    toSelect.value = entry.to;
  }
  const markdown = looksLikeMarkdown(entry.source);
  clearResult(markdown);
  views.source = { available: markdown, view: markdown ? "preview" : "raw" };
  showSource();
  outputEl.lang = toSelect.value;
  setState({ translation: entry.translation });
  showOutput();
  placeholderEl.hidden = true;
  refreshSelection();
  refreshSync();
  metaEl.show(`Restored from the history (${modelLabel(entry.model)}).`);
  prefetchSentences();
  textInput.closest("section")?.scrollIntoView({ block: "start" });
}

function advancedOpen() {
  $<HTMLDetailsElement>("advanced").open = true;
}

// ---- reading aloud ---------------------------------------------------------------------------
//
// speech-ui.ts: the Read aloud toggles and their gutters, the voice list and what a reading does to
// the page. This file tells it what each side holds and how it is shown.

const speech: SpeechUi = initSpeechUi({
  boundaries,
  controls: {
    source: $<SpeechControls>("speech-source"),
    output: $<SpeechControls>("speech-output"),
  },
  voiceSettings: $<VoiceSettings>("voice-settings"),
  settingsPanel: $("speech-settings"),
  meta: metaEl,
  panes: {
    source: { view: sourceView, area: sourceArea },
    output: { view: outputEl, area: outputArea },
  },
  target: (side: Side) =>
    side === "source"
      ? { text: textInput.value, lang: sourceLangOf() }
      : { text: state.translation, lang: outputEl.lang || undefined },
  isMarkdown: (side: Side) => (side === "source" ? looksLikeMarkdown(textInput.value) : views.output.available),
  shown: (side: Side) => side === "output" || !sourceArea.hidden,
});

// ---- wiring ----------------------------------------------------------------------------------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void translate();
});

textInput.addEventListener("input", () => {
  if (!textError.hidden && textInput.value.trim()) {
    showFieldError(textError, textInput, null);
  }
  speech.stop("source");
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
for (const el of [glossaryInput, hardInput, softInput, genreInput]) {
  el.addEventListener("input", refreshSoon);
}
fromSelect.addEventListener("change", () => {
  speech.stop("source");
  refreshSelection();
  speech.refresh();
});
toSelect.addEventListener("change", () => void refreshSelection());
modelSwitch.addEventListener("change", () => {
  setModelChoice(modelSwitch.value as Choice);
  refreshSelection();
  store("model", modelChoice);
});

async function copyTranslation(): Promise<void> {
  if (copyBtn.getAttribute("aria-disabled") === "true") {
    return;
  }
  try {
    await navigator.clipboard.writeText(state.translation);
    metaEl.flash("Translation copied to the clipboard.");
  } catch {
    metaEl.flash("Copying failed. Select the translation and copy it by hand.");
  }
}
copyBtn.addEventListener("click", () => void copyTranslation());

const savedModel = stored("model");
if (CHOICES.includes(savedModel as Choice)) {
  setModelChoice(savedModel as Choice);
}

bindRender(
  createRender({
    translate: translateBtn,
    stop: stopBtn,
    clear: clearBtn,
    copy: copyBtn,
    sourceSwitch,
    outputSwitch,
    after: () => {
      speech.refresh();
      historyUi.setBusy(state.running !== null);
      openUi.setBusy(state.running !== null);
    },
  }),
);
refreshControls();
historyUi.show(history);
void loadLanguages();
void speech.loadVoices();
registerServiceWorker();
void pollHealth();
document.addEventListener("visibilitychange", () => {
  void pollHealth();
  if (document.visibilityState === "visible") {
    speech.recheck();
  }
});
window.addEventListener("focus", () => speech.recheck());
