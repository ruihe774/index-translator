// The player above a transcript: the recording or video it was made from, while the source box holds
// that transcript (from the start of a transcription until another text, Clear or a kept translation
// takes its place). What it plays is media-player.ts's choice: the opened file, with only the
// transcribed audio track left, or, when this browser cannot play that from the file (or the file
// fails to load), the recording sent to the server, audio only, once it is ready. A video whose
// picture this browser cannot decode plays as audio, its picture box shrunk to the controls.
//
// The cue at the playhead is marked in the source preview (`cue-playing`, `aria-current="time"`) and,
// where the translation's cues are matched, in the translation; while playing, the source pane
// follows it unless the reader scrolls. A column of "play from here" buttons (read-gutter.ts) beside
// the cues is the way to a cue from the keyboard; the source's Read aloud gutter takes its place
// while that is pressed. Playing stops reading aloud and the reverse.

import { lineElements } from "./dom.ts";
import type { MediaProbe, Recording } from "./media-file.ts";
import { cueAt, playbackOf } from "./media-player.ts";
import { type Alignment, counterpart } from "./paragraphs.ts";
import { type GutterBlock, ReadGutter } from "./read-gutter.ts";
import { clock, type Cue, parseSrt, shownText, speakerColumn, splitSpeakers } from "./subtitles.ts";

/** A file that has not said what it holds by then is taken as one this browser cannot play. */
const LOAD_TIMEOUT_MS = 10_000;
/** A button is named after this many characters of its cue. */
const LABEL_CHARS = 48;
const PLAYING = "cue-playing";

export interface MediaUiDeps {
  /** Where the player goes, above the source box. */
  box: HTMLElement;
  /** The source box's field, laid out for the player while there is one (`with-media`). */
  field: HTMLElement;
  /** The source preview and the scroller around it. */
  source: { view: HTMLElement; area: HTMLElement };
  /** The translation's view. */
  output: HTMLElement;
  /** The transcript as the source box holds it now. */
  text(): string;
  /** Whether the source is shown in its preview, not its Raw text box. */
  shown(): boolean;
  /** Whether the source's Read aloud gutter is shown, which takes this one's place. */
  readGutterOpen(): boolean;
  /** Which blocks of the source and the translation match, when known. */
  alignment(): Alignment | null;
  /** The player started: other sound stops, and the source no longer follows a transcription's end. */
  playing(): void;
}

export interface MediaUi {
  /** A file whose `track` is being transcribed: plays it, or waits for the recording. */
  open(file: File, probe: MediaProbe, track: number): void;
  /** The recording sent to the server, played when the file cannot be. */
  recording(r: Recording): void;
  /** Takes the player away. */
  close(): void;
  /** After the source or translation view was rebuilt, or a Read aloud gutter came or went. */
  refresh(): void;
  pause(): void;
}

const canPlay = (type: string) => document.createElement("audio").canPlayType(type) !== "";

