// Plays a text aloud: plays the pieces in order through Web Audio, with pause, resume, jumps between
// blocks and a change of voice or speed on the way.
//
// Where the audio comes from is not this file's business: the pieces are taken from a SpeechBuffer
// (speech-buffer.ts), which makes them ahead of the reader and keeps them. The player only tells
// it where the reader is. Once the piece after the current one is there, it is scheduled on the
// audio clock right behind the current one, so the join is sample-accurate (plus the piece's
// pause) and does not wait for an event. Speed is the model's own duration control, not a faster
// playback, so a change of speed or voice is heard from the start of the current piece, and all
// audio is made again.

import { type SpeechAudio, splitChannels } from "./speech-audio.ts";
import { blockStarts, SpeechBuffer, type SpeechSettings, type Synthesize } from "./speech-buffer.ts";
import type { Segment } from "./speech-text.ts";

export type { SpeechSettings, Synthesize };

/**
 * How long a change of voice or speed waits for another before audio is requested with it: moving
 * through the speed list must not start an utterance for every step.
 */
export const UPDATE_SETTLE_MS = 300;

export type PlayerState = "idle" | "loading" | "playing" | "paused";

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
  private readonly buffer: SpeechBuffer;
  private source: AudioBufferSourceNode | null = null;
  /** The piece after the current one, already scheduled to start the moment the current one ends. */
  private queued: { index: number; source: AudioBufferSourceNode; end: number } | null = null;
  private paused = false;
  private active = false;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  state: PlayerState = "idle";

  constructor(
    synthesize: Synthesize,
    private readonly hooks: PlayerHooks,
  ) {
    this.buffer = new SpeechBuffer(synthesize, (audio) => this.decode(audio));
  }

  /** A WAV file is decoded by the browser; samples that arrived decoded (QOA) only need a buffer to sit in. */
  private async decode(audio: SpeechAudio): Promise<AudioBuffer> {
    const ctx = this.ctx!;
    if (audio instanceof ArrayBuffer) {
      return ctx.decodeAudioData(audio);
    }
    const channels = splitChannels(audio);
    const buffer = ctx.createBuffer(audio.channels, channels[0]!.length, audio.sampleRate);
    channels.forEach((data, c) => {
      buffer.copyToChannel(data, c);
    });
    return buffer;
  }

  /** Must be called from a click (or key) handler: browsers only let a page start audio then. */
  start(segments: Segment[], settings: SpeechSettings): void {
    this.stop();
    if (segments.length === 0) {
      return;
    }
    if (!this.ctx) {
      this.ctx = new AudioContext();
      // iOS Safari interrupts the context when the page goes to the background (another app, the
      // home screen, a call) and does not resume it: the audio is silent but the player would
      // still say "playing". Show it as paused; Resume then restarts the context from a tap.
      this.ctx.addEventListener("statechange", () => this.syncWithContext());
      (globalThis as { document?: EventTarget }).document?.addEventListener("visibilitychange", () =>
        this.syncWithContext(),
      );
    }
    void this.ctx.resume();
    this.segments = segments;
    this.settings = settings;
    this.active = true;
    this.buffer.open(segments, settings);
    void this.play(0, 0);
  }

  pause(): void {
    if (!this.active || this.paused) {
      return;
    }
    this.paused = true;
    // Suspending stops the clock too, so a piece scheduled after a silence stays that far away.
    void this.ctx?.suspend();
    this.refresh();
  }

  resume(): void {
    if (!this.active || !this.paused) {
      return;
    }
    this.paused = false;
    void this.ctx?.resume();
    this.refresh();
  }

  /** Brings the state in line with a context the system suspended or interrupted behind our back. */
  private syncWithContext(): void {
    const { ctx } = this;
    if (!ctx || !this.active) {
      return;
    }
    // "interrupted" is Safari's state for a context stopped by the system.
    const running = ctx.state === "running";
    if (!this.paused && !running) {
      // Not running while we wanted it to: the reading is paused, and a pending piece waits for Resume.
      this.paused = true;
      this.refresh();
    } else if (this.paused && running) {
      // The system restarted it by itself (the end of a call): stay paused until the user resumes.
      void ctx.suspend();
    }
  }

  stop(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.paused = false;
    this.silence();
    this.buffer.close();
    this.hooks.onSegment(null);
    this.refresh();
  }

  /**
   * Jumps to the start of the previous (-1) or next (1) block, a block being the run of pieces that
   * share a `line`. "Previous" first returns to the start of the block being read, as media players
   * do. Returns false when there is nowhere to go. A jump while paused resumes the reading.
   * The audio made so far is kept, and the buffer makes the pieces a jump leads to ahead of time,
   * so the block usually starts at once; if it is not there, the buffer drops what it was making
   * for it.
   */
  jump(direction: -1 | 1): boolean {
    if (!this.active) {
      return false;
    }
    const target = this.blockStart(direction);
    if (target === null) {
      return false;
    }
    this.silence();
    // Choosing where to listen next is a request to listen: a jump while paused resumes.
    if (this.paused) {
      this.paused = false;
      void this.ctx?.resume();
    }
    this.hooks.onSegment(this.segments[target]!);
    // Shows "loading" only if the block's audio is not there.
    void this.play(target, 0);
    return true;
  }

  /** The block being read, 1-based, and how many there are; null when nothing is being read. */
  position(): { block: number; blocks: number } | null {
    if (!this.active) {
      return null;
    }
    const starts = blockStarts(this.segments);
    let block = 0;
    for (let b = 0; b < starts.length; b++) {
      if (starts[b]! <= this.index) {
        block = b;
      }
    }
    return { block: block + 1, blocks: starts.length };
  }

  /** Whether `jump(direction)` would go anywhere. */
  canJump(direction: -1 | 1): boolean {
    return this.active && this.blockStart(direction) !== null;
  }

  private blockStart(direction: -1 | 1): number | null {
    const starts = blockStarts(this.segments);
    const current = (this.position()?.block ?? 1) - 1;
    if (direction === 1) {
      return starts[current + 1] ?? null;
    }
    if (starts[current]! < this.index) {
      return starts[current]!;
    }
    return starts[current - 1] ?? null;
  }

  /** A new voice or speed; while reading, the current piece starts again with it. */
  update(settings: Partial<SpeechSettings>): void {
    this.settings = { ...this.settings, ...settings };
    if (!this.active) {
      return;
    }
    this.silence();
    // Nothing made with the old settings is of use, and the request in flight is stopped now. The
    // first one with the new settings is made once the choosing has paused.
    this.buffer.open(this.segments, this.settings);
    this.refresh();
    const { run } = this;
    const i = this.index;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      if (run === this.run) {
        void this.play(i, 0);
      }
    }, UPDATE_SETTLE_MS);
  }

  /** Stops what plays or is scheduled and disowns whatever was under way. The buffer keeps its audio. */
  private silence(): void {
    this.run++;
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    this.updateTimer = null;
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // it had already ended
      }
      this.source = null;
    }
    if (this.queued) {
      this.queued.source.onended = null;
      try {
        this.queued.source.stop();
      } catch {
        // it had already ended
      }
      this.queued = null;
    }
  }

  private refresh(): void {
    const state: PlayerState = !this.active ? "idle" : this.paused ? "paused" : this.source ? "playing" : "loading";
    if (state === this.state) {
      return;
    }
    this.state = state;
    this.hooks.onState(state);
  }

  private async play(i: number, delayMs: number): Promise<void> {
    const { run } = this;
    const ctx = this.ctx!;
    this.index = i;
    if (i >= this.segments.length) {
      this.stop();
      return;
    }
    // The silence after the previous piece runs on the audio clock, which a pause stops.
    const startAt = ctx.currentTime + delayMs / 1000;
    this.buffer.aim(i);
    // Going on to a piece that is there is not "loading".
    if (!this.buffer.has(i)) {
      this.source = null;
      this.refresh();
    }

    let buffer: AudioBuffer;
    try {
      buffer = await this.buffer.take(i);
    } catch (e) {
      if (run !== this.run) {
        return;
      }
      this.stop();
      this.hooks.onError(e);
      return;
    }
    if (run !== this.run) {
      return;
    }
    const at = Math.max(startAt, ctx.currentTime);
    this.enter(i, this.schedule(i, buffer, at, run), at + buffer.duration, run);
  }

  /** Starts piece `i` on the audio clock at `at`. When it ends, the queued next piece takes over, if there is one. */
  private schedule(i: number, buffer: AudioBuffer, at: number, run: number): AudioBufferSourceNode {
    const source = this.ctx!.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx!.destination);
    source.onended = () => {
      if (run !== this.run) {
        return;
      }
      // This piece is over: nothing is playing until the next one is scheduled or has to be made.
      if (this.source === source) {
        this.source = null;
      }
      const next = this.queued;
      if (next?.index === i + 1) {
        this.queued = null;
        this.enter(next.index, next.source, next.end, run);
      } else {
        void this.play(i + 1, this.segments[i]!.pause);
      }
    };
    source.start(at);
    return source;
  }

  /** Piece `i`, whose `source` is playing or about to, becomes the current one; the piece after it is lined up. */
  private enter(i: number, source: AudioBufferSourceNode, end: number, run: number): void {
    this.index = i;
    this.source = source;
    this.hooks.onSegment(this.segments[i]!);
    this.refresh();
    this.buffer.aim(i);
    if (i + 1 >= this.segments.length) {
      return;
    }
    // Once the next piece is there it is scheduled right behind this one on the audio clock, so
    // the join does not wait for the "ended" event. If this piece has ended before the audio
    // arrives, its onended has already gone to play() and there is nothing to do here.
    this.buffer.take(i + 1).then(
      (buffer) => {
        if (run !== this.run || this.source !== source) {
          return;
        }
        const at = Math.max(end + this.segments[i]!.pause / 1000, this.ctx!.currentTime);
        this.queued = { index: i + 1, source: this.schedule(i + 1, buffer, at, run), end: at + buffer.duration };
      },
      // A failure is reported when the piece's turn comes, by play().
      () => {},
    );
  }
}
