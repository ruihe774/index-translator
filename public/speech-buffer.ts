// The audio of a reading, kept apart from its playback. The player says where the reader is
// (`aim`) and takes the pieces it needs (`take`); what is synthesized, in which order, and what is
// kept is decided here.
//
// One request is in flight at any time until everything worth having is here, so the speech engine
// is never idle while the reader could still run out of audio. The order is: the piece being
// waited for, the pieces after it until a safe stretch is ready, the pieces Previous and Next lead
// to, then further ahead. Audio already played is kept, so going back needs no synthesis. A request
// whose piece is no longer wanted, or that stands in the way of the piece the reader waits for, is
// aborted: the server stops the engine and the next request starts at once.

import type { Segment } from "./speech-text.ts";

/** Continuous audio from the reader's place that is secured before the jump targets are made. */
export const NEAR_SECONDS = 15;
/** How far ahead of the reader audio is made at all. */
export const AHEAD_SECONDS = 90;
/** Audio kept in total; beyond it the pieces farthest from the reader go first. */
export const KEEP_SECONDS = 300;

export interface SpeechSettings {
  lang: string;
  voice: string;
  speed: number;
}

/** The audio of one piece: a WAV or Ogg Opus file. */
export type Synthesize = (text: string, settings: SpeechSettings, signal: AbortSignal) => Promise<ArrayBuffer>;

/** Index of the first piece of each block, a block being the run of pieces that share a `line`. */
export function blockStarts(segments: Segment[]): number[] {
  const starts: number[] = [];
  segments.forEach((s, i) => {
    if (i === 0 || s.line !== segments[i - 1]!.line) {
      starts.push(i);
    }
  });
  return starts;
}

interface Waiter {
  resolve(audio: AudioBuffer): void;
  reject(error: unknown): void;
}

export class SpeechBuffer {
  private segments: Segment[] = [];
  private starts: number[] = [];
  private settings: SpeechSettings = { lang: "", voice: "", speed: 1 };
  private cursor = 0;
  private readonly audio = new Map<number, AudioBuffer>();
  private readonly failed = new Map<number, Error>();
  private readonly waiters = new Map<number, Waiter[]>();
  private flight: { index: number; abort: AbortController } | null = null;
  /** Seconds of audio held. */
  private seconds = 0;
  /** Seconds of audio per character so far, to guess how long a piece not yet made will be. */
  private heard = { seconds: 0, chars: 0 };

  constructor(
    private readonly synthesize: Synthesize,
    private readonly decode: (audio: ArrayBuffer) => Promise<AudioBuffer>,
  ) {}

  /** A new text, or new settings for the same one: nothing made so far can be used. */
  open(segments: Segment[], settings: SpeechSettings): void {
    this.close();
    this.segments = segments;
    this.starts = blockStarts(segments);
    this.settings = settings;
  }

  /** Drops everything and stops the request in flight. Pieces still waited for are refused. */
  close(): void {
    this.segments = [];
    this.starts = [];
    this.cursor = 0;
    this.flight?.abort.abort();
    this.flight = null;
    this.audio.clear();
    this.failed.clear();
    this.seconds = 0;
    this.heard = { seconds: 0, chars: 0 };
    const waiters = [...this.waiters.values()].flat();
    this.waiters.clear();
    for (const w of waiters) {
      w.reject(new Error("the reading was stopped"));
    }
  }

  /** The reader is at piece `i`: what is made next follows from there. */
  aim(i: number): void {
    this.cursor = i;
    this.pump();
  }

  has(i: number): boolean {
    return this.audio.has(i);
  }

  /** The audio of piece `i`, now or when it has been made; rejects if making it failed. */
  take(i: number): Promise<AudioBuffer> {
    const audio = this.audio.get(i);
    if (audio) {
      return Promise.resolve(audio);
    }
    const failure = this.failed.get(i);
    if (failure) {
      return Promise.reject(failure);
    }
    return new Promise((resolve, reject) => {
      const waiting = this.waiters.get(i) ?? [];
      waiting.push({ resolve, reject });
      this.waiters.set(i, waiting);
    });
  }

