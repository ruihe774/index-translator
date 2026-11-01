// Captions on the video a transcript was made from: the transcript's cues, the translation's, and both
// together, as WebVTT cues for the player's text tracks (media-ui.ts). Pure, so bun test can import it.
//
// Both together are one cue for each stretch of time in which the same cues of either side are on screen,
// the translation's lines above the original's, as bilingual subtitles are laid out: a translated cue the model joined spans several of the
// original's, and two overlapping cues would be stacked by the browser in whichever order it laid them out.

import { type Cue, isSpeakerId, speakerColumn, splitSpeakers, styledRuns } from "./subtitles.ts";

export interface Caption {
  /** Seconds into what is played. */
  start: number;
  end: number;
  /** WebVTT cue text. */
  text: string;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

const escape = (s: string) => s.replaceAll(/[&<>]/g, (c) => ESCAPES[c]!);

/** A SubRip line as WebVTT cue text: `<i>`, `<b>` and `<u>` kept, `<font>` dropped, the rest escaped. */
export function vttLine(line: string): string {
  return styledRuns(line)
    .map((r) => r.styles.reduceRight((inner, s) => `<${s}>${inner}</${s}>`, escape(r.text)))
    .join("");
}

/**
 * The cues as captions, `offset` seconds into the file being where what is played starts. Speaker ids
 * (`S01:`) are left out, as in the table's text column; a name stays, being part of what is said.
 */
export function captions(cues: Cue[], offset = 0): Caption[] {
  const ids = speakerColumn(cues);
  const out: Caption[] = [];
  for (const cue of cues) {
    const split = splitSpeakers(cue.lines);
    const lines = cue.lines.map((line, i) => {
      const label = split.speakers[i];
      return ids && label && isSpeakerId(label) ? split.lines[i]! : line;
    });
    const text = lines.map(vttLine).join("\n").trim();
    const start = Math.max(0, cue.start / 1000 - offset);
    const end = cue.end / 1000 - offset;
    if (text && end > start) {
      out.push({ start, end, text });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The translation's captions above the original's, one cue for each stretch in which the same ones of
 * either side are shown. Each side is marked with its language, when known, for the glyphs it is drawn in.
 */
export function bilingual(
  original: Caption[],
  translation: Caption[],
  langs: { original?: string | undefined; translation?: string | undefined } = {},
): Caption[] {
  const tagged = (side: Caption[], lang: string | undefined, rank: number) =>
    side.map((c) => ({ ...c, rank, text: lang ? `<lang ${lang}>${c.text}</lang>` : c.text }));
  const all = [...tagged(translation, langs.translation, 0), ...tagged(original, langs.original, 1)].sort(
    (a, b) => a.start - b.start || a.rank - b.rank,
  );
  const times = [...new Set(all.flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
  const out: Caption[] = [];
  let active: typeof all = [];
  let next = 0;
  for (const [k, from] of times.entries()) {
    const to = times[k + 1];
    if (to === undefined) {
      break;
    }
    active = active.filter((c) => c.end > from);
    while (next < all.length && all[next]!.start <= from) {
      active.push(all[next++]!);
    }
    if (active.length === 0) {
      continue;
    }
    const text = active
      .toSorted((a, b) => a.rank - b.rank || a.start - b.start)
      .map((c) => c.text)
      .join("\n");
    const last = out.at(-1);
    if (last?.end === from && last.text === text) {
      last.end = to;
    } else {
      out.push({ start: from, end: to, text });
    }
  }
  return out;
}
