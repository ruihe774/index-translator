// The player's caption tracks (captions.ts makes their cues), offered in the video's own menu (⋮ →
// Captions in Chromium), and shown also in full screen, where the cue table is not.
//
// Each is a `<track>` whose file is an empty WebVTT Blob, its cues added by script once that has loaded
// (cues added before are dropped by the load), so they follow a transcription or a translation as it
// streams. Not `addTextTrack()`: its tracks can never be taken out of the menu or renamed, and a track
// with no file fails to load and shows nothing. A track that is disabled does not load its file, so its
// cues wait until the reader picks it.
//
// The original shows by default, both languages once there is a translation; a track the reader picks
// in the menu (or Off) is kept while it exists.

import type { Caption } from "./captions.ts";

export type CaptionId = "original" | "translation" | "both";

export interface CaptionSet {
  id: CaptionId;
  label: string;
  lang: string | undefined;
  cues: Caption[];
}

interface Track {
  el: HTMLTrackElement;
  label: string;
  lang: string | undefined;
  loaded: boolean;
  /** What should be shown, added once the file has loaded. */
  cues: Caption[];
  /** What is, by start, end and text. */
  shown: Map<string, VTTCue>;
}

let emptyFile: string | undefined;

const keyOf = (c: Caption) => `${c.start} ${c.end} ${c.text}`;

/** Brings the track's cues in line with what it should show, leaving the unchanged ones. */
function syncCues(t: Track) {
  if (!t.loaded) {
    return;
  }
  const wanted = new Map(t.cues.map((c) => [keyOf(c), c]));
  for (const [key, cue] of t.shown) {
    if (!wanted.has(key)) {
      t.el.track.removeCue(cue);
      t.shown.delete(key);
    }
  }
  for (const [key, c] of wanted) {
    if (!t.shown.has(key)) {
      const cue = new VTTCue(c.start, c.end, c.text);
      t.el.track.addCue(cue);
      t.shown.set(key, cue);
    }
  }
}

export class CaptionTracks {
  private readonly tracks = new Map<CaptionId, Track>();
  /** The track shown when the modes were last set here (null: none). */
  private applied: CaptionId | null = null;
  /** What the reader picked in the menu: a track, or null for Off. */
  private picked: CaptionId | null | undefined;

  constructor(private readonly video: HTMLVideoElement) {
    video.textTracks.addEventListener("change", () => {
      const showing = this.showing();
      if (showing !== this.applied) {
        this.picked = showing;
        this.applied = showing;
      }
      // Picked from Off or Disabled: its file loads now, and its cues are added then.
    });
  }

  /** Makes the tracks these sets, in this order: a track no set names goes, a renamed one is made again. */
  update(sets: CaptionSet[]) {
    let changed = false;
    for (const [id, t] of this.tracks) {
      const set = sets.find((s) => s.id === id);
      if (set?.label !== t.label || set.lang !== t.lang) {
        t.el.remove();
        this.tracks.delete(id);
        changed = true;
      }
    }
    for (const set of sets) {
      let t = this.tracks.get(set.id);
      if (!t) {
        t = this.create(set);
        this.tracks.set(set.id, t);
        changed = true;
      }
      t.cues = set.cues;
      syncCues(t);
    }
    if (changed) {
      this.apply();
    }
  }

  private create(set: CaptionSet): Track {
    const el = document.createElement("track");
    el.kind = "subtitles";
    el.label = set.label;
    if (set.lang) {
      el.srclang = set.lang;
    }
    emptyFile ??= URL.createObjectURL(new Blob(["WEBVTT\n"], { type: "text/vtt" }));
    el.src = emptyFile;
    const t: Track = { el, label: set.label, lang: set.lang, loaded: false, cues: [], shown: new Map() };
    el.addEventListener("load", () => {
      t.loaded = true;
      syncCues(t);
    });
    this.video.append(el);
    return t;
  }

  /** Shows the reader's pick while it exists, else both languages when there are, else the original. */
  private apply() {
    const want =
      this.picked !== undefined && (this.picked === null || this.tracks.has(this.picked))
        ? this.picked
        : this.tracks.has("both")
          ? "both"
          : this.tracks.has("original")
            ? "original"
            : null;
    for (const [id, t] of this.tracks) {
      // Hidden, not disabled: a disabled track does not load its file.
      t.el.track.mode = id === want ? "showing" : "hidden";
    }
    this.applied = want;
  }

  private showing(): CaptionId | null {
    for (const [id, t] of this.tracks) {
      if (t.el.track.mode === "showing") {
        return id;
      }
    }
    return null;
  }
}
