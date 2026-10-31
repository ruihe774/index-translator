import { expect, test } from "bun:test";

import { parseSrt, speakerColumn } from "../public/subtitles";
import { minutes, srtTime, transcriptionNotes, transcriptSrt } from "../public/transcription";

test("srtTime writes SubRip's clock", () => {
  expect(srtTime(0)).toBe("00:00:00,000");
  expect(srtTime(3723.4567)).toBe("01:02:03,457");
  expect(srtTime(-0.2)).toBe("00:00:00,000");
});

test("transcriptSrt: one cue per segment, the speaker before the text", () => {
  const srt = transcriptSrt([
    { start: 0.5, end: 2, speaker: "S01", text: "Hello there." },
    {
      start: 2.25,
      end: 2.25,
      speaker: "S02",
      text: "First line\n\nsecond line",
    },
  ]);
  expect(srt).toBe(
    "1\n00:00:00,500 --> 00:00:02,000\nS01: Hello there.\n\n2\n00:00:02,250 --> 00:00:02,250\nS02: First line\nsecond line\n",
  );
  const cues = parseSrt(srt)!;
  expect(cues.map((c) => c.lines)).toStrictEqual([["S01: Hello there."], ["S02: First line", "second line"]]);
  expect(speakerColumn(cues)).toBe(true);
  expect(transcriptSrt([])).toBe("");
});

test("transcriptSrt adds the offset of a recording that starts late in its file", () => {
  expect(transcriptSrt([{ start: 1, end: 2, speaker: "S01", text: "Hi." }], 20)).toContain(
    "00:00:21,000 --> 00:00:22,000",
  );
});

test("minutes for the status line", () => {
  expect(minutes(75.9)).toBe("1:15");
  expect(minutes(3725)).toBe("1:02:05");
});

test("transcriptionNotes", () => {
  const done = {
    duration: 60,
    speakers: ["S01"],
    separated: true,
    trimmed: false,
    truncated: true,
  };
  expect(transcriptionNotes(done, { cut: true, seconds: 1800 })).toStrictEqual([
    "Only the first 30:00 of the recording were transcribed: that is as much as the server takes.",
    "The transcription stopped early: the model reached its limit. What follows the last cue is missing.",
    "Music and background noise were taken out before transcribing.",
  ]);
  expect(
    transcriptionNotes({ ...done, separated: false, truncated: false }, { cut: false, seconds: 60 }),
  ).toStrictEqual([]);
});
