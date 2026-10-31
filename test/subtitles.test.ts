import { describe, expect, test } from "bun:test";

import { counterpart } from "../public/paragraphs";
import {
  clock,
  parseSrt,
  shownText,
  styledRuns,
  subtitleAlignment,
  subtitleNotes,
  toWire,
  translateSubtitles,
} from "../public/subtitles";

const SRT = `1
00:00:01,000 --> 00:00:02,500
Hello there.

2
00:00:03,000 --> 00:00:04,000
{\\an8}<i>How are</i>
you?

3
00:00:05,000 --> 00:00:06,000 X1:10 X2:20 Y1:30 Y2:40
Fine.
`;

describe("parseSrt", () => {
  test("reads number, timing, tag and lines, and where each cue starts", () => {
    const cues = parseSrt(SRT)!;
    expect(cues.map((c) => c.index)).toStrictEqual(["1", "2", "3"]);
    expect(cues.map((c) => c.line)).toStrictEqual([0, 4, 9]);
    expect(cues[0]).toMatchObject({ start: 1000, end: 2500, tag: "", lines: ["Hello there."] });
    expect(cues[1]).toMatchObject({ tag: "{\\an8}", lines: ["<i>How are</i>", "you?"] });
    expect(cues[2]!.timing).toBe("00:00:05,000 --> 00:00:06,000 X1:10 X2:20 Y1:30 Y2:40");
  });

  test("takes a byte order mark, blank lines first, dots for commas, a blank line inside a cue and no final newline", () => {
    const cues = parseSrt("﻿\n\n7\n0:00:01.5 --> 0:00:02.25\nOne\n\nstill one\n8\n00:00:03,000 --> 00:00:04,000\nTwo")!;
    expect(cues.map((c) => [c.index, c.start, c.end, c.lines])).toStrictEqual([
      ["7", 1500, 2250, ["One", "still one"]],
      ["8", 3000, 4000, ["Two"]],
    ]);
  });

  test("keeps a cue with no text", () => {
    const cues = parseSrt("1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\nText\n")!;
    expect(cues.map((c) => c.lines)).toStrictEqual([[], ["Text"]]);
  });

  test("is not subtitles: plain text, a numbered list, text before the first cue, nothing", () => {
    expect(parseSrt("Hello\nworld")).toBeNull();
    expect(parseSrt("1\nFirst item\n\n2\nSecond item")).toBeNull();
    expect(parseSrt(`Subtitles:\n\n${SRT}`)).toBeNull();
    expect(parseSrt("  \n")).toBeNull();
  });
});

describe("toWire", () => {
  test("numbers the cues with text from 1, without timing or tags", () => {
    const cues = parseSrt(`${SRT}\n4\n00:00:07,000 --> 00:00:08,000\n\n5\n00:00:09,000 --> 00:00:10,000\nBye.\n`)!;
    const wire = toWire(cues);
    expect(wire.text).toBe("1\nHello there.\n\n2\n<i>How are</i>\nyou?\n\n3\nFine.\n\n4\nBye.");
    expect(wire.sent).toStrictEqual([0, 1, 2, 4]);
  });
});

function translate(output: string, progress: "streaming" | "complete" | "partial", srt = SRT) {
  const cues = parseSrt(srt)!;
  return translateSubtitles(cues, toWire(cues), output, progress);
}

