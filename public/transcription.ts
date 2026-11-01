// A transcription (`POST /transcriptions`) as SubRip: one cue per segment, its speaker as a label before
// the text (`S01: …`, which subtitles.ts shows as a column and keeps out of what is translated). Pure, so
// tested by bun test (test/transcription.test.ts).

import type { TranscriptionEvents, TranscriptSegment } from "../src/api.ts";
import { timeCues } from "./cue-timing.ts";
import { theServer } from "./server-name.ts";

/** `HH:MM:SS,mmm` of a time in seconds, as SubRip writes it. */
export function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)},${pad(ms % 1000, 3)}`;
}

/**
 * The segments as SubRip text, numbered from 1; `offset` (seconds) is added to every time (where the
 * recording starts in the file, media-file.ts). With `cuts` (cue-timing.ts `cutsOf`, empty without a
 * video) the cues are timed for reading; with null they keep the server's times. Blank lines inside a
 * segment's text would end its cue, so they are left out.
 */
export function transcriptSrt(
  segments: TranscriptSegment[],
  offset = 0,
  cuts: readonly number[] | null = null,
): string {
  const spans = segments.map((seg) => ({ start: seg.start + offset, end: seg.end + offset }));
  const times = cuts ? timeCues(spans, cuts) : spans;
  const cues = segments.map((seg, k) => {
    const { start } = times[k]!;
    const end = Math.max(times[k]!.end, start);
    const lines = seg.text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      lines[0] = `${seg.speaker}: ${lines[0]}`;
    }
    return [String(k + 1), `${srtTime(start)} --> ${srtTime(end)}`, ...lines].join("\n");
  });
  return cues.length > 0 ? `${cues.join("\n\n")}\n` : "";
}

/** `m:ss`, or `h:mm:ss` from an hour, for the status line. */
export function minutes(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** What to say once a transcription is done, about what was done to the recording. */
export function transcriptionNotes(
  done: TranscriptionEvents["done"],
  recording: { cut: boolean; seconds: number },
): string[] {
  const notes: string[] = [];
  if (recording.cut) {
    notes.push(
      `Only the first ${minutes(recording.seconds)} of the recording were transcribed: that is as much as ${theServer()} takes.`,
    );
  }
  if (done.truncated) {
    notes.push("The transcription stopped early: the model reached its limit. What follows the last cue is missing.");
  }
  if (done.separated) {
    notes.push("Music and background noise were taken out before transcribing.");
  }
  return notes;
}
