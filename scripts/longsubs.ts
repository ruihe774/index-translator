// Long-subtitle check against a running backend. Cuts the long-input essays into numbered cues, as a
// subtitle file without its timestamps would be sent, translates them in a single generation, and
// checks that every cue came back under its own number. The essays' marker numbers (unique per
// paragraph, see test/fixtures.ts) tell whether a cue's text stayed under its number or drifted to a
// neighbour's.
// The request is the web app's (public/subtitles.ts: the hard constraint and genre), with the first
// MAX_CUES cues (default the app's cap). Output is capped at twice the prompt's tokens, so a run that
// loops ends early. A format with one line per cue, `[12] text`, kept text under its number worse.
// Usage: [MODEL=…] [MAX_CUES=…] [PASSES=en-zh,zh-en] bun scripts/longsubs.ts [base-url] [output-dir]

import { join } from "node:path";

import { MAX_CUES, SUBTITLE_CONSTRAINT, SUBTITLE_GENRE } from "../public/subtitles";
import type { TokenizeResponse } from "../src/api";
import { translateStream } from "./longtext";

interface Cue {
  index: number;
  lines: string[];
  /** Marker numbers of three or more digits the cue's text holds. */
  markers: string[];
}

interface Style {
  lang: string;
  /** Characters per subtitle line; a cue has at most two lines. */
  line: number;
  /** Characters read per second, for the timings. */
  rate: number;
  /** Whether lines break only at spaces. */
  spaced: boolean;
}

const STYLES: Record<string, Style> = {
  en: { lang: "en", line: 42, rate: 15, spaced: true },
  zh: { lang: "zh", line: 16, rate: 5, spaced: false },
};

const CLAUSE_END = /[,;:，；：、]\s*$/u;
const MARKER = /\d{3,}/g;

/** Pieces of a sentence no longer than `max`: cut after clause punctuation, else at spaces, else anywhere. */
function cutSentence(sentence: string, max: number, spaced: boolean): string[] {
  if (sentence.length <= max) {
    return [sentence];
  }
  const words = spaced ? sentence.split(/(?<=\s)/) : Array.from(sentence);
  const pieces: string[] = [];
  let current = "";
  let lastClause = -1;
  for (const word of words) {
    if (current.length + word.length > max && current) {
      const at = lastClause > max / 3 ? lastClause : current.length;
      pieces.push(current.slice(0, at));
      current = current.slice(at);
      lastClause = -1;
    }
    current += word;
    if (CLAUSE_END.test(current)) {
      lastClause = current.length;
    }
  }
  if (current) {
    pieces.push(current);
  }
  return pieces.map((p) => p.trim()).filter(Boolean);
}

/** Where a line nearest `middle` can break: after punctuation if one fits, else anywhere allowed. */
function nearest(positions: number[], middle: number): number | undefined {
  return positions.reduce<number | undefined>(
    (best, p) => (best === undefined || Math.abs(p - middle) < Math.abs(best - middle) ? p : best),
    undefined,
  );
}

/**
 * One or two lines, broken nearest the middle: at a space where lines break only there; otherwise after
 * punctuation when both lines still fit, else between any two characters but never inside a number or a
 * Latin word.
 */
function toLines(text: string, style: Style): string[] {
  if (text.length <= style.line) {
    return [text];
  }
  const middle = text.length / 2;
  const fits = (p: number) => p <= style.line + 2 && text.length - p <= style.line + 2;
  const all = Array.from({ length: text.length - 1 }, (_, i) => i + 1);
  const best = style.spaced
    ? nearest(
        all.filter((p) => text[p] === " "),
        middle,
      )
    : (nearest(
        all.filter((p) => /[，。；：、！？]/u.test(text[p - 1]!) && fits(p)),
        middle,
      ) ??
      nearest(
        all.filter((p) => !/[0-9A-Za-z]/.test(text[p - 1]!) || !/[0-9A-Za-z]/.test(text[p]!)),
        middle,
      ));
  const at = best ?? Math.round(middle);
  return [text.slice(0, at).trim(), text.slice(at).trim()];
}