describe("translateSubtitles", () => {
  test("puts each number's text under the source's index and timing, the tag back in front", () => {
    const t = translate("1\n你好。\n\n2\n<i>你好</i>\n吗？\n\n3\n很好。", "complete");
    expect(t.srt).toBe(
      "1\n00:00:01,000 --> 00:00:02,500\n你好。\n\n" +
        "2\n00:00:03,000 --> 00:00:04,000\n{\\an8}<i>你好</i>\n吗？\n\n" +
        "3\n00:00:05,000 --> 00:00:06,000 X1:10 X2:20 Y1:30 Y2:40\n很好。\n",
    );
    expect(subtitleNotes(t)).toStrictEqual([]);
  });

  test("an empty number, or a skipped one, joins the cue before: first start to last end", () => {
    for (const output of ["1\n你好，你好吗？\n\n2\n\n3\n很好。", "1\n你好，你好吗？\n\n3\n很好。"]) {
      const t = translate(output, "complete");
      expect(t.srt).toBe(
        "1\n00:00:01,000 --> 00:00:04,000\n你好，你好吗？\n\n" +
          "3\n00:00:05,000 --> 00:00:06,000 X1:10 X2:20 Y1:30 Y2:40\n很好。\n",
      );
      expect(t.joined).toStrictEqual(["2"]);
    }
  });

  test("numbers missing at the end join the last cue when complete, and are untranslated when cut short", () => {
    const complete = translate("1\n你好。\n\n2\n你好吗？很好。", "complete");
    expect(complete.srt).toEndWith("2\n00:00:03,000 --> 00:00:06,000 X1:10 X2:20 Y1:30 Y2:40\n{\\an8}你好吗？很好。\n");
    expect(complete.joined).toStrictEqual(["3"]);
    const partial = translate("1\n你好。\n\n2\n你好吗？", "partial");
    expect(partial.srt).toEndWith("2\n00:00:03,000 --> 00:00:04,000\n{\\an8}你好吗？\n");
    expect(partial.untranslated).toStrictEqual(["3"]);
    expect(subtitleNotes(partial)).toStrictEqual(["Cue 3 was not translated."]);
  });

  test("while streaming, a number with no text yet neither shows nor stretches the cue before", () => {
    const t = translate("1\n你好。\n\n2\n", "streaming");
    expect(t.srt).toBe("1\n00:00:01,000 --> 00:00:02,500\n你好。\n");
    expect(t.untranslated).toStrictEqual([]);
    // The text written so far of the entry being written is shown.
    expect(translate("1\n你好。\n\n2\n你", "streaming").srt).toEndWith("{\\an8}你\n");
  });

  test("each step of a stream keeps what came before", () => {
    const output = "1\n你好。\n\n2\n你好\n吗？\n\n3\n很好。";
    let previous = "";
    for (let end = 1; end <= output.length; end++) {
      const { srt } = translate(output.slice(0, end), "streaming");
      // Only the last cue may change: everything before its block stays.
      const stable = previous.slice(0, previous.lastIndexOf("\n\n") + 1);
      expect(srt.startsWith(stable)).toBe(true);
      previous = srt;
    }
  });

  test("text before the first number, a number going back and one past the end are left out", () => {
    const t = translate("Here you go:\n\n1\n你好。\n\n1\n重复\n\n2\n你好吗？\n\n3\n很好。\n\n4\n多余", "complete");
    // The tag goes back in front of cue 2, and is read apart from the text again.
    expect(parseSrt(t.srt)!.map((c) => c.lines)).toStrictEqual([["你好。"], ["你好吗？"], ["很好。"]]);
    expect(t.dropped).toBe(3);
    expect(subtitleNotes(t)).toStrictEqual(["3 lines of the translation outside the numbered cues were left out."]);
  });

  test("a line holding only a number is text unless it follows a blank line or is the next number", () => {
    const t = translate("1\n你好。\n2025\n\n2\n你好吗？\n\n3\n很好。", "complete");
    expect(parseSrt(t.srt)![0]!.lines).toStrictEqual(["你好。", "2025"]);
  });

  test("cues with no text keep their place, and are not translated past where the translation stopped", () => {
    const srt =
      "1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:03,000 --> 00:00:04,000\n\n3\n00:00:05,000 --> 00:00:06,000\nB\n\n4\n00:00:07,000 --> 00:00:08,000\n";
    expect(translate("1\na\n\n2\nb", "complete", srt).srt).toBe(
      "1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:03,000 --> 00:00:04,000\n\n" +
        "3\n00:00:05,000 --> 00:00:06,000\nb\n\n4\n00:00:07,000 --> 00:00:08,000\n",
    );
    const partial = translate("1\na", "partial", srt);
    expect(partial.srt).toBe("1\n00:00:01,000 --> 00:00:02,000\na\n");
    expect(partial.untranslated).toStrictEqual(["2", "3", "4"]);
  });

  test("nothing written", () => {
    expect(translate("", "complete")).toStrictEqual({ srt: "", joined: [], dropped: 0, untranslated: ["1", "2", "3"] });
  });
});

describe("subtitleAlignment", () => {
  test("matches each cue of the translation with the source cues it covers, by line", () => {
    const t = translate("1\n你好，你好吗？\n\n3\n很好。", "complete");
    const a = subtitleAlignment(SRT, t.srt)!;
    expect(a.source).toStrictEqual([0, 4, 9]);
    expect(a.output).toStrictEqual([0, 4]);
    expect(a.groups).toStrictEqual([
      { source: [0, 1], output: [0] },
      { source: [2], output: [1] },
    ]);
    // Clicking the second source cue (line 6, its text) leads to the first cue of the translation.
    expect(counterpart(a, "source", 6)).toStrictEqual({ own: { from: 0, to: 9 }, other: { from: 0, to: 4 } });
  });

  test("source cues after the last translated one have no counterpart", () => {
    const t = translate("1\n你好。", "partial");
    expect(subtitleAlignment(SRT, t.srt)!.groups).toStrictEqual([
      { source: [0], output: [0] },
      { source: [1], output: [] },
      { source: [2], output: [] },
    ]);
    expect(subtitleAlignment(SRT, "")!.groups).toHaveLength(3);
  });

  test("is null for a translation that is not of this source", () => {
    expect(subtitleAlignment(SRT, "9\n00:00:01,000 --> 00:00:02,500\nX\n")).toBeNull();
    expect(subtitleAlignment(SRT, "just text")).toBeNull();
  });
});

describe("notes", () => {
  test("joined cues are listed, a few at most", () => {
    expect(subtitleNotes({ srt: "", joined: ["2"], dropped: 0, untranslated: [] })[0]).toStartWith(
      "The translation put cue 2 together with the cue before it:",
    );
    expect(subtitleNotes({ srt: "", joined: ["2", "5"], dropped: 0, untranslated: [] })[0]).toStartWith(
      "The translation put cues 2 and 5 together with the cue before them:",
    );
    const notes = subtitleNotes({
      srt: "",
      joined: ["2", "5", "8", "9", "12"],
      dropped: 1,
      untranslated: ["20", "21"],
    });
    expect(notes[0]).toContain("cues 2, 5, 8 and 2 more");
    expect(notes.slice(1)).toStrictEqual([
      "A line of the translation outside the numbered cues was left out.",
      "Cues 20 to 21 were not translated.",
    ]);
  });
});

describe("display", () => {
  test("styling tags become runs; font tags go", () => {
    expect(styledRuns('<i>a <b>b</b></i> <font color="red">c</font>')).toStrictEqual([
      { text: "a ", styles: ["i"] },
      { text: "b", styles: ["i", "b"] },
      { text: " ", styles: [] },
      { text: "c", styles: [] },
    ]);
    expect(shownText(["<i>How are</i>", "you?"])).toBe("How are\nyou?");
  });

  test("clock", () => {
    expect(clock(0)).toBe("0:00:00");
    expect(clock(3_723_400)).toBe("1:02:03");
  });
});
