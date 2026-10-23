// Reading aloud, as the page sees it: the Read aloud toggles of both panels, the gutter of "read
// from here" buttons, the voice list, the block being read, and what a reading does to the page.
//
// Each side has a Read aloud toggle; pressed, it shows that side's gutter (read-gutter.ts) and a
// reading starts from the block whose button is pressed. One side is open and read at a time.
// Released, the gutter goes and the reading stops. A side can be read only while its text is shown
// in its view, so not the source in its Raw text box. What is spoken comes from `speechSegments`:
// the parsed Markdown when the text is shown rendered, never its raw markers. The block being read
// is shaded in the view (in Raw, each of its lines). Voice and speed are shared by both sides.
// The audio is the `SpeechBuffer`'s business and playback the `SpeechPlayer`'s (speech.ts); this
// module only starts and stops them and shows where they are.
//
// What the page knows and this module does not (which text a side holds, whether it is shown as
// Markdown, the panes' elements) comes in through `SpeechUiDeps`. What the controls look like
// follows `state` (state.ts), so `refresh` is what `render()` runs after it writes the rest.

import type { VoiceList } from "../src/api.ts";
import { API, failureMessage, failureOf } from "./api.ts";
import type { MetaLine } from "./elements/meta-line.ts";
import type { SpeechControls } from "./elements/speech-controls.ts";
import type { SampleDetail, VoiceSettings } from "./elements/voice-settings.ts";
import { parseLines } from "./markdown.ts";
import { OPUS_TYPE, opusDecodable } from "./opus.ts";
import { giveUpQoa, QOA_TYPE, qoaDecoder, QoaError } from "./qoa.ts";
import { ReadGutter } from "./read-gutter.ts";
import type { SentenceBoundaries } from "./segment.ts";
import type { SpeechAudio } from "./speech-audio.ts";
import { type BoundaryLookup, canSpeak, type Segment, speechSegments, speechTexts } from "./speech-text.ts";
import { SpeechPlayer, type SpeechSettings } from "./speech.ts";
import { setState, type Side, state } from "./state.ts";
import { audioToWav, uploadVoice } from "./voice-sample.ts";

const SIDES: Side[] = ["source", "output"];
const SIDE_NAME: Record<Side, string> = { source: "source text", output: "translation" };

/** Events (focus, visibility) can come in bursts; a passive re-check is at most this often. */
const VOICES_RECHECK_MS = 3000;
/** A gutter button is named after this many characters of its block. */
const LABEL_CHARS = 48;
/**
 * How long a reading waits for the server's sentence boundaries of the block it starts with (the first
 * request also loads the model); after that it is cut by `Intl.Segmenter` alone.
 */
const SEGMENT_WAIT_MS = 1500;

/** What a side's text is read as: its pieces, and each block that has any with its lines. */
interface Reading {
  key: string;
  segments: Segment[];
  /** Per block: the first line, the line after its last one, its first piece and its name. */
  blocks: { line: number; end: number; index: number; label: string }[];
}

function readingOf(text: string, markdown: boolean, lang: string, boundaries?: BoundaryLookup): Reading {
  const segments = speechSegments(text, markdown, lang, boundaries);
  const lines = text.split("\n");
  // Where each block of the text starts, also the blocks that are not read (code): a block ends
  // where the next one starts. Plain text is read line by line.
  const starts = markdown ? parseLines(lines).map((b) => b.line) : null;
  const blocks: Reading["blocks"] = [];
  segments.forEach((s, index) => {
    if (blocks.at(-1)?.line === s.line) {
      return;
    }
    const end = starts ? (starts.find((l) => l > s.line) ?? lines.length) : s.line + 1;
    const label = s.text.length > LABEL_CHARS ? `${s.text.slice(0, LABEL_CHARS).trimEnd()}…` : s.text;
    blocks.push({ line: s.line, end, index, label });
  });
  return { key: `${lang}\n${markdown}\n${text}`, segments, blocks };
}