/** The essays as subtitles: sentences packed into cues of at most two lines, paragraph by paragraph. */
export function toCues(text: string, style: Style): Cue[] {
  const segmenter = new Intl.Segmenter(style.lang, { granularity: "sentence" });
  const max = style.line * 2;
  const cues: Cue[] = [];
  for (const paragraph of text.trim().split(/\n\s*\n/)) {
    const pieces = [...segmenter.segment(paragraph.trim())].flatMap((s) =>
      cutSentence(s.segment.trim(), max, style.spaced),
    );
    let current = "";
    const flush = () => {
      if (current) {
        cues.push({
          index: cues.length + 1,
          lines: toLines(current, style),
          markers: current.match(MARKER) ?? [],
        });
      }
      current = "";
    };
    for (const piece of pieces) {
      const joined = current ? `${current}${style.spaced ? " " : ""}${piece}` : piece;
      if (joined.length > max) {
        flush();
        current = piece;
      } else {
        current = joined;
      }
    }
    flush();
  }
  return cues;
}

const time = (ms: number) => {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
};

/** A SubRip file of the cues, timed by reading rate, for looking at; never sent. */
export function toSrt(cues: Cue[], style: Style): string {
  let at = 1000;
  return cues
    .map((cue) => {
      const { length } = cue.lines.join(" ");
      const duration = Math.max(1000, Math.round((length / style.rate) * 1000));
      const block = `${cue.index}\n${time(at)} --> ${time(at + duration)}\n${cue.lines.join("\n")}\n`;
      at += duration + 200;
      return block;
    })
    .join("\n");
}

/** What is sent: each cue's number on a line of its own, then its lines; cues separated by a blank line. */
export function toWire(cues: Cue[]): string {
  return cues.map((cue) => `${cue.index}\n${cue.lines.join("\n")}`).join("\n\n");
}

export interface OutputCue {
  index: number;
  lines: string[];
  /** The number line did not follow a blank line (or the start). */
  unseparated: boolean;
}

/** The cues of a translation: a line holding only a number starts one; its text runs to the next. */
export function parseWire(text: string): OutputCue[] {
  const cues: OutputCue[] = [];
  let previousBlank = true;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^\d+$/.test(line)) {
      cues.push({ index: Number(line), lines: [], unseparated: !previousBlank });
    } else if (line && cues.length > 0) {
      cues.at(-1)!.lines.push(line);
    }
    previousBlank = line === "";
  }
  return cues;
}

const normalize = (text: string) => text.replaceAll(/(\d)[,  ](?=\d{3}(?!\d))/g, "$1");
const holds = (text: string, marker: string) => new RegExp(`(?<!\\d)${marker}(?!\\d)`).test(normalize(text));

export interface Report {
  ok: boolean;
  missing: number[];
  unexpected: number[];
  duplicated: number[];
  outOfOrder: number;
  empty: number[];
  unseparated: number;
  lineCountChanged: number;
  /**
   * Cues whose markers are found under an earlier number with every cue from there up to their own left
   * empty: a sentence across cues written under the first of them, which the web app shows as merged.
   */
  merged: number[];
  /** Cues whose markers are found under another number otherwise, with the offset. */
  shifted: { index: number; offset: number }[];
  /** Cues whose markers are nowhere in the translation. */
  lost: number[];
}

export function check(source: Cue[], output: OutputCue[]): Report {
  const n = source.length;
  const byIndex = new Map<number, OutputCue[]>();
  for (const cue of output) {
    byIndex.set(cue.index, [...(byIndex.get(cue.index) ?? []), cue]);
  }
  const missing = source.filter((c) => !byIndex.has(c.index)).map((c) => c.index);
  const unexpected = [...byIndex.keys()].filter((i) => i < 1 || i > n);
  const duplicated = [...byIndex].filter(([, list]) => list.length > 1).map(([i]) => i);
  const outOfOrder = output.filter((c, k) => k > 0 && c.index <= output[k - 1]!.index).length;
  const empty = output.filter((c) => c.lines.length === 0).map((c) => c.index);
  const unseparated = output.filter((c, k) => k > 0 && c.unseparated).length;
  const textOf = (i: number) => (byIndex.get(i) ?? []).map((c) => c.lines.join("\n")).join("\n");
  const lineCountChanged = source.filter((c) => {
    const out = byIndex.get(c.index);
    return out?.length === 1 && out[0]!.lines.length !== c.lines.length;
  }).length;
  const merged: number[] = [];
  const shifted: Report["shifted"] = [];
  const lost: number[] = [];
  const whole = normalize(output.map((c) => c.lines.join("\n")).join("\n"));
  for (const cue of source) {
    if (cue.markers.length === 0 || cue.markers.every((m) => holds(textOf(cue.index), m))) {
      continue;
    }
    const offset = [-1, 1, -2, 2, -3, 3].find((d) => cue.markers.every((m) => holds(textOf(cue.index + d), m)));
    const between = (d: number) => Array.from({ length: -d }, (_, k) => cue.index + d + 1 + k);
    if (offset !== undefined && offset < 0 && between(offset).every((i) => textOf(i).trim() === "")) {
      merged.push(cue.index);
    } else if (offset !== undefined) {
      shifted.push({ index: cue.index, offset });
    } else if (cue.markers.some((m) => !holds(whole, m))) {
      lost.push(cue.index);
    } else {
      // Its markers are there but split across cues further away: count it as shifted, offset unknown.
      shifted.push({ index: cue.index, offset: Number.NaN });
    }
  }
  // An empty cue is a merge into the one before, which the web app handles; text under a wrong number is not.
  const ok = missing.length + unexpected.length + duplicated.length + outOfOrder + shifted.length + lost.length === 0;
  return {
    ok,
    merged,
    missing,
    unexpected,
    duplicated,
    outOfOrder,
    empty,
    unseparated,
    lineCountChanged,
    shifted,
    lost,
  };
}

