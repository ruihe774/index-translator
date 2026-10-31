// SubRip subtitles: reading a file, what is sent to be translated and how the translation is put back
// together. Pure, so bun test can import it.
//
// Only the cues' text is sent, numbered 1..n, so the model never sees (or has to copy) a timestamp:
//
//   1
//   first line
//   second line
//
//   2
//   …
//
// The translation comes back under the same numbers, and every cue gets its own index and timing line
// from the source again, as they were written. The model sometimes writes a sentence that runs across
// cues under the first of them and leaves the next empty, or skips a number; such cues are joined with
// the one before (one cue of the translation, from the first one's start to the last one's end). A
// number that does not follow the last one taken, or one past the end, is left out with its text.

import type { Alignment, BlockGroup } from "./paragraphs.ts";

/**
 * Most cues one request translates reliably. Measured with `scripts/longsubs.ts` (the long-input essays
 * cut into cues, with `SUBTITLE_CONSTRAINT`): runs of 266 and 335 cues began repeating earlier cues at
 * about the 200th to 250th cue they wrote; 200 cues ended normally in both directions (en→zh, zh→en).
 * Even then the text drifts: en→zh folded short fragments into the cue before without leaving a number
 * empty, so by the end text sat up to 3 numbers early and the last 2 numbers were never written.
 */
export const MAX_CUES = 200;

/**
 * Sent as the first hard constraint of every subtitle translation. Without it the chat model translated
 * English cues sentence by sentence and numbered the sentences, so from the fourth cue on no number held
 * its own text; with it, text stayed under its own number (a sentence across cues written under the first
 * of them, the next left empty).
 */
export const SUBTITLE_CONSTRAINT =
  "源文是按编号分条的字幕：每条字幕以单独一行的编号开头。逐条翻译，每条译文放在原编号下，编号和条数与源文完全一致；不得合并、拆分字幕，也不得把一条字幕的内容移到另一个编号下，即使一句话跨越多条字幕。";

/** The genre sent with subtitles when none was entered. */
export const SUBTITLE_GENRE = "字幕";

export interface Cue {
  /** The cue's number as the file writes it. */
  index: string;
  /** The timing line as the file writes it (position coordinates included), trimmed. */
  timing: string;
  /** Start and end in milliseconds. */
  start: number;
  end: number;
  /** Override tags such as `{\an8}` in front of the first line, kept apart from the text. */
  tag: string;
  /** The text lines, without blank ones and without `tag`. */
  lines: string[];
  /** The line of the text the cue's number is on. */
  line: number;
}

const INDEX = /^\d+$/;
const TIME = String.raw`(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})`;
const TIMING = new RegExp(String.raw`^${TIME}\s*-->\s*${TIME}(?:\s.*)?$`);
const TAG = /^(?:\{\\[^}]*\})+/;

function ms(h: string, m: string, s: string, frac: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(frac.padEnd(3, "0"));
}

/** Whether lines `i` and `i + 1` start a cue: a number, then a timing line. */
function startsCue(lines: string[], i: number): boolean {
  return INDEX.test(lines[i]!.trim()) && i + 1 < lines.length && TIMING.test(lines[i + 1]!.trim());
}

/**
 * The cues of a SubRip text, or null when it is not one: something other than blank lines before the
 * first cue, or no cue at all. A cue runs from a number followed by a timing line to the next such
 * pair, so a stray blank line inside a cue's text does not end it.
 */
export function parseSrt(text: string): Cue[] | null {
  const lines = text.replace(/^﻿/, "").split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first === -1 || !startsCue(lines, first)) {
    return null;
  }
  const cues: Cue[] = [];
  for (let i = first; i < lines.length;) {
    let next = i + 2;
    while (next < lines.length && !startsCue(lines, next)) {
      next++;
    }
    const timing = lines[i + 1]!.trim();
    const t = TIMING.exec(timing)!;
    const body = lines
      .slice(i + 2, next)
      .map((l) => l.trim())
      .filter(Boolean);
    const tag = TAG.exec(body[0] ?? "")?.[0] ?? "";
    if (tag) {
      body[0] = body[0]!.slice(tag.length).trim();
      if (!body[0]) {
        body.shift();
      }
    }
    cues.push({
      index: lines[i]!.trim(),
      timing,
      start: ms(t[1]!, t[2]!, t[3]!, t[4]!),
      end: ms(t[5]!, t[6]!, t[7]!, t[8]!),
      tag,
      lines: body,
      line: i,
    });
    i = next;
  }
  return cues;
}

