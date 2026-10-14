// Reading aloud, as the page sees it: the Listen buttons of both panels, the voice list, the block
// being read, and what a reading does to the page.
//
// Each side has a Listen button; one side is read at a time. What is spoken comes from
// `speechSegments`: the parsed Markdown when the text is shown rendered, never its raw markers.
// The block being read is shaded in the rendered view. Voice and speed are shared by both sides.
// The audio is the `SpeechBuffer`'s business and playback the `SpeechPlayer`'s (speech.ts); this
// module only starts and stops them and shows where they are.
//
// What the page knows and this module does not (which text a side holds, whether it is shown as
// Markdown, the panes' elements) comes in through `SpeechUiDeps`. What the controls look like
// follows `state` (state.ts), so `refresh` is what `render()` runs after it writes the rest.

import { API, ApiFailure, failureMessage } from "./api.ts";
import type { MetaLine } from "./elements/meta-line.ts";
import type { SpeechControls } from "./elements/speech-controls.ts";
import type { SampleDetail, VoiceSettings } from "./elements/voice-settings.ts";
import type { ApiErrorBody } from "./errors.ts";
import { giveUpQoa, QOA_TYPE, qoaDecoder, QoaError } from "./qoa.ts";
import type { SpeechAudio } from "./speech-audio.ts";
import { canSpeak, speechSegments } from "./speech-text.ts";
import { SpeechPlayer, type SpeechSettings } from "./speech.ts";
import { setState, type Side, state } from "./state.ts";
import { store, stored } from "./storage.ts";
import { audioToWav, uploadVoice } from "./voice-sample.ts";

const SIDES: Side[] = ["source", "output"];
const SIDE_NAME: Record<Side, string> = { source: "source text", output: "translation" };

/** Events (focus, visibility) can come in bursts; a passive re-check is at most this often. */
const VOICES_RECHECK_MS = 3000;

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
}

export interface SpeechUi {
  /** Writes the Listen buttons from the state and the player. */
  refresh(): void;
  /** Shades the block being read, and scrolls its pane to it when asked. */
  showSpeaking(scroll?: boolean): void;
  /** Stops the reading, of one side or of whichever is read. */
  stop(side?: Side): void;
  /** Asks the server for the voices and brings the buttons and the list in line with the answer. */
  loadVoices(): Promise<void>;
  /** On focus or visibility: look again only when reading aloud is not working, and not in a burst. */
  recheck(): void;
}

/** One request for a piece; a QOA stream is asked for with `Accept`, WAV is what a request without it gets. */
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
    const payload = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
    throw new ApiFailure(payload?.error ?? {}, res.status);
  }
  return res;
}

/**
 * The audio of a piece. QOA is the default: the response is decoded in a worker as it arrives.
 * WAV when the browser cannot run the codec, when the server answers with WAV (it has no codec),
 * and for the rest of the page's life once the codec has failed on a stream.
 */
async function synthesize(text: string, settings: SpeechSettings, signal: AbortSignal): Promise<SpeechAudio> {
  const decoder = await qoaDecoder();
  if (decoder) {
    try {
      const res = await requestSpeech(text, settings, signal, `${QOA_TYPE}, audio/wav;q=0.5`);
      if (res.body && res.headers.get("content-type")?.startsWith(QOA_TYPE)) {
        return await decoder.decode(res.body, signal);
      }
      return await res.arrayBuffer();
    } catch (e) {
      if (!(e instanceof QoaError)) {
        throw e;
      }
      // The codec, not the network or the engine, failed: ask again in a form the browser decodes itself.
      console.error(e);
      giveUpQoa();
    }
  }
  return (await requestSpeech(text, settings, signal)).arrayBuffer();
}

