// The web app: one page, talking to the REST/SSE API of the same server.
// Everything with logic that can be tested without a DOM lives in the sibling modules; this file
// reads the form, calls the API and writes the results to the page.

import { failureMessage } from "./api.ts";
import { $, setLang, setText, showFieldError } from "./dom.ts";
// eslint-disable-next-line import/no-unassigned-import -- custom element definitions
import "./elements/index.ts";
import { writeClipboard } from "./clipboard.ts";
import type { MetaLine } from "./elements/meta-line.ts";
import type { PdfPages } from "./elements/pdf-pages.ts";
import type { SpeechControls } from "./elements/speech-controls.ts";
import type { ViewSwitch } from "./elements/view-switch.ts";
import type { VoiceSettings } from "./elements/voice-settings.ts";
import { initEngineStatus } from "./engine-status.ts";
import { type Format, formatOf } from "./format.ts";
import { initHistory } from "./history-state.ts";
import { type HistoryEntry, newId, restoredAlignment } from "./history.ts";
import { fillLanguages } from "./languages.ts";
import { confirmLink } from "./link-dialog.ts";
import { linkReference } from "./links.ts";
import { clipboardHtml, createOutput, type OutputView, renderText } from "./markdown-dom.ts";
import {
  adviceMessage,
  type Done,
  imageAdviceMessage,
  interruption,
  metaLine,
  modelLabel,
  resultNotes,
  selectionMessage,
  subtitleAdviceMessage,
} from "./messages.ts";
import { initOpenUi } from "./open-ui.ts";
import { alignBlocks, mismatchMessage, paragraphMismatch } from "./paragraphs.ts";
import { clearEnabled, copyEnabled, createRender, restoreFocusAfter } from "./render.ts";
import {
  buildImageRequest,
  buildRequest,
  buildSubtitleRequest,
  type FormValues,
  glossaryMessage,
  hasOptions,
} from "./request.ts";
import { Run, streamTranslation } from "./run.ts";
import { focusableWhenScrolling } from "./scroll-focus.ts";
import { SentenceBoundaries } from "./segment.ts";
import {
  CHAT_MODEL,
  type Choice,
  detectSource,
  DOCUMENT_MODEL,
  type ModelId,
  type Selection,
  selectModel,
} from "./select-model.ts";
import { SentenceAligner } from "./sentence-align.ts";
import { initSentenceHover } from "./sentence-hover.ts";
import { initSourceImage } from "./source-image.ts";
import { initSpeechUi, type SpeechUi } from "./speech-ui.ts";
import { appendTranslation, bindRender, setState, setTranslation, type Side, state } from "./state.ts";
import { KEYS, store, stored } from "./storage.ts";
import {
  type Cue,
  parseSrt,
  type Progress,
  subtitleAlignment,
  subtitleNotes,
  toWire,
  translateSubtitles,
  type Wire,
} from "./subtitles.ts";
import { initSyncState } from "./sync-state.ts";
import { initWebpageFlow } from "./webpage-flow.ts";
import { webpageLink } from "./webpage-link.ts";

const number = new Intl.NumberFormat();

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
const outputEl = $("output");
const placeholderEl = $("placeholder");
const imageArea = $("source-image");
// The panes scroll when the text is longer than they are: then they take focus, so the keyboard can scroll them.
focusableWhenScrolling(sourceArea, "Source text, rendered", true);
focusableWhenScrolling(outputArea, "Translation text", true);
focusableWhenScrolling(countEl, "Source status", true);
/** The one line under the translation: progress, the result's numbers, a stop or an error. */
const metaEl = $<MetaLine>("meta");
const notesEl = $("notes");

/** An opened image in place of the source box; see source-image.ts. */
const sourceImage = initSourceImage($<HTMLCanvasElement>("source-canvas"));

// ---- the form and the model selection --------------------------------------------------------

const CHOICES: Choice[] = ["auto", CHAT_MODEL, DOCUMENT_MODEL];
let modelChoice: Choice = "auto";