export function initMediaUi(d: MediaUiDeps): MediaUi {
  const { box, field, source } = d;
  let el: HTMLMediaElement | null = null;
  let url: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** `file`: the opened file is played; `waiting`: the recording will be; `recording`: it is. */
  let mode: "file" | "waiting" | "recording" | null = null;
  /** The file has said what it holds. */
  let loaded = false;
  /** The recording, kept while the file might still fail to load. */
  let held: Recording | null = null;
  /** Seconds into the file at which what is played starts (the recording's `offset`). */
  let offset = 0;
  let name = "";
  /** The line of the cue at the playhead. */
  let current: number | null = null;
  /** While playing, the source pane keeps the cue in view, until the reader scrolls it. */
  let follow = true;
  let parsed: { text: string; cues: Cue[] } = { text: "", cues: [] };
  const gutter = new ReadGutter(source.area, "Play the recording from", pick, "Play from");

  for (const type of ["wheel", "touchmove"]) {
    source.area.addEventListener(type, () => void (follow = false), { passive: true });
  }
  // The preview builds its rows on the next frame, also after it was told the text: they are looked
  // for again once they change.
  let frame = 0;
  new MutationObserver(() => {
    if (el && !frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    }
  }).observe(source.view, { childList: true, subtree: true });

  function cues(): Cue[] {
    const text = d.text();
    if (parsed.text !== text) {
      parsed = { text, cues: parseSrt(text) ?? [] };
    }
    return parsed.cues;
  }

  function unmount() {
    clearTimeout(timer);
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
      el = null;
    }
    if (url) {
      URL.revokeObjectURL(url);
      url = null;
    }
    loaded = false;
    box.replaceChildren();
  }

  function show(...children: Node[]) {
    box.replaceChildren(...children);
    box.hidden = false;
    field.classList.add("with-media");
  }

  function hide() {
    box.replaceChildren();
    box.hidden = true;
    field.classList.remove("with-media");
  }

  function mount(body: Blob, video: boolean, start: number, label: string) {
    unmount();
    const player = document.createElement(video ? "video" : "audio");
    player.controls = true;
    player.preload = "metadata";
    player.setAttribute("aria-label", label);
    url = URL.createObjectURL(body);
    player.src = url;
    offset = start;
    el = player;
    player.addEventListener("loadedmetadata", () => {
      if (el !== player) {
        return;
      }
      loaded = true;
      clearTimeout(timer);
      if (player instanceof HTMLVideoElement && player.videoWidth === 0) {
        player.classList.add("audio-only");
      }
      if (mode === "file") {
        held = null;
      }
    });
    player.addEventListener("error", () => {
      if (el === player) {
        fail();
      }
    });
    player.addEventListener("play", () => {
      follow = true;
      d.playing();
      mark(true);
    });
    for (const type of ["timeupdate", "seeked"]) {
      player.addEventListener(type, () => mark(true));
    }
    timer = setTimeout(() => el === player && !loaded && fail(), LOAD_TIMEOUT_MS);
    show(player);
    refresh();
  }

  function playRecording(r: Recording) {
    mode = "recording";
    held = null;
    mount(r.body, false, r.offset, `Transcribed audio of ${name}`);
  }

  /** What is played cannot be: the recording takes the file's place, or the player says it cannot play. */
  function fail() {
    unmount();
    if (mode === "file" && held) {
      playRecording(held);
    } else if (mode === "file" && !loaded) {
      mode = "waiting";
      hide();
    } else {
      mode = null;
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = `This browser cannot play ${name}.`;
      show(p);
    }
    refresh();
  }

  /** The cue at the playhead: marked in both views, its button current, followed while playing. */
  function mark(scroll = false) {
    const line = el && mode ? cueAt(cues(), (el.currentTime + offset) * 1000) : null;
    if (line === current) {
      return;
    }
    current = line;
    paint();
    showGutter();
    if (scroll && follow && el && !el.paused) {
      reveal();
    }
  }

  function paint() {
    for (const view of [source.view, d.output]) {
      for (const row of view.querySelectorAll(`.${PLAYING}`)) {
        row.classList.remove(PLAYING);
        row.removeAttribute("aria-current");
      }
    }
    if (current === null) {
      return;
    }
    for (const row of lineElements(source.view)) {
      if (Number(row.dataset.line) === current) {
        row.classList.add(PLAYING);
        row.setAttribute("aria-current", "time");
      }
    }
    const a = d.alignment();
    const match = a && counterpart(a, "source", current);
    if (match) {
      for (const row of lineElements(d.output)) {
        const line = Number(row.dataset.line);
        if (line >= match.other.from && line < match.other.to) {
          row.classList.add(PLAYING);
        }
      }
    }
  }

  /** Scrolls the source pane to the marked cue when it is out of view. */
  function reveal() {
    const row = source.view.querySelector<HTMLElement>(`.${PLAYING}`);
    if (!row || source.area.hidden) {
      return;
    }
    const pane = source.area.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    if (at.top < pane.top || at.bottom > pane.bottom) {
      source.area.scrollTop += at.top - pane.top - 8;
    }
  }

  function showGutter() {
    if (!el || !d.shown() || d.readGutterOpen()) {
      gutter.hide();
      return;
    }
    const rows = new Map(lineElements(source.view).map((row) => [Number(row.dataset.line), row]));
    const blocks: GutterBlock[] = [];
    // Named as the row shows the cue: without the speaker labels of a Speaker column, or tags.
    const speakers = speakerColumn(cues());
    for (const cue of cues()) {
      const row = rows.get(cue.line);
      const said = shownText(speakers ? splitSpeakers(cue.lines).lines : cue.lines)
        .replaceAll(/\s+/g, " ")
        .trim();
      if (!row || !said) {
        continue;
      }
      const words = said.length > LABEL_CHARS ? `${said.slice(0, LABEL_CHARS).trimEnd()}…` : said;
      blocks.push({ line: cue.line, label: `${clock(cue.start)} ${words}`, elements: [row] });
    }
    gutter.show(blocks, current);
  }

  /** A gutter button: plays from its cue. */
  function pick(line: number) {
    const cue = cues().find((c) => c.line === line);
    if (!el || !cue) {
      return;
    }
    el.currentTime = Math.max(0, cue.start / 1000 - offset);
    follow = true;
    el.play().catch(() => {
      // Not playable after all: the error event says so.
    });
  }

  function refresh() {
    paint();
    showGutter();
  }

  function close() {
    unmount();
    hide();
    mode = null;
    held = null;
    current = null;
    gutter.hide();
    paint();
  }

  return {
    open(file, probe, track) {
      close();
      ({ name } = file);
      const playback = playbackOf(file, probe, track, canPlay);
      if (playback.kind === "file") {
        mode = "file";
        mount(playback.body, playback.video, 0, `Recording: ${name}`);
      } else {
        mode = "waiting";
      }
    },
    recording(r) {
      if (mode === "waiting") {
        playRecording(r);
      } else if (mode === "file" && !loaded) {
        held = r;
      }
    },
    close,
    refresh,
    pause() {
      el?.pause();
    },
  };
}
