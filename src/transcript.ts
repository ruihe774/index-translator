// The parts of a transcription that need no engine, so tests can reach them: cutting the silence out
// of a recording (from Silero VAD's spans) and mapping times on the cut back, reading
// MOSS-Transcribe-Diarize's text while it is written, and noticing when it only repeats itself.

/** The rate the recording is brought to for Silero VAD and MOSS, which both work at 16 kHz. */
export const TRANSCRIBE_RATE = 16_000;

/** One stretch of the transcript. Times in seconds on the uploaded recording. */
export interface Segment {
  start: number;
  end: number;
  /** MOSS's label, `S01`, `S02`, ...: the same speaker within one transcription, nothing more. */
  speaker: string;
  text: string;
}

/**
 * The recording is cut to its speech only when more than this share of it is silence. MOSS alone
 * dropped an utterance after a long silence and drifted at segment edges in noise, which the cut
 * fixed; on a meeting with little silence the cut made diarization worse (DER 28.8% to 34.6%).
 */
export const TRIM_SILENCE_SHARE = 0.3;
/** CED-tiny, which `fetch_models.ts` puts beside MOSS: what `separate: auto` asks whether there is music. */
export const MUSIC_MODEL_FILE = "ced-tiny-f32.gguf";
/** CED hears music in a window at this probability; speech alone scored at most 0.16, music under talk 0.6 to 0.8. */
const MUSIC_SCORE = 0.3;
/** A recording has music to take out when at least this share of its windows does (not a jingle at the start). */
const MUSIC_SHARE = 0.2;
const MUSIC_WINDOW_SECONDS = 10;
/** Windows CED hears at most, spread over the recording (30 take about 1.5 s on the CPU). */
const MAX_MUSIC_WINDOWS = 30;

/** The [start, end) sample ranges CED hears of a recording of `total` samples: 10 s each, at most 30, spread evenly. */
export function musicWindows(total: number, rate: number): [number, number][] {
  // Under a second there is too little for CED (and for music to matter).
  if (total < rate) {
    return [];
  }
  const size = Math.min(total, MUSIC_WINDOW_SECONDS * rate);
  const fits = Math.floor(total / size);
  const count = Math.min(fits, MAX_MUSIC_WINDOWS);
  return Array.from({ length: count }, (_, i) => {
    const at = count === 1 ? 0 : Math.round((i * (fits - 1)) / (count - 1)) * size;
    return [at, at + size];
  });
}

/** Whether CED's Music scores of a recording's windows say it has music to take out. */
export const hasMusic = (scores: readonly number[]): boolean =>
  scores.length > 0 && scores.filter((s) => s >= MUSIC_SCORE).length >= MUSIC_SHARE * scores.length;

/** Kept on each side of a stretch of speech (Silero ends it tight). */
const PAD_SECONDS = 0.2;
/** Silence put between two kept stretches, so MOSS still hears a pause. */
const JOIN_SECONDS = 0.5;

/** A kept stretch: samples [from, to) of the recording, placed at sample `at` of the cut one. */
export interface Piece {
  from: number;
  to: number;
  at: number;
}

/**
 * What to keep of a recording of `total` samples at `rate` given its stretches of speech, or
 * undefined when it is to be transcribed whole: at most TRIM_SILENCE_SHARE of it is silence, or
 * Silero found no speech (singing it may miss; MOSS then decides).
 */
export function cutPlan(spans: readonly [number, number][], total: number, rate: number): Piece[] | undefined {
  const speech = spans.reduce((sum, [s, e]) => sum + Math.max(0, Math.min(e, total) - Math.max(s, 0)), 0);
  if (speech === 0 || speech >= (1 - TRIM_SILENCE_SHARE) * total) {
    return undefined;
  }
  const pad = Math.round(PAD_SECONDS * rate);
  const join = Math.round(JOIN_SECONDS * rate);
  // Padded and merged: a gap no longer than the joining silence is kept as it is.
  const kept: [number, number][] = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    const from = Math.max(0, s - pad);
    const to = Math.min(total, e + pad);
    const last = kept.at(-1);
    if (last && from - last[1] <= join) {
      last[1] = Math.max(last[1], to);
    } else if (to > from) {
      kept.push([from, to]);
    }
  }
  let at = 0;
  return kept.map(([from, to]) => {
    const piece = { from, to, at };
    at += to - from + join;
    return piece;
  });
}