  /** How long piece `i` is, or will be by the pieces heard so far. */
  private duration(i: number): number {
    const audio = this.audio.get(i);
    if (audio) {
      return audio.duration;
    }
    // Before anything was heard: roughly what the model does, a syllable per Chinese or Japanese character.
    const wide = this.settings.lang === "zh" || this.settings.lang === "ja";
    const rate =
      this.heard.chars > 0 ? this.heard.seconds / this.heard.chars : (wide ? 0.25 : 0.07) / this.settings.speed;
    return this.segments[i]!.text.length * rate;
  }

  /** The pieces from the reader's place on that make up `seconds` of audio; none beyond one that failed. */
  private stretch(seconds: number): number[] {
    const pieces: number[] = [];
    let total = 0;
    for (let i = this.cursor; i < this.segments.length && total < seconds && !this.failed.has(i); i++) {
      pieces.push(i);
      total += this.duration(i);
    }
    return pieces;
  }

  /** Where Next and Previous lead from the reader's place: the starts of the next, this and the previous block. */
  private targets(): number[] {
    let block = 0;
    for (let b = 0; b < this.starts.length; b++) {
      if (this.starts[b]! <= this.cursor) {
        block = b;
      }
    }
    return [this.starts[block + 1], this.starts[block], this.starts[block - 1]].filter(
      (i): i is number => i !== undefined,
    );
  }

  /** The pieces still to be made, most urgent first. */
  private plan(): number[] {
    // The piece the reader waits for failed: the player is about to stop, nothing more is needed.
    if (this.failed.has(this.cursor)) {
      return [];
    }
    const plan: number[] = [];
    for (const i of [...this.stretch(NEAR_SECONDS), ...this.targets(), ...this.stretch(AHEAD_SECONDS)]) {
      if (!this.audio.has(i) && !this.failed.has(i) && !plan.includes(i)) {
        plan.push(i);
      }
    }
    return plan;
  }

  private pump(): void {
    if (this.cursor >= this.segments.length) {
      return;
    }
    const plan = this.plan();
    const { flight } = this;
    if (flight) {
      // Stale: its piece is not wanted any more, or the reader waits for another one.
      const starved = plan[0] === this.cursor;
      if (plan.includes(flight.index) && !(starved && flight.index !== this.cursor)) {
        return;
      }
      this.flight = null;
      flight.abort.abort();
    }
    if (plan.length > 0) {
      this.fetch(plan[0]!);
    }
  }

  private fetch(i: number): void {
    const flight = { index: i, abort: new AbortController() };
    this.flight = flight;
    this.synthesize(this.segments[i]!.text, this.settings, flight.abort.signal)
      .then((audio) => this.decode(audio))
      .then(
        (audio) => {
          // Aborted, or closed, while it was on its way.
          if (this.flight !== flight) {
            return;
          }
          this.flight = null;
          this.store(i, audio);
          this.pump();
        },
        (e) => {
          if (this.flight !== flight) {
            return;
          }
          this.flight = null;
          // Reported when the reader gets there, by `take`.
          this.failed.set(i, e instanceof Error ? e : new Error(String(e)));
          const waiting = this.waiters.get(i) ?? [];
          this.waiters.delete(i);
          for (const w of waiting) {
            w.reject(e);
          }
          this.pump();
        },
      );
  }

  private store(i: number, audio: AudioBuffer): void {
    this.audio.set(i, audio);
    this.seconds += audio.duration;
    this.heard.seconds += audio.duration;
    this.heard.chars += this.segments[i]!.text.length;
    const waiting = this.waiters.get(i) ?? [];
    this.waiters.delete(i);
    for (const w of waiting) {
      w.resolve(audio);
    }
    if (this.seconds <= KEEP_SECONDS) {
      return;
    }
    // Too much: what lies ahead of the reader and where the jumps lead stays, the rest goes, farthest first.
    const kept = new Set([...this.stretch(AHEAD_SECONDS), ...this.targets()]);
    const loose = [...this.audio.keys()]
      .filter((k) => !kept.has(k))
      .sort((a, b) => Math.abs(b - this.cursor) - Math.abs(a - this.cursor));
    for (const k of loose) {
      if (this.seconds <= KEEP_SECONDS) {
        break;
      }
      this.seconds -= this.audio.get(k)!.duration;
      this.audio.delete(k);
    }
  }
}