export function initSpeechUi(deps: SpeechUiDeps): SpeechUi {
  const { controls, voiceSettings, settingsPanel, meta, panes } = deps;
  let voicesCheck: Promise<void> | null = null;
  let voicesCheckedAt = 0;
  let scrolledTo: string | null = null;

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
    return "";
  }

  function refresh() {
    for (const side of SIDES) {
      const mine = state.speaking?.side === side;
      controls[side].show({
        reading: mine,
        state: mine ? player.state : "idle",
        blocked: mine ? "" : blocked(side),
        canPrev: mine && player.canJump(-1),
        canNext: mine && player.canJump(1),
      });
    }
  }

  function showSpeaking(scroll = false) {
    for (const el of document.querySelectorAll(".speaking")) {
      el.classList.remove("speaking");
      el.removeAttribute("aria-current");
    }
    const { speaking } = state;
    if (!speaking) {
      scrolledTo = null;
    }
    if (!speaking || speaking.line === null) {
      return;
    }
    const { view, area } = panes[speaking.side];
    const block = view.querySelector<HTMLElement>(`:scope > [data-line="${speaking.line}"]`);
    if (!block) {
      return;
    }
    block.classList.add("speaking");
    block.setAttribute("aria-current", "true");
    if (!scroll) {
      return;
    }
    const pane = area.getBoundingClientRect();
    const box = block.getBoundingClientRect();
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

  function toggle(side: Side) {
    if (state.speaking?.side === side) {
      player.stop();
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
    const { text, lang } = deps.target(side);
    // Read as it is shown: rendered Markdown when the text looks like Markdown, else line by line.
    const segments = speechSegments(text, deps.isMarkdown(side), lang!);
    if (segments.length === 0) {
      meta.flash("There is nothing to read aloud in this text.");
      return;
    }
    player.stop();
    setState({ speaking: { side, line: null } });
    player.start(segments, { lang: lang!, voice: voiceSettings.voice, speed: voiceSettings.speed });
  }

  /** Jumps a block back or forward and says where that is, since the shaded block may be out of view. */
  function jump(direction: -1 | 1) {
    if (!player.jump(direction)) {
      return;
    }
    const at = player.position();
    if (at) {
      meta.flash(`Block ${at.block} of ${at.blocks}`);
    }
    refresh();
  }

  function stop(side?: Side) {
    if (state.speaking && (side === undefined || state.speaking.side === side)) {
      player.stop();
    }
  }

  function loadVoices(): Promise<void> {
    voicesCheck ??= (async () => {
      try {
        const res = await fetch(`${API}/voices`);
        const body = (await res.json()) as {
          status: string;
          error?: string;
          voices: { id: string; name: string }[];
        };
        if (body.status === "unavailable") {
          state.speechProblem = `Reading aloud is not available: ${body.error ?? "it is not installed"}.`;
        } else {
          state.speechProblem =
            body.voices.length === 0
              ? "Reading aloud needs a voice: upload or record a sample under Model and options."
              : "";
          // The voice being read with is gone: the next piece uses the one now selected.
          if (voiceSettings.setVoices(body.voices, stored("voice"))) {
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
    })().finally(() => {
      voicesCheck = null;
    });
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
      meta.flash("Reading aloud is available now. Press Listen to start.");
    }
  }

  /** Adds an uploaded voice to the list, selects it and tells the player. */
  async function addSampleVoice({ name, audio }: SampleDetail) {
    // The server may first take the voice out of music and noise, which takes a few seconds.
    voiceSettings.status = "Processing the sample…";
    try {
      const voice = await uploadVoice(API, name, await audioToWav(audio));
      voiceSettings.addVoice(voice);
      store("voice", voice.id);
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
    store("voice", voiceSettings.voice);
    player.update({ voice: voiceSettings.voice });
    if (state.speechProblem || state.voicesStale) {
      void recheckNow(false);
    }
  });
  voiceSettings.addEventListener("speedchange", () => {
    store("speed", String(voiceSettings.speed));
    player.update({ speed: voiceSettings.speed });
    if (state.speechProblem || state.voicesStale) {
      void recheckNow(false);
    }
  });
  voiceSettings.addEventListener("sample", (e) => void addSampleVoice((e as CustomEvent<SampleDetail>).detail));
  voiceSettings.speed = stored("speed");

  return { refresh, showSpeaking, stop, loadVoices, recheck };
}