function setModelChoice(choice: Choice) {
  modelChoice = choice;
  modelSwitch.value = choice;
}

/** What the form holds now; the one place its fields are read. */
function readForm(): FormValues {
  return {
    text: textInput.value,
    targetLang: toSelect.value,
    glossary: glossaryInput.value,
    hard: hardInput.value,
    soft: softInput.value,
    genre: genreInput.value,
  };
}

function currentSelection(): Selection {
  const values = readForm();
  return selectModel({
    text: values.text,
    sourceLang: fromSelect.value,
    targetLang: values.targetLang,
    hasOptions: hasOptions(values),
    choice: modelChoice,
  });
}

/** Set when /languages could not be loaded and the built-in short list is offered instead. */
let languageNote = "";

/** The source text's language: the selected one, else a guess. Unknown leaves `lang` to the page. */
function sourceLangOf(): string | undefined {
  return fromSelect.value === "auto" ? detectSource(textInput.value) : fromSelect.value;
}

function refreshSelection() {
  const s = currentSelection();
  setLang(textInput, sourceLangOf());
  if (sourceImage.file) {
    const { width, height } = sourceImage.size;
    setText(countEl, `${sourceImage.file.name}, ${number.format(width)} × ${number.format(height)} pixels`);
    const documentChosen = modelChoice === DOCUMENT_MODEL;
    setText(adviceEl, imageAdviceMessage(documentChosen, fromSelect.value, toSelect.value, languageNote));
    options.disabled = false;
    return s;
  }
  const cues = parseSrt(textInput.value);
  if (cues) {
    setText(countEl, `${number.format(cues.length)} cues, ${number.format(s.letters)} letters`);
    const documentChosen = modelChoice === DOCUMENT_MODEL;
    setText(
      adviceEl,
      subtitleAdviceMessage(cues.length, documentChosen, fromSelect.value, toSelect.value, languageNote),
    );
    options.disabled = false;
    return s;
  }
  // While a page is fetched the count says so instead (webpage-flow.ts).
  if (!webpage.fetching) {
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

// ---- languages -------------------------------------------------------------------------------

async function loadLanguages() {
  languageNote = await fillLanguages(fromSelect, toSelect);
  setState({ languagesReady: true });
  refreshSelection();
  history.show(); // now with the language names
}

// ---- raw and preview views -------------------------------------------------------------------
//
// After Translate, a source that looks like Markdown is shown rendered in place of the textarea,
// subtitles as a table of cues, and so is the translation. Each side has its own Raw / Preview
// switch; Raw on the source side is the editable textarea. Clear returns the source to the plain
// textarea.

type View = "raw" | "preview";

/** How the text is rendered in Preview (`plain`: line by line, as it is), and the chosen view. */
const views = {
  source: { format: "plain" as Format, view: "raw" as View },
  output: { format: "plain" as Format, view: "preview" as View },
};

let output: OutputView | null = null;

/** Sets one side's view state in one place. */
function setView(side: keyof typeof views, format: Format, view: View) {
  views[side] = { format, view };
}

function showSwitch(el: ViewSwitch, side: keyof typeof views) {
  el.value = views[side].view;
}

/**
 * Takes the text box into the state, which renders the controls (render.ts). The box is the one
 * input the state does not own, so everything that changes it or the view around it comes here.
 */
function refreshControls() {
  setState({ source: textInput.value, image: sourceImage.file !== null });
}

function showSource() {
  const image = sourceImage.file !== null;
  const preview = !image && views.source.view === "preview" && textInput.value.length > 0;
  showSwitch(sourceSwitch, "source");
  setLang(sourceView, sourceLangOf());
  if (preview) {
    renderText(sourceView, textInput.value, views.source.format);
  } else {
    sourceView.replaceChildren();
  }
  sourceArea.hidden = !preview;
  imageArea.hidden = !image;
  textInput.hidden = preview || image;
  refreshControls();
  sync.refresh();
  speech.showSpeaking();
}

/** Sets the source's view state and shows it: Markdown and subtitle sources start rendered, others raw. */
function showSourceAs(format: Format, view: View) {
  setView("source", format, view);
  showSource();
}

/** Rebuilds the output in the chosen view; text still streaming is appended to the new view. */
function showOutput() {
  showSwitch(outputSwitch, "output");
  refreshControls();
  output = createOutput(outputEl, views.output.view === "preview" ? views.output.format : "plain");
  if (state.translation) {
    output.append(state.translation);
    output.finish();
    sync.applyLinkCheck();
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

function wireSwitch(el: ViewSwitch, side: keyof typeof views, show: () => void) {
  el.addEventListener("change", () => {
    if (side === "source") {
      views.source.format = formatOf(textInput.value);
    }
    views[side].view = el.value as View;
    // The source is read only from Preview: its Raw text box is for writing.
    if (side === "source" && el.value === "raw") {
      speech.stop("source");
    }
    show();
  });
}

// ---- matched blocks and sentences ------------------------------------------------------------

/**
 * The sentence boundaries the server tells (`POST /segment`, SaT), for marking the sentence under the
 * pointer and for cutting what is read aloud. A new translation or Clear drops what is still waiting.
 */
const boundaries = new SentenceBoundaries();
/** Which sentences of the translation translate which of the source (`POST /align`), asked for the hovered block. */
const aligner = new SentenceAligner();

/** Click-to-sync scrolling, block counterparts and the link check; sync-state.ts. */
const sync = initSyncState({
  textInput,
  sourceArea,
  sourceView,
  outputArea,
  outputEl,
  aligner,
  keepBlocks: (entryId, groups) => history.setBlocks(entryId, groups),
  rebuildOutput: showOutput,
});

const sentenceHover = initSentenceHover(
  [
    { scroller: sourceArea, view: sourceView, side: "source" },
    { scroller: outputArea, view: outputEl, side: "output" },
  ],
  () => !state.running,
  boundaries,
  { aligner, blocks: () => sync.active() },
);

/**
 * Asks for the sentence boundaries of what both sides show, once a translation is finished (or a kept one
 * is put back): they are there when the pointer rests on a sentence or a reading starts.
 */
function prefetchSentences() {
  sentenceHover.prefetch();
  speech.prefetch();
}

// ---- engine status and web pages -------------------------------------------------------------

const webpage = initWebpageFlow({
  stopButton: stopBtn,
  translateButton: translateBtn,
  count: countEl,
  status: $("source-status"),
  textError,
  textInput,
  stopReading: () => speech.stop(),
  load: (markdown) => {
    loadSource(markdown, true);
    openUi.deselect();
  },
  refreshSelection: () => void refreshSelection(),
});

const engine = initEngineStatus({
  el: $("engine"),
  onHealth: (health) => {
    webpage.available = health.webpage?.status === "available";
    boundaries.configure(health.segment);
    aligner.configure(health.align);
  },
});

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

// ---- translating -----------------------------------------------------------------------------

/** The output is rendered as the source is (Markdown, subtitles); the copied plain text stays the raw output. */
function clearResult(format: Format) {
  sync.reset();
  boundaries.abort();
  aligner.abort();
  setView("output", format, "preview");
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

/** What one Translate press works from, once the input and the form are known to be good. */
interface Job {
  /** The image to translate, else null and the text is. */
  image: File | null;
  text: string;
  sel: Selection;
  model: ModelId;
  body: Record<string, unknown>;
  /** How the source is rendered, and so the translation. */
  format: Format;
  /** For subtitles: their cues and what was sent for them (subtitles.ts). */
  subtitles: { cues: Cue[]; wire: Wire } | null;
}

/** The source to translate (an image, or a text that is not empty); says why not and returns null otherwise. */
function validateInput(): { image: File | null; text: string } | null {
  if (!state.languagesReady) {
    fail("The languages are still loading. Try again in a moment.");
    return null;
  }
  const image = sourceImage.file;
  const text = textInput.value;
  if (!image && !text.trim()) {
    showFieldError(textError, textInput, "Enter some text to translate.");
    textInput.focus();
    return null;
  }
  showFieldError(textError, textInput, null);
  return { image, text };
}

/** Nothing but a web address: the page itself may be what is meant. True when the choice took over. */
async function webpageTookOver({ image, text }: { image: File | null; text: string }): Promise<boolean> {
  const link = image || !webpage.available ? null : webpageLink(text);
  if (!link) {
    return false;
  }
  const answer = await webpage.ask(link);
  if (answer === "fetch") {
    await webpage.fetch(link);
  }
  return answer !== "text";
}

/** Picks the model and builds the request; says what is wrong with the form and returns null otherwise. */
function prepareJob({ image, text }: { image: File | null; text: string }): Job | null {
  const sel = refreshSelection();
  const format = image ? "plain" : formatOf(text);
  const cues = format === "subtitles" ? parseSrt(text) : null;
  const subtitles = cues && { cues, wire: toWire(cues) };
  if (subtitles && !subtitles.wire.text) {
    fail("These subtitles have no text to translate.");
    return null;
  }
  if (!image && !subtitles && sel.reason === "manual-document-unusable") {
    fail(selectionMessage(sel).text);
    return null;
  }
  // Only the chat model reads images and subtitles. The image itself is put in when the request is sent.
  const sourceLang = fromSelect.value === "auto" ? undefined : fromSelect.value;
  const values = readForm();
  const built = image
    ? buildImageRequest("", sourceLang, values)
    : subtitles
      ? buildSubtitleRequest(subtitles.wire.text, sel.sourceLang, values)
      : buildRequest(sel.model, sel.sourceLang, values);
  if ("glossaryProblem" in built) {
    $<HTMLDetailsElement>("advanced").open = true;
    showFieldError(glossaryError, glossaryInput, glossaryMessage(built.glossaryProblem));
    glossaryInput.focus();
    return null;
  }
  showFieldError(glossaryError, glossaryInput, null);
  return {
    image,
    text,
    sel,
    model: image || subtitles ? CHAT_MODEL : sel.model,
    body: built.body,
    format,
    subtitles,
  };
}

/** Takes the page into the translating state: the old result goes, the source is shown, Stop has focus. */
function startTranslation(job: Job): Run {
  store(KEYS.from, fromSelect.value);
  store(KEYS.to, toSelect.value);
  speech.stop();
  const run = new Run();
  setState({ running: run });
  following = true;
  clearResult(job.format);
  showSourceAs(job.format, job.format === "plain" ? "raw" : "preview");
  outputEl.lang = toSelect.value;
  stopBtn.focus();
  metaEl.show(`Translating with ${modelLabel(job.model)}…`);
  return run;
}

/**
 * A subtitle translation as far as it got (`written`, what the model wrote): rebuilt as SubRip, which
 * becomes the translation and is shown, its cues matched with the source's by number, and what it
 * joined, left out or did not reach noted.
 */
function settleSubtitles({ text, subtitles }: Job, written: string, progress: Progress) {
  const t = translateSubtitles(subtitles!.cues, subtitles!.wire, written, progress);
  setTranslation(t.srt);
  output?.show(t.srt);
  for (const note of subtitleNotes(t)) {
    addNote(note);
  }
  const alignment = subtitleAlignment(text, t.srt);
  if (alignment) {
    sync.set(text, t.srt, alignment);
  }
}

/** The translation came to its end: its notes, the block matching, the link check and the history entry. */
function finishTranslation(job: Job, done: Done, written: string) {
  const { image, text, sel, model, format } = job;
  const markdown = format === "markdown";
  if (job.subtitles) {
    const context = {
      source: null,
      translation: written,
      model,
      sourceLang: sel.sourceLang,
      targetLang: toSelect.value,
    };
    for (const note of resultNotes(done, context)) {
      addNote(note);
    }
    settleSubtitles(job, written, done.finish_reason === "stop" ? "complete" : "partial");
  }
  const { translation } = state;
  // Subtitles are matched by their cue numbers, so none of what follows is asked of them.
  const prose = !image && !job.subtitles;
  const notes = prose
    ? resultNotes(done, { source: text, translation, model, sourceLang: sel.sourceLang, targetLang: toSelect.value })
    : [];
  const mismatch = prose ? paragraphMismatch(text, translation) : null;
  const mismatchNote = notes.map(addNote).find((li) => mismatch && li.textContent === mismatchMessage(mismatch));
  const matched = prose && done.finish_reason === "stop";
  const blocks = matched || markdown ? alignBlocks(text, translation) : null;
  const alignment = matched ? blocks : null;
  const entryId = newId();
  if (alignment) {
    sync.set(text, translation, alignment);
  } else if (matched) {
    void sync.match(text, translation, mismatchNote, entryId);
  }
  metaEl.show(metaLine(model, done));
  if (markdown) {
    sync.setLinkCheck(translation, linkReference(text, blocks));
  }
  // An image's translation is not kept: the history holds texts, and the picture stays out of local storage.
  if (!image && translation.trim()) {
    history.add({
      id: entryId,
      at: Date.now(),
      from: fromSelect.value,
      to: toSelect.value,
      model,
      source: text,
      translation,
      ...(alignment && { blocks: "same" as const }),
    });
  }
}

/** Whatever way it ended: the view is final, Stop gives way to Clear and focus does not fall on the body. */
function endTranslation(finished: boolean) {
  output?.finish();
  // After the last render, which rebuilds the open tail and would drop the marks.
  sync.applyLinkCheck();
  if (finished) {
    // With the views as they stay: the sentences asked about are those of their final text.
    prefetchSentences();
  }
  restoreFocusAfter(stopBtn, translateBtn, () => setState({ running: null }));
  placeholderEl.hidden = state.translation.length > 0;
  sync.refresh();
  void engine.poll();
}

async function translate() {
  if (state.running) {
    return;
  }
  const input = validateInput();
  if (!input || (await webpageTookOver(input))) {
    return;
  }
  const job = prepareJob(input);
  if (!job) {
    return;
  }
  const run = startTranslation(job);
  let finished = false;
  /** For subtitles, what the model wrote, which `translateSubtitles` rebuilds the translation from. */
  let written = "";
  try {
    const body = JSON.stringify({
      ...job.body,
      ...(job.image && { image: await sourceImage.dataUrl() }),
      resumable: true,
    });
    run.controller.signal.throwIfAborted();
    const done = await streamTranslation(run, body, job.model, {
      status: (text) => metaEl.show(text),
      text: (piece) => {
        if (!job.subtitles) {
          appendTranslation(piece);
          output!.append(piece);
          return;
        }
        written += piece;
        const { srt } = translateSubtitles(job.subtitles.cues, job.subtitles.wire, written, "streaming");
        setTranslation(srt);
        output!.show(srt);
      },
    });
    finishTranslation(job, done, written);
    finished = true;
  } catch (e) {
    if (job.subtitles && written) {
      settleSubtitles(job, written, "partial");
    }
    if (run.stopped) {
      showInterruption(true);
    } else {
      showInterruption(false, failureMessage(e));
    }
  } finally {
    endTranslation(finished);
  }
}

/**
 * Puts `text` in place of the source and drops the result: a new start. It is shown in the text
 * box, or with `preview` rendered as after Translate (Markdown or subtitles when it looks like them).
 */
function loadSource(text: string, preview = false) {
  speech.stop();
  sourceImage.set(null);
  textInput.value = text;
  textInput.scrollTop = 0;
  sourceArea.scrollTop = 0;
  showFieldError(textError, textInput, null);
  showSourceAs(preview ? formatOf(text) : "plain", preview && text ? "preview" : "raw");
  clearResult("plain");
  placeholderEl.hidden = false;
  sync.refresh();
  refreshSelection();
}

/** Puts an opened image in place of the source box: a new start like `loadSource`, with no text. */
function loadImage(file: File, picture: ImageBitmap) {
  loadSource("");
  sourceImage.set(file, picture);
  showSource();
  refreshSelection();
}

/** Empties the source and the result and returns the source to the plain textarea. */
function clearAll() {
  if (state.running || !clearEnabled()) {
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
// history-state.ts: finished translations in this browser's local storage; nothing goes to the server.

function languageName(code: string): string {
  if (code === "auto") {
    return "Detected language";
  }
  return [...toSelect.options].find((o) => o.value === code)?.textContent ?? code;
}

const history = initHistory({
  list: $("history-list"),
  empty: $("history-empty"),
  count: $("history-count"),
  clear: $("history-clear"),
  pause: $("history-pause"),
  languageName,
  restore: restoreEntry,
});

/** Puts a kept translation back on the page as if it had just finished. */
function restoreEntry(entry: HistoryEntry) {
  if (state.running) {
    return;
  }
  speech.stop();
  openUi.deselect();
  sourceImage.set(null);
  textInput.value = entry.source;
  showFieldError(textError, textInput, null);
  const has = (select: HTMLSelectElement, v: string) => [...select.options].some((o) => o.value === v);
  if (has(fromSelect, entry.from)) {
    fromSelect.value = entry.from;
  }
  if (has(toSelect, entry.to)) {
    toSelect.value = entry.to;
  }
  const format = formatOf(entry.source);
  clearResult(format);
  showSourceAs(format, format === "plain" ? "raw" : "preview");
  outputEl.lang = toSelect.value;
  setState({ translation: entry.translation });
  showOutput();
  placeholderEl.hidden = true;
  refreshSelection();
  const alignment = restoredAlignment(entry);
  if (alignment) {
    sync.set(entry.source, entry.translation, alignment);
  }
  sync.refresh();
  metaEl.show(`Restored from the history (${modelLabel(entry.model)}).`);
  prefetchSentences();
  textInput.closest("section")?.scrollIntoView({ block: "start" });
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
  format: (side: Side) => (side === "source" ? formatOf(textInput.value) : views.output.format),
  shown: (side: Side) => side === "output" || !sourceArea.hidden,
});

// ---- wiring ----------------------------------------------------------------------------------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void translate();
});
// One listener for every run: Stop acts on whichever translation or page fetch is current.
stopBtn.addEventListener("click", () => state.running?.stop());

textInput.addEventListener("input", () => {
  if (!textError.hidden && textInput.value.trim()) {
    showFieldError(textError, textInput, null);
  }
  speech.stop("source");
  refreshControls();
  sync.refresh();
  refreshSoon();
});
wireSwitch(sourceSwitch, "source", showSource);
wireSwitch(outputSwitch, "output", () => {
  showOutput();
  sync.refresh();
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
  store(KEYS.model, modelChoice);
});

async function copyTranslation(): Promise<void> {
  if (!copyEnabled()) {
    return;
  }
  // A rendered Markdown translation goes out as rich text too; the plain text stays the source Markdown.
  const html = outputEl.classList.contains("markdown") ? clipboardHtml(outputEl) : null;
  const copied = await writeClipboard(state.translation, html);
  metaEl.flash(
    copied ? "Translation copied to the clipboard." : "Copying failed. Select the translation and copy it by hand.",
  );
}
copyBtn.addEventListener("click", () => void copyTranslation());

const savedModel = stored(KEYS.model);
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
      history.setBusy(state.running !== null);
      openUi.setBusy(state.running !== null);
    },
  }),
);
refreshControls();
history.show();
void loadLanguages();
void speech.loadVoices();
void engine.poll();
document.addEventListener("visibilitychange", () => {
  void engine.poll();
  if (document.visibilityState === "visible") {
    speech.recheck();
  }
});
window.addEventListener("focus", () => speech.recheck());