/** The top-level elements of `view` that show lines `line` to `end` (exclusive) and hold any text. */
function elementsOf(view: HTMLElement, line: number, end: number): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const child of view.children) {
    if (!(child instanceof HTMLElement) || child.dataset.line === undefined) {
      continue;
    }
    const at = Number(child.dataset.line);
    if (at >= end) {
      break;
    }
    if (at >= line && child.textContent.trim()) {
      out.push(child);
    }
  }
  return out;
}

export interface SpeechUiDeps {
  controls: Record<Side, SpeechControls>;
  voiceSettings: VoiceSettings;
  /** The "Reading aloud" settings, hidden until the server has answered about voices. */
  settingsPanel: HTMLElement;
  meta: MetaLine;
  /** Each side's rendered view and the scroller around it. */
  panes: Record<Side, { view: HTMLElement; area: HTMLElement }>;
  /** What the side holds now and the language it is in; `undefined` when that is not known. */
  target(side: Side): { text: string; lang: string | undefined };
  /** Whether the side is shown as rendered Markdown, which is then read as such. */
  isMarkdown(side: Side): boolean;
  /** Whether the side's text is in its view (`panes[side].view`), not in the source's text box. */
  shown(side: Side): boolean;
  /** The sentence boundaries the server has told, shared with the rest of the page. */
  boundaries: SentenceBoundaries;
}

export interface SpeechUi {
  /** Writes the Read aloud toggles from the state and the player. */
  refresh(): void;
  /** Shades the block being read and lays out the gutter; scrolls the pane to the block when asked. */
  showSpeaking(scroll?: boolean): void;
  /** Stops the reading and hides the gutter, of one side or of both. */
  stop(side?: Side): void;
  /** Asks the server for the voices and brings the buttons and the list in line with the answer. */
  loadVoices(): Promise<void>;
  /** On focus or visibility: look again only when reading aloud is not working, and not in a burst. */
  recheck(): void;
  /** Asks the server for the sentence boundaries of both sides' texts, to be there when a reading starts. */
  prefetch(): void;
}

/** One request for a piece; Opus and QOA are asked for with `Accept`, WAV is what a request without it gets. */
async function requestSpeech(
  text: string,
  settings: SpeechSettings,
  signal: AbortSignal,
  accept: string | undefined,
): Promise<Response> {
  const res = await fetch(`${API}/speech`, {
    method: "POST",
    headers: accept ? { "content-type": "application/json", accept } : { "content-type": "application/json" },
    body: JSON.stringify({ text, lang: settings.lang, voice: settings.voice || undefined, speed: settings.speed }),
    signal,
  });
  if (!res.ok) {
    throw await failureOf(res);
  }
  return res;
}

/**
 * The audio of a piece, in the best form this browser and the server have in common: Ogg Opus,
 * which the browser decodes itself, then QOA, decoded in a worker as it arrives, then WAV. The
 * server answers with the first it can; WAV when the browser has neither of the others (or
 * the codec failed on a stream: QOA is given up for the rest of the page's life).
 */
async function synthesize(text: string, settings: SpeechSettings, signal: AbortSignal): Promise<SpeechAudio> {
  const [opus, decoder] = await Promise.all([opusDecodable(), qoaDecoder()]);
  if (opus || decoder) {
    try {
      const accept = [opus && OPUS_TYPE, decoder && (opus ? `${QOA_TYPE};q=0.8` : QOA_TYPE), "audio/wav;q=0.5"];
      const res = await requestSpeech(text, settings, signal, accept.filter(Boolean).join(", "));
      if (decoder && res.body && res.headers.get("content-type")?.startsWith(QOA_TYPE)) {
        return await decoder.decode(res.body, signal);
      }
      return await res.arrayBuffer();
    } catch (e) {
      if (!(e instanceof QoaError)) {
        throw e;
      }
      // The codec, not the network or the engine, failed: ask again without it.
      console.error(e);
      giveUpQoa();
      return synthesize(text, settings, signal);
    }
  }
  return (await requestSpeech(text, settings, signal, undefined)).arrayBuffer();
}

