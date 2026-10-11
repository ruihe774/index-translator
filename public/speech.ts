// Plays a text aloud: fetches the audio of one piece at a time from the speech API and plays the
// pieces in order through Web Audio, with pause, resume and a change of voice or speed on the way.
//
// One request is in flight at a time: the piece after the one being played is fetched while it
// plays, which keeps ahead because synthesis is several times faster than speech. Speed is the
// model's own duration control, not a faster playback, so a change of speed or voice is heard from
// the start of the current piece, which is synthesized again.

import type { Segment } from "./speech-text.js";

export type PlayerState = "idle" | "loading" | "playing" | "paused";

export interface SpeechSettings {
  lang: string;
  voice: string;
  speed: number;
}

/** The audio file (WAV) of one piece. */
export type Synthesize = (text: string, settings: SpeechSettings, signal: AbortSignal) => Promise<ArrayBuffer>;

export interface PlayerHooks {
  onState(state: PlayerState): void;
  /** The piece that starts playing, or null when nothing is being read any more. */
  onSegment(segment: Segment | null): void;
  /** Synthesis or playback failed; the player has stopped. */
  onError(error: unknown): void;
}

export class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private segments: Segment[] = [];
  private settings: SpeechSettings = { lang: "", voice: "", speed: 1 };
  private index = 0;
  /** Counts up whenever what should be heard changes; work started for an earlier count is dropped. */
  private run = 0;
  private abort = new AbortController();
  private buffers = new Map<number, Promise<AudioBuffer>>();
  /** Pieces whose audio has arrived: going on to one of them is not "loading". */
  private loaded = new Set<number>();
  private source: AudioBufferSourceNode | null = null;
  private paused = false;
  private active = false;
  state: PlayerState = "idle";

  constructor(
    private synthesize: Synthesize,
    private hooks: PlayerHooks,
  ) {}

  /** Must be called from a click (or key) handler: browsers only let a page start audio then. */
  start(segments: Segment[], settings: SpeechSettings): void {
    this.stop();
    if (segments.length === 0) return;
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
    this.segments = segments;
    this.settings = settings;
    this.active = true;
    void this.play(0, 0);
  }

  pause(): void {
    if (!this.active || this.paused) return;
    this.paused = true;
    // Suspending stops the clock too, so a piece scheduled after a silence stays that far away.
    void this.ctx?.suspend();
    this.refresh();
  }

  resume(): void {
    if (!this.active || !this.paused) return;
    this.paused = false;
    void this.ctx?.resume();
    this.refresh();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.paused = false;
    this.cancel();
    this.hooks.onSegment(null);
    this.refresh();
  }

  /** A new voice or speed; while reading, the current piece starts again with it. */
  update(settings: Partial<SpeechSettings>): void {
    this.settings = { ...this.settings, ...settings };
    if (!this.active) return;
    this.cancel();
    void this.play(this.index, 0);
  }

  private cancel(): void {
    this.run++;
    this.abort.abort();
    this.abort = new AbortController();
    this.buffers.clear();
    this.loaded.clear();
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // it had already ended
      }
      this.source = null;
    }
  }

  private refresh(): void {
    const state: PlayerState = !this.active ? "idle" : this.paused ? "paused" : this.source ? "playing" : "loading";
    if (state === this.state) return;
    this.state = state;
    this.hooks.onState(state);
  }

  private load(i: number): Promise<AudioBuffer> {
    let buffer = this.buffers.get(i);
    if (!buffer) {
      const run = this.run;
      buffer = this.synthesize(this.segments[i]!.text, this.settings, this.abort.signal)
        .then((wav) => this.ctx!.decodeAudioData(wav))
        .then((audio) => {
          if (run === this.run) this.loaded.add(i);
          return audio;
        });
      // Awaited by play(); a prefetch nobody waits for must not become an unhandled rejection.
      buffer.catch(() => {});
      this.buffers.set(i, buffer);
    }
    return buffer;
  }

  private async play(i: number, delayMs: number): Promise<void> {
    const run = this.run;
    const ctx = this.ctx!;
    this.index = i;
    if (i >= this.segments.length) {
      this.stop();
      return;
    }
    // The silence after the previous piece runs on the audio clock, which a pause stops.
    const startAt = ctx.currentTime + delayMs / 1000;
    if (!this.loaded.has(i)) this.source = null;
    this.refresh();

    let buffer: AudioBuffer;
    try {
      buffer = await this.load(i);
    } catch (e) {
      if (run !== this.run) return;
      this.stop();
      this.hooks.onError(e);
      return;
    }
    if (run !== this.run) return;
    this.buffers.delete(i - 1);
    if (i + 1 < this.segments.length) void this.load(i + 1);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (run !== this.run) return;
      void this.play(i + 1, this.segments[i]!.pause);
    };
    source.start(Math.max(startAt, ctx.currentTime));
    this.source = source;
    this.hooks.onSegment(this.segments[i]!);
    this.refresh();
  }
}