/** What is sent for the cues, and which cue each number stands for. */
export interface Wire {
  text: string;
  /** `sent[k]` is the position in the cues of the one sent as number k + 1. Cues with no text are not sent. */
  sent: number[];
}

export function toWire(cues: Cue[]): Wire {
  const sent = cues.flatMap((c, k) => (c.lines.length > 0 ? [k] : []));
  const text = sent.map((k, n) => `${n + 1}\n${cues[k]!.lines.join("\n")}`).join("\n\n");
  return { text, sent };
}

/**
 * How far a translation got: still streaming, finished normally (`complete`: numbers missing at the end
 * were joined with the last cue written), or cut short (`partial`: by Stop, an error or the output limit,
 * so what follows the last number written was not translated).
 */
export type Progress = "streaming" | "complete" | "partial";

export interface SubtitleTranslation {
  /** The translation as SubRip text. */
  srt: string;
  /** Indexes (as written) of the source cues joined with the cue before them. */
  joined: string[];
  /** Lines of text left out: before the first number, or under a number that was not taken. */
  dropped: number;
  /** Indexes (as written) of the source cues not translated. */
  untranslated: string[];
}

interface Entry {
  /** The number, 1-based in the sent cues. */
  n: number;
  lines: string[];
}

/** The numbered entries of a translation, in order: each number must follow the last one taken. */
function readEntries(output: string, count: number): { entries: Entry[]; dropped: number } {
  const entries: Entry[] = [];
  let dropped = 0;
  let current: Entry | null = null;
  let taking = false;
  let previousBlank = true;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const last = entries.at(-1)?.n ?? 0;
    // A number inside a cue's text only starts a cue when it is the next one.
    if (INDEX.test(line) && (previousBlank || Number(line) === last + 1)) {
      const n = Number(line);
      taking = n > last && n <= count;
      current = taking ? { n, lines: [] } : null;
      if (current) {
        entries.push(current);
      }
    } else if (line) {
      if (taking && current) {
        current.lines.push(line);
      } else {
        dropped++;
      }
    }
    previousBlank = line === "";
  }
  return { entries, dropped };
}

const timingStart = (timing: string) => timing.split("-->")[0]!.trim();
const timingEnd = (timing: string) => timing.split("-->").slice(1).join("-->").trim();

/** The timing line of cues `from` to `to` joined into one: the first one's start, the last one's end. */
function joinedTiming(from: Cue, to: Cue): string {
  return from === to ? from.timing : `${timingStart(from.timing)} --> ${timingEnd(to.timing)}`;
}

function block(index: string, timing: string, lines: string[]): string {
  return [index, timing, ...lines].join("\n");
}

/**
 * The translation of `cues` (sent as `wire`) as SubRip text, from the model's `output` so far. Called
 * again as the output grows: everything before the entry being written stays as it was, except that an
 * entry left empty joins the cue before once the next number shows it is empty.
 */
export function translateSubtitles(cues: Cue[], wire: Wire, output: string, progress: Progress): SubtitleTranslation {
  const { sent } = wire;
  const { entries, dropped } = readEntries(output, sent.length);
  const starts = entries.filter((e) => e.lines.length > 0);
  // How far the last entry with text reaches. While streaming, an entry with no text yet may still get
  // some: it is not joined, so the row before does not stretch and shrink back with every new number.
  const reach = { complete: sent.length, partial: entries.at(-1)?.n ?? 0, streaming: 0 }[progress];
  const blocks: string[] = [];
  const joined: string[] = [];
  let next = 0; // the first source cue not yet written
  const writeUntranslated = (until: number) => {
    for (; next < until; next++) {
      const c = cues[next]!;
      blocks.push(block(c.index, c.timing, c.tag ? [c.tag] : []));
    }
  };
  starts.forEach((entry, k) => {
    // Numbers before the first entry with text go with it; so does every number up to the next one.
    const fromN = k === 0 ? 1 : entry.n;
    const toN = k + 1 < starts.length ? starts[k + 1]!.n - 1 : Math.max(entry.n, reach);
    const from = sent[fromN - 1]!;
    const to = sent[toN - 1]!;
    writeUntranslated(from);
    for (let n = fromN; n <= toN; n++) {
      if (n !== entry.n) {
        joined.push(cues[sent[n - 1]!]!.index);
      }
    }
    const first = cues[from]!;
    const lines = [...entry.lines];
    if (first.tag) {
      lines[0] = first.tag + lines[0]!;
    }
    blocks.push(block(first.index, joinedTiming(first, cues[to]!), lines));
    next = to + 1;
  });
  // Cues with no text after the last one sent are kept, as they are, once the translation is complete.
  const covered = starts.length > 0 ? next : 0;
  if (progress === "complete") {
    writeUntranslated(starts.length > 0 ? cues.length : 0);
  }
  const untranslated = progress === "complete" && starts.length > 0 ? [] : cues.slice(covered).map((c) => c.index);
  const srt = blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
  return { srt, joined, dropped, untranslated: progress === "streaming" ? [] : untranslated };
}