export function initSpeechUi(deps: SpeechUiDeps): SpeechUi {
  const { controls, voiceSettings, settingsPanel, meta, panes } = deps;
  let voicesCheck: Promise<void> | null = null;
  let voicesCheckedAt = 0;
  let scrolledTo: string | null = null;
  /** The side whose Read aloud is pressed and whose gutter is shown. */
  let open: Side | null = null;
  const readings: Partial<Record<Side, Reading>> = {};
  /** The gutter and the labels go by `readings`, cut without the boundaries. */
  const { boundaries } = deps;
  /** What the player was started with: its pieces are the ones whose indexes `jumpTo` takes. */
  let playing: Reading | null = null;
  const gutters: Record<Side, ReadGutter> = {
    source: new ReadGutter(panes.source.area, `Read the ${SIDE_NAME.source} aloud from`, (l) => pick("source", l)),
    output: new ReadGutter(panes.output.area, `Read the ${SIDE_NAME.output} aloud from`, (l) => pick("output", l)),
  };

  /** What the side's text is read as now; the same object while the text, language and view are unchanged. */
  function reading(side: Side): Reading | null {
    const { text, lang } = deps.target(side);
    if (!lang) {
      return null;
    }
    const markdown = deps.isMarkdown(side);
    const key = `${lang}\n${markdown}\n${text}`;
    const known = readings[side];
    if (known?.key === key) {
      return known;
    }
    return (readings[side] = readingOf(text, markdown, lang));
  }

  const player = new SpeechPlayer(synthesize, {
    onState(playerState) {
      if (playerState === "idle" && state.speaking) {
        setState({ speaking: null });
      } else {
        refresh();
      }
    },
    onSegment(segment) {
      if (state.speaking) {
        setState({ speaking: { ...state.speaking, line: segment?.line ?? null } });
      }
      showSpeaking(true);
      refresh();
    },
    onError(e) {
      meta.flash(failureMessage(e));
      state.voicesStale = true;
    },
  });

  /** Why this side cannot be read aloud right now; empty when it can. */
  function blocked(side: Side): string {
    if (state.speechProblem) {
      return state.speechProblem;
    }
    const { text, lang } = deps.target(side);
    if (!text.trim()) {
      return `There is no ${SIDE_NAME[side]} to read aloud yet.`;
    }
    if (side === "output" && state.running) {
      return "The translation can be read aloud once it is finished.";
    }
    if (!lang) {
      return "Choose the language under From to have this text read aloud.";
    }
    if (!canSpeak(lang)) {
      return "Reading aloud is available for Chinese, English, Japanese, Spanish and Arabic.";
    }
    // Last: the one obstacle the reader removes with a click, once nothing else stands in the way.
    if (!deps.shown(side)) {
      return `Switch the ${SIDE_NAME[side]} to Preview to have it read aloud.`;
    }
    return "";
  }

  /** Hides the side's gutter; focus that was in it goes back to its Read aloud. */
  function close(side: Side) {
    if (open === side) {
      open = null;
    }
    if (gutters[side].hide()) {
      controls[side].focusToggle();
    }
  }

  function refresh() {
    // What opened the gutter may be gone (no voices any more, the text emptied): nothing to choose from.
    if (open && state.speaking?.side !== open && blocked(open)) {
      close(open);
    }
    for (const side of SIDES) {
      const mine = state.speaking?.side === side;
      controls[side].show({
        open: open === side,
        reading: mine,
        state: mine ? player.state : "idle",
        blocked: mine ? "" : blocked(side),
        canPrev: mine && player.canJump(-1),
        canNext: mine && player.canJump(1),
      });
    }
  }

  /** Builds or places the open side's gutter for its view as it is now. */
  function showGutter() {
    if (!open) {
      return;
    }
    const r = reading(open);
    const { view } = panes[open];
    const blocks = (r?.blocks ?? []).map(({ line, end, label }) => ({
      line,
      label,
      elements: elementsOf(view, line, end),
    }));
    gutters[open].show(blocks, state.speaking?.side === open ? state.speaking.line : null);
  }

  function showSpeaking(scroll = false) {
    for (const el of document.querySelectorAll(".output .speaking")) {
      el.classList.remove("speaking");
      el.removeAttribute("aria-current");
    }
    showGutter();
    const { speaking } = state;
    if (!speaking) {
      scrolledTo = null;
    }
    if (speaking?.line == null) {
      return;
    }
    const { view, area } = panes[speaking.side];
    const block = reading(speaking.side)?.blocks.find((b) => b.line === speaking.line);
    const elements = block ? elementsOf(view, block.line, block.end) : [];
    if (elements.length === 0) {
      return;
    }
    for (const el of elements) {
      el.classList.add("speaking");
    }
    // Named once for assistive technology: the block, or its first line in Raw.
    elements[0]!.setAttribute("aria-current", "true");
    if (!scroll) {
      return;
    }
    const pane = area.getBoundingClientRect();
    const box = {
      top: elements[0]!.getBoundingClientRect().top,
      bottom: elements.at(-1)!.getBoundingClientRect().bottom,
    };
    // A later piece of the block already being followed may sit anywhere in it, and a block taller
    // than the pane would be pulled back to its top each time; only a block that left the pane
    // entirely is brought back.
    const key = `${speaking.side}:${speaking.line}`;
    const sameBlock = scrolledTo === key;
    scrolledTo = key;
    const outside = box.top < pane.top || box.bottom > pane.bottom;
    const hidden = box.bottom <= pane.top || box.top >= pane.bottom;
    if (sameBlock ? hidden : outside) {
      area.scrollTop += box.top - pane.top - 8;
    }
  }

  /** Read aloud: shows the side's gutter and puts focus in it, or hides it and stops the reading. */
  function toggle(side: Side) {
    if (open === side) {
      stop(side);
      return;
    }
    const reason = blocked(side);
    if (reason) {
      meta.flash(reason);
      // Reading aloud may have become available since the page loaded.
      if (state.speechProblem) {
        void recheckNow(true);
      }
      return;
    }
    // After a failure the voice list may be out of date; the reading goes on with what is selected.
    if (state.voicesStale) {
      void loadVoices();
    }
    // Read as it is shown: rendered Markdown when the text looks like Markdown, else line by line.
    if (!reading(side)?.segments.length) {
      meta.flash("There is nothing to read aloud in this text.");
      return;
    }
    for (const other of SIDES) {
      if (other !== side) {
        stop(other);
      }
    }
    open = side;
    showGutter();
    refresh();
    gutters[side].focus();
  }

  /** A gutter button: reads from that block, or jumps there when the side is being read. */
  function pick(side: Side, line: number) {
    const r = reading(side);
    if (!r?.blocks.some((b) => b.line === line)) {
      return;
    }
    if (state.speaking?.side === side && player.state !== "idle") {
      const index = playing?.blocks.find((b) => b.line === line)?.index;
      if (index !== undefined && player.jumpTo(index)) {
        sayWhere();
        refresh();
      }
      return;
    }
    const reason = blocked(side);
    if (reason) {
      meta.flash(reason);
      return;
    }
    // After a failure the voice list may be out of date; the reading goes on with what is selected.
    if (state.voicesStale) {
      void loadVoices();
    }
    player.stop();
    setState({ speaking: { side, line } });
    showSpeaking();
    const { text, lang } = deps.target(side);
    const markdown = deps.isMarkdown(side);
    const settings = { lang: lang!, voice: voiceSettings.voice, speed: Number(voiceSettings.speed) };

    // The block being started is asked for first, the others follow. What the server has said by the
    // time the block's own answer is in (or has been waited for) cuts the pieces; the rest, `Intl.Segmenter`.
    const texts = speechTexts(text, markdown, lang!);
    const own = texts.filter((t) => t.line === line).map((t) => t.text);
    boundaries.request(own, true);
    boundaries.request(texts.map((t) => t.text));
    const plan = () => {
      playing = boundaries.available ? readingOf(text, markdown, lang!, boundaries.get) : r;
      return { segments: playing.segments, from: playing.blocks.find((b) => b.line === line)?.index ?? -1 };
    };
    if (boundaries.allSettled(own)) {
      const { segments, from } = plan();
      player.start(segments, settings, from);
    } else {
      // Not through an await before `start`: the audio must be unlocked inside the click.
      player.startWhenPlanned(boundaries.ready(own, SEGMENT_WAIT_MS).then(plan), settings);
    }
  }

  /** Says which block is read after a jump, since the shaded block may be out of view. */
  function sayWhere() {
    const at = player.position();
    if (at) {
      meta.flash(`Block ${at.block} of ${at.blocks}`);
    }
  }

  function jump(direction: -1 | 1) {
    if (!player.jump(direction)) {
      return;
    }
    sayWhere();
    refresh();
  }

  function stop(side?: Side) {
    if (state.speaking && (side === undefined || state.speaking.side === side)) {
      player.stop();
    }
    for (const s of SIDES) {
      if (side === undefined || s === side) {
        close(s);
      }
    }
    refresh();
  }

  function loadVoices(): Promise<void> {
    voicesCheck ??= (async () => {
      try {
        const res = await fetch(`${API}/voices`);
        const body = (await res.json()) as Pick<VoiceList, "status" | "error" | "voices">;
        if (body.status === "unavailable") {
          state.speechProblem = `Reading aloud is not available: ${body.error ?? "it is not installed"}.`;
        } else {
          state.speechProblem =
            body.voices.length === 0
              ? "Reading aloud needs a voice: upload or record a sample under Model and options."
              : "";
          // The voice being read with is gone: the next piece uses the one now selected.
          if (voiceSettings.setVoices(body.voices)) {
            player.update({ voice: voiceSettings.voice });
          }
          settingsPanel.hidden = false;
        }
        state.voicesStale = false;
      } catch {
        state.speechProblem = "Reading aloud is not available: the server cannot be reached.";
      }
      voicesCheckedAt = Date.now();
      refresh();
    })().finally(() => void (voicesCheck = null));
    return voicesCheck;
  }

  function recheck() {
    if (!state.speechProblem && !state.voicesStale) {
      return;
    }
    if (Date.now() - voicesCheckedAt < VOICES_RECHECK_MS) {
      return;
    }
    void loadVoices();
  }

  /** The person tried to use reading aloud while it was blocked or after it failed: look again now. */
  async function recheckNow(announce: boolean) {
    const had = state.speechProblem;
    await loadVoices();
    if (announce && had && !state.speechProblem) {
      meta.flash("Reading aloud is available now. Press Read aloud to start.");
    }
  }

  /** Adds an uploaded voice to the list, selects it and tells the player. */
  async function addSampleVoice({ name, audio }: SampleDetail) {
    // The server may first take the voice out of music and noise, which takes a few seconds.
    voiceSettings.status = "Processing the sample…";
    try {
      const voice = await uploadVoice(API, name, await audioToWav(audio));
      voiceSettings.addVoice(voice);
      player.update({ voice: voice.id });
      setState({ speechProblem: "" });
      voiceSettings.status = `Voice "${voice.name}" added. It is kept until the server stops.`;
    } catch (e) {
      voiceSettings.status = e instanceof Error ? e.message : String(e);
    }
  }

  for (const side of SIDES) {
    const c = controls[side];
    c.addEventListener("listen", () => toggle(side));
    c.addEventListener("prev", () => jump(-1));
    c.addEventListener("next", () => jump(1));
    c.addEventListener("pause", () => {
      if (player.state === "paused") {
        player.resume();
      } else {
        player.pause();
      }
    });
  }
  voiceSettings.addEventListener("voicechange", () => {
    player.update({ voice: voiceSettings.voice });
    if (state.speechProblem || state.voicesStale) {
      void recheckNow(false);
    }
  });
  voiceSettings.addEventListener("speedchange", () => {
    player.update({ speed: Number(voiceSettings.speed) });
    if (state.speechProblem || state.voicesStale) {
      void recheckNow(false);
    }
  });
  voiceSettings.addEventListener("sample", (e) => void addSampleVoice((e as CustomEvent<SampleDetail>).detail));

  /** Asks for the sentence boundaries of what both sides read, after what is already waiting. */
  function prefetch() {
    for (const side of SIDES) {
      const { text, lang } = deps.target(side);
      if (canSpeak(lang)) {
        boundaries.request(speechTexts(text, deps.isMarkdown(side), lang).map((t) => t.text));
      }
    }
  }

  return { refresh, showSpeaking, stop, loadVoices, recheck, prefetch };
}