/** The cut recording: the pieces of mono `samples` in order, with JOIN_SECONDS of silence between them. */
export function cutAudio(samples: Float32Array, pieces: readonly Piece[]): Float32Array {
  const last = pieces.at(-1);
  const out = new Float32Array(last ? last.at + last.to - last.from : 0);
  for (const p of pieces) {
    out.set(samples.subarray(p.from, p.to), p.at);
  }
  return out;
}

/** A time in seconds on the cut recording as one on the original; a time in a joining silence goes to the nearer edge. */
export function toOriginal(seconds: number, pieces: readonly Piece[], rate: number): number {
  const at = seconds * rate;
  const last = pieces.at(-1);
  if (!last) {
    return seconds;
  }
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    const prev = pieces[i - 1];
    if (at < p.at) {
      // In the silence before p (never before the first piece, which starts the cut recording).
      const prevEnd = prev ? prev.at + prev.to - prev.from : 0;
      return (prev && at - prevEnd < p.at - at ? prev.to : p.from) / rate;
    }
    if (at <= p.at + p.to - p.from) {
      return (p.from + at - p.at) / rate;
    }
  }
  return last.to / rate;
}

/**
 * Token budget of MOSS for `seconds` of audio. audio.cpp reserves the model's cache for the prompt
 * (12.5 audio tokens a second) plus this budget, so it is VRAM: 30 minutes with 20,000 tokens took
 * 15.9 of 16 GiB beside the translation model. Speech measured at about 7 tokens a second (an English
 * meeting, Japanese dialogue); the rest is room for fast talkers.
 */
export const maxTokens = (seconds: number): number => 512 + Math.ceil(11 * seconds);

// MOSS writes `[start][Sxx]text[end]` segments one after another, times in seconds; the pattern is audio.cpp's.
const SEGMENT =
  /\[([0-9]+(?:\.[0-9]*)?|\.[0-9]+)\]\s*\[(S[0-9]+)\]([\s\S]*?)\[([0-9]+(?:\.[0-9]*)?|\.[0-9]+)\](?=\s*(?:\[|$))/g;

/**
 * Reads MOSS's output while it is written: `push` takes each new piece of text and answers the
 * segments it completed. A segment counts as complete once the next one begins, since until then
 * its text could go on; `end` answers the rest. Times are on the recording MOSS heard.
 */
export class SegmentReader {
  private text = "";
  /** Where the first segment not yet answered begins. */
  private done = 0;

  push(piece: string): Segment[] {
    this.text += piece;
    return this.take(false);
  }

  end(): Segment[] {
    return this.take(true);
  }

  private take(final: boolean): Segment[] {
    const out: Segment[] = [];
    SEGMENT.lastIndex = this.done;
    for (let m = SEGMENT.exec(this.text); m; m = SEGMENT.exec(this.text)) {
      const after = SEGMENT.lastIndex;
      if (!final && !/^\s*\[/.test(this.text.slice(after))) {
        break;
      }
      this.done = after;
      const start = Number(m[1]);
      const end = Number(m[4]);
      const text = m[3]!.trim();
      if (end >= start && text) {
        out.push({ start, end, speaker: m[2]!, text });
      }
    }
    return out;
  }
}

/** The same text this many times in a row is MOSS caught in a loop (it does so on music), not speech. */
const MAX_REPEATS = 6;
/** Seconds past the end of the recording a segment may start at before MOSS is taken to be making it up. */
const PAST_END_SECONDS = 2;

/** Watches the segments of one transcription and says when MOSS has stopped transcribing and only repeats itself. */
export class LoopGuard {
  private last = "";
  private repeats = 0;

  constructor(private readonly seconds: number) {}

  /** True when the transcription should be stopped at `s`, which is then dropped. */
  looping(s: Segment): boolean {
    if (s.start > this.seconds + PAST_END_SECONDS) {
      return true;
    }
    this.repeats = s.text === this.last ? this.repeats + 1 : 1;
    this.last = s.text;
    return this.repeats >= MAX_REPEATS;
  }
}