/**
 * Which cues of the source each cue of the translation translates, as the page's block matching: the
 * blocks are the cues, starting at their numbers' lines. A cue of the translation carries its first
 * source cue's number and start, and its last one's end (`translateSubtitles`), which is how it is found
 * again; null when one is not (the texts do not belong together). Source cues after the last one
 * matched have no counterpart.
 */
export function subtitleAlignment(source: string, translation: string): Alignment | null {
  const src = parseSrt(source);
  const out = translation.trim() ? parseSrt(translation) : [];
  if (!src || !out) {
    return null;
  }
  const groups: BlockGroup[] = [];
  let next = 0;
  for (const [k, cue] of out.entries()) {
    const from = src.findIndex(
      (c, i) => i >= next && c.index === cue.index && timingStart(c.timing) === timingStart(cue.timing),
    );
    const to = from === -1 ? -1 : src.findIndex((c, i) => i >= from && timingEnd(c.timing) === timingEnd(cue.timing));
    if (to === -1) {
      return null;
    }
    // Source cues skipped before this one were not translated.
    for (let i = next; i < from; i++) {
      groups.push({ source: [i], output: [] });
    }
    groups.push({ source: Array.from({ length: to - from + 1 }, (_, i) => from + i), output: [k] });
    next = to + 1;
  }
  for (let i = next; i < src.length; i++) {
    groups.push({ source: [i], output: [] });
  }
  return { unit: "paragraphs", source: src.map((c) => c.line), output: out.map((c) => c.line), groups };
}

/** "cue 12", "cues 12 and 40", "cues 12, 40, 41 and 3 more". */
function cueList(indexes: string[], max = 3): string {
  if (indexes.length === 1) {
    return `cue ${indexes[0]}`;
  }
  const listed = indexes.slice(0, max);
  const more = indexes.length - listed.length;
  return more > 0
    ? `cues ${listed.join(", ")} and ${more} more`
    : `cues ${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`;
}

/** What to say after a subtitle translation, about the cues it joined, left out or did not reach. */
export function subtitleNotes(t: SubtitleTranslation): string[] {
  const notes: string[] = [];
  if (t.joined.length > 0) {
    notes.push(
      `The translation put ${cueList(t.joined)} together with the cue before ${t.joined.length === 1 ? "it" : "them"}: each such group is one cue of the translation, timed from its first cue's start to its last cue's end.`,
    );
  }
  if (t.dropped > 0) {
    notes.push(
      `${t.dropped === 1 ? "A line" : `${t.dropped} lines`} of the translation outside the numbered cues ${t.dropped === 1 ? "was" : "were"} left out.`,
    );
  }
  if (t.untranslated.length > 0) {
    const [first] = t.untranslated;
    const last = t.untranslated.at(-1);
    notes.push(first === last ? `Cue ${first} was not translated.` : `Cues ${first} to ${last} were not translated.`);
  }
  return notes;
}

/** A line's text split at `<i>`, `<b>` and `<u>` (with the styles in force); `<font>` tags are dropped. */
export function styledRuns(line: string): { text: string; styles: ("i" | "b" | "u")[] }[] {
  const runs: { text: string; styles: ("i" | "b" | "u")[] }[] = [];
  const on = new Set<"i" | "b" | "u">();
  let at = 0;
  for (const m of line.matchAll(/<(\/?)([ibu])>|<\/?font\b[^>]*>/gi)) {
    if (m.index > at) {
      runs.push({ text: line.slice(at, m.index), styles: [...on] });
    }
    const name = m[2]?.toLowerCase() as "i" | "b" | "u" | undefined;
    if (name) {
      if (m[1]) {
        on.delete(name);
      } else {
        on.add(name);
      }
    }
    at = m.index + m[0].length;
  }
  if (at < line.length) {
    runs.push({ text: line.slice(at), styles: [...on] });
  }
  return runs;
}

/** A cue's text as the table shows it: styling tags removed, lines joined by a newline. */
export function shownText(lines: string[]): string {
  return lines
    .map((l) =>
      styledRuns(l)
        .map((r) => r.text)
        .join(""),
    )
    .join("\n");
}

/** `h:mm:ss` of a time in milliseconds (the table's time column; tenths are not worth the width). */
export function clock(time: number): string {
  const s = Math.floor(time / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
