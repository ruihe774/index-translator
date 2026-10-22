// Detects translations that dropped, merged or repeated paragraphs. Pure, so bun test can import it.
//
// "Paragraph" depends on how the text is written: Western prose separates paragraphs with blank
// lines, but Chinese and Japanese text, subtitles and lists often use a single newline. The unit is
// taken from the source, and the translation is counted by the same unit, so a model that adds or
// removes blank lines does not cause a false warning. A drop and a repeat that cancel out are not
// noticed.
//
// When the counts match, block i of the source is taken to be block i of the translation. When they do
// not, the page asks `POST /align` which blocks match which (`alignFromPairs`), which also tells where
// the translation went wrong (`mismatchDetails`).

import type { Side } from "./state.ts";

/** Fewer blocks than this are not worth checking. */
export const MIN_BLOCKS = 3;

export type Unit = "paragraphs" | "lines";

export interface Mismatch {
  unit: Unit;
  source: number;
  output: number;
}

const BLANK = /^\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Whether each line is part of a fenced code block, its fences included (CommonMark's rule: a closing
 * fence is a run of the opening's character, at least as long, and nothing else). An unclosed one runs to
 * the end. A blank line in code separates nothing.
 */
function inFences(lines: string[]): boolean[] {
  let open: string | null = null;
  return lines.map((line) => {
    const fence = FENCE.exec(line)?.[1];
    if (open === null) {
      open = fence ?? null;
      return open !== null;
    }
    if (fence?.startsWith(open[0]!) && fence.length >= open.length && line.trim() === fence) {
      open = null;
    }
    return true;
  });
}

/** Blank-line separated paragraphs if the source has any blank line outside code, otherwise one per line. */
export function unitOf(source: string): Unit {
  const lines = source.trim().split("\n");
  const code = inFences(lines);
  return lines.some((line, i) => BLANK.test(line) && !code[i]) ? "paragraphs" : "lines";
}

export function countBlocks(text: string, unit: Unit): number {
  return blockStarts(text, unit).length;
}

/** The counts when the translation does not have as many blocks as the source, else null. */
export function paragraphMismatch(source: string, output: string): Mismatch | null {
  const unit = unitOf(source);
  const sourceBlocks = countBlocks(source, unit);
  if (sourceBlocks < MIN_BLOCKS) {
    return null;
  }
  const outputBlocks = countBlocks(output, unit);
  return sourceBlocks === outputBlocks ? null : { unit, source: sourceBlocks, output: outputBlocks };
}

export function mismatchMessage(m: Mismatch): string {
  const noun = m.unit === "lines" ? "lines" : "paragraphs";
  return `The source has ${m.source} ${noun} and the translation has ${m.output}. Parts may have been dropped, merged or repeated; check it against the source.`;
}

/**
 * Index of the first line of each block: each non-blank line (`lines`), or each line after a run of blank
 * lines (`paragraphs`), where a fenced code block is one block whatever blank lines it holds.
 */
export function blockStarts(text: string, unit: Unit): number[] {
  const lines = text.split("\n");
  const code = unit === "paragraphs" ? inFences(lines) : [];
  const starts: number[] = [];
  let previousBlank = true;
  lines.forEach((line, i) => {
    // Inside code (past its opening fence) nothing starts a block or ends one.
    if (code[i] && code[i - 1]) {
      previousBlank = false;
      return;
    }
    const blank = BLANK.test(line);
    if (!blank && (unit === "lines" || previousBlank)) {
      starts.push(i);
    }
    previousBlank = blank;
  });
  return starts;
}

/** Consecutive blocks of the source and of the translation that translate each other; an empty side: no counterpart. */
export interface BlockGroup {
  source: number[];
  output: number[];
}

export interface Alignment {
  unit: Unit;
  /** First line of each block, in the source and in the translation. */
  source: number[];
  output: number[];
  /** Every block of both texts in exactly one group, in the order of both. */
  groups: BlockGroup[];
}

/**
 * Block i of the source matched to block i of the translation, when both have the same number of
 * blocks (so the paragraph check passed), else null.
 */
export function alignBlocks(source: string, output: string): Alignment | null {
  const unit = unitOf(source);
  const s = blockStarts(source, unit);
  const o = blockStarts(output, unit);
  if (s.length === 0 || s.length !== o.length) {
    return null;
  }
  return { unit, source: s, output: o, groups: s.map((_, i) => ({ source: [i], output: [i] })) };
}

/**
 * Fewest source blocks `POST /align` is asked to match. Measured on slices of machine translations (long
 * prose; short Markdown documents with tables, code and lists) with one block dropped, merged, split or
 * repeated: from 8 blocks no slice had a wrong one-to-one pair; at 3 to 6 blocks some did (6 to 11 per
 * slice size, of a few hundred cases), which would name the wrong place.
 */
export const MIN_MATCHED_BLOCKS = 8;

/** Whether the source's blocks are worth asking `POST /align` about: enough of them to be matched reliably. */
export function matchable(blocks: string[]): boolean {
  return blocks.length >= MIN_MATCHED_BLOCKS;
}

/** The text of each block, as `blockStarts` finds them, trimmed. */
export function blockTexts(text: string, unit: Unit): string[] {
  const lines = text.split("\n");
  const starts = blockStarts(text, unit);
  return starts.map((from, k) =>
    lines
      .slice(from, starts[k + 1] ?? lines.length)
      .join("\n")
      .trim(),
  );
}

/**
 * The alignment told by `POST /align` for the blocks of `source` and `output` (`blockTexts`, in the
 * source's unit), or null when its pairs do not cover both in order.
 */
export function alignFromPairs(
  source: string,
  output: string,
  pairs: { source: number[]; target: number[] }[],
): Alignment | null {
  const unit = unitOf(source);
  const s = blockStarts(source, unit);
  const o = blockStarts(output, unit);
  const groups = pairs.map((p) => ({ source: p.source, output: p.target }));
  const inOrder = (side: Side, count: number) => {
    const all = groups.flatMap((g) => g[side]);
    return all.length === count && all.every((b, i) => b === i);
  };
  return inOrder("source", s.length) && inOrder("output", o.length) ? { unit, source: s, output: o, groups } : null;
}

/** Lines `from` up to `to` (not included) of one text. */
export interface LineRange {
  from: number;
  to: number;
}

function linesOf(a: Alignment, side: Side, blocks: number[]): LineRange | null {
  const starts = a[side];
  const [first] = blocks;
  const last = blocks.at(-1);
  return first === undefined || last === undefined
    ? null
    : { from: starts[first]!, to: starts[last + 1] ?? Number.POSITIVE_INFINITY };
}

/**
 * The lines of the group that holds `line` of `side`, and of its counterpart in the other text, or null
 * when it has none (a block the translation left out, or one it added).
 */
export function counterpart(a: Alignment, side: Side, line: number): { own: LineRange; other: LineRange } | null {
  const k = blockAt(a[side], line);
  const group = a.groups.find((g) => g[side].includes(k));
  if (!group) {
    return null;
  }
  const own = linesOf(a, side, group[side]);
  const other = linesOf(a, side === "source" ? "output" : "source", group[side === "source" ? "output" : "source"]);
  return own && other ? { own, other } : null;
}

/** Places listed in a detailed mismatch note; the rest are counted. */
export const MAX_LISTED = 5;

/** "paragraph 3", "paragraphs 3–4" (1-based). */
function blocksName(unit: Unit, blocks: number[]): string {
  const noun = unit === "lines" ? "line" : "paragraph";
  const first = blocks[0]! + 1;
  const last = blocks.at(-1)! + 1;
  return first === last ? `${noun} ${first}` : `${noun}s ${first}–${last}`;
}

const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * What the alignment found wrong, place by place: blocks left out, added, and several matched with one
 * (merged or split, or a short block left out or added beside them, which the matching often cannot
 * tell apart). Neighbouring groups with no counterpart on the same side are told as one place.
 */
export function mismatchDetails(a: Alignment): string[] {
  const places: string[] = [];
  const groups = a.groups.filter((g) => g.source.length !== 1 || g.output.length !== 1);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    if (g.output.length === 0 || g.source.length === 0) {
      const side: Side = g.output.length === 0 ? "source" : "output";
      const blocks = [...g[side]];
      // Runs of lone blocks next to each other.
      while (
        groups[i + 1]?.[side === "source" ? "output" : "source"].length === 0 &&
        groups[i + 1]![side][0] === blocks.at(-1)! + 1
      ) {
        blocks.push(...groups[++i]![side]);
      }
      const many = blocks.length > 1;
      places.push(
        side === "source"
          ? `${capital(blocksName(a.unit, blocks))} of the source ${many ? "seem" : "seems"} to be missing from the translation.`
          : `${capital(blocksName(a.unit, blocks))} of the translation ${many ? "have" : "has"} no counterpart in the source (added or repeated).`,
      );
    } else if (g.output.length === 1) {
      // A short block left out is often matched this way too, joined to its neighbour: both are said.
      places.push(
        `${capital(blocksName(a.unit, g.source))} of the source match only ${blocksName(a.unit, g.output)} of the translation: merged, or one is missing.`,
      );
    } else if (g.source.length === 1) {
      places.push(
        `${capital(blocksName(a.unit, g.source))} of the source matches ${blocksName(a.unit, g.output)} of the translation: split, or one was added.`,
      );
    } else {
      places.push(
        `${capital(blocksName(a.unit, g.source))} of the source and ${blocksName(a.unit, g.output)} of the translation only match as a whole.`,
      );
    }
  }
  return places;
}

/** `mismatchMessage` with the places the alignment found, when it found any. */
export function detailedMismatchMessage(m: Mismatch, a: Alignment): string {
  const places = mismatchDetails(a);
  if (places.length === 0) {
    return mismatchMessage(m);
  }
  const noun = m.unit === "lines" ? "lines" : "paragraphs";
  const listed = places.slice(0, MAX_LISTED);
  const more = places.length - listed.length;
  return [
    `The source has ${m.source} ${noun} and the translation has ${m.output}.`,
    ...listed,
    ...(more > 0 ? [`There ${more === 1 ? "is 1 other place" : `are ${more} other places`} like these.`] : []),
    places.length === 1 ? "Check it against the source." : "Check them against the source.",
  ].join(" ");
}

/** The block that holds `line`: the last one starting at or before it (the first, before any). */
export function blockAt(starts: number[], line: number): number {
  let k = 0;
  while (k + 1 < starts.length && starts[k + 1]! <= line) {
    k++;
  }
  return k;
}