const list = (items: (number | string)[], max = 20) =>
  items.length === 0 ? "none" : `${items.length}: ${items.slice(0, max).join(", ")}${items.length > max ? ", …" : ""}`;

async function runPass(base: string, label: string, text: string, from: string, to: string, outDir?: string) {
  const style = STYLES[from]!;
  const cues = toCues(text, style).slice(0, Number(Bun.env.MAX_CUES ?? MAX_CUES));
  const wire = toWire(cues);
  const model = Bun.env.MODEL ?? "index-translate-9b";
  const body = {
    model,
    text: wire,
    source_lang: from,
    target_lang: to,
    hard_constraints: [SUBTITLE_CONSTRAINT],
    genre: SUBTITLE_GENRE,
  };
  const counted = await fetch(`${base}/api/v1/tokenize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const { prompt_tokens: promptTokens } = (await counted.json()) as TokenizeResponse;
  const t0 = performance.now();
  const { translation, start, done } = await translateStream(base, {
    ...body,
    max_output_tokens: promptTokens * 2,
  });
  const seconds = (performance.now() - t0) / 1000;
  const output = parseWire(translation);
  const r = check(cues, output);
  const ok = r.ok && done.finish_reason === "stop";
  const letters = wire.match(/\p{L}/gu)?.length ?? 0;

  console.log(`${ok ? "PASS" : "FAIL"} ${label} (${model})`);
  console.log(`  input: ${cues.length} cues, ${wire.length} characters (${letters} letters)`);
  console.log(`  tokens: ${start?.prompt_tokens} prompt + ${done.usage.completion_tokens} completion`);
  console.log(`  output: ${output.length} cues, ${translation.length} characters, finish_reason=${done.finish_reason}`);
  console.log(`  time: ${seconds.toFixed(1)} s wall, ${done.timings.tokens_per_second} tokens/s generation`);
  console.log(`  missing numbers: ${list(r.missing)}`);
  console.log(`  unexpected numbers: ${list(r.unexpected)}`);
  console.log(`  duplicated numbers: ${list(r.duplicated)}`);
  console.log(`  out of order: ${r.outOfOrder}; empty cues: ${list(r.empty)}`);
  console.log(`  text merged into an earlier cue (the cues between left empty): ${list(r.merged)}`);
  console.log(
    `  text drifted to another number: ${list(r.shifted.map((s) => `${s.index}(${s.offset > 0 ? "+" : ""}${s.offset})`))}`,
  );
  console.log(`  text lost: ${list(r.lost)}`);
  console.log(`  not separated by a blank line: ${r.unseparated}; line count changed: ${r.lineCountChanged}`);
  if (outDir) {
    const name = `essays.${from}-${to}.${cues.length}`;
    await Bun.write(join(outDir, `${name}.source.srt`), toSrt(cues, style));
    await Bun.write(join(outDir, `${name}.wire.txt`), wire);
    await Bun.write(join(outDir, `${name}.output.txt`), translation);
  }
  return ok;
}

if (import.meta.main) {
  const base = (Bun.argv[2] ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const [, , , outDir] = Bun.argv;
  const fixture = (name: string) => Bun.file(join(import.meta.dir, "..", "test", "fixtures", name)).text();
  const passes = (Bun.env.PASSES ?? "en-zh,zh-en").split(",");
  let ok = true;
  if (passes.includes("en-zh")) {
    ok = (await runPass(base, "English -> Chinese", await fixture("essays.en.txt"), "en", "zh", outDir)) && ok;
  }
  if (passes.includes("zh-en")) {
    ok = (await runPass(base, "Chinese -> English", await fixture("essays.zh.txt"), "zh", "en", outDir)) && ok;
  }
  process.exit(ok ? 0 : 1);
}
