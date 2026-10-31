import { describe, expect, test } from "bun:test";

import { counterpart } from "../public/paragraphs";
import {
  type Chunk,
  chunkCuts,
  chunkText,
  clock,
  parseSrt,
  planChunks,
  shownText,
  speakerColumn,
  splitSpeakers,
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

describe("speakers", () => {
  const cue = (n: number, ...lines: string[]) => `${n}\n00:00:0${n},000 --> 00:00:0${n},900\n${lines.join("\n")}`;
  const srt = (...cues: string[]) => `${cues.join("\n\n")}\n`;

  test("a column when every cue starts with a label that comes back, or with ids", () => {
    const column = (text: string) => speakerColumn(parseSrt(text)!);
    expect(column(srt(cue(1, "S01: Hello."), cue(2, "S02: Hi.")))).toBe(true);
    expect(column(srt(cue(1, "S01: Hello.")))).toBe(true);
    expect(column(srt(cue(1, "JOHN: Hello."), cue(2, "MARY: Hi."), cue(3, "JOHN: Bye.")))).toBe(true);
    expect(column(srt(cue(1, "张三：你好。"), cue(2, "张三：再见。")))).toBe(true);
    // Two different words before a colon are not speakers; nor are a time, a link or one cue without.
    expect(column(srt(cue(1, "Note: one."), cue(2, "Warning: two.")))).toBe(false);
    expect(column(srt(cue(1, "10:30 it starts"), cue(2, "10:30 again")))).toBe(false);
    expect(column(srt(cue(1, "https://example.com"), cue(2, "https://example.com")))).toBe(false);
    expect(column(srt(cue(1, "S01: Hello."), cue(2, "Hi.")))).toBe(false);
    // A transcript may hear more than 12 voices; more than 12 names are not speakers.
    const many = (label: (n: number) => string) =>
      srt(
        ...[...Array.from({ length: 14 }, (_, k) => label(k)), label(0)].map(
          (l, k) => `${k + 1}\n00:00:${String(k + 10).padStart(2, "0")},000 --> 00:00:${k + 10},500\n${l}: line`,
        ),
      );
    expect(parseSrt(many((k) => `S${k}`))).toHaveLength(15);
    expect(column(many((k) => `S${String(k + 1).padStart(2, "0")}`))).toBe(true);
    expect(column(many((k) => `Name${k}`))).toBe(false);
  });

  test("splitSpeakers takes the label off every line that has one", () => {
    expect(splitSpeakers(["S01: Hello.", "still S01", "S02: Hi."])).toStrictEqual({
      speakers: ["S01", null, "S02"],
      lines: ["Hello.", "still S01", "Hi."],
    });
  });

  test("ids are not sent and come back on the translation", () => {
    const source = srt(cue(1, "S01: Hello."), cue(2, "S02: How are you?"), cue(3, "S02: Fine."));
    const cues = parseSrt(source)!;
    const wire = toWire(cues);
    expect(wire.text).toBe("1\nHello.\n\n2\nHow are you?\n\n3\nFine.");
    const t = translateSubtitles(cues, wire, "1\n你好。\n\n2\n你好吗？\n\n3\n很好。", "complete");
    expect(parseSrt(t.srt)!.map((c) => c.lines)).toStrictEqual([["S01: 你好。"], ["S02: 你好吗？"], ["S02: 很好。"]]);
  });

  test("joined cues of different speakers name them all", () => {
    const cues = parseSrt(srt(cue(1, "S01: Hello,"), cue(2, "S02: hi.")))!;
    const t = translateSubtitles(cues, toWire(cues), "1\n你好，你好。\n\n2\n", "complete");
    expect(parseSrt(t.srt)!.map((c) => c.lines)).toStrictEqual([["S01 / S02: 你好，你好。"]]);
    // Such a translation, translated again, keeps them.
    const again = parseSrt(t.srt)!;
    expect(toWire(again).text).toBe("1\n你好，你好。");
  });

  test("a cue with a label on each line, translated line for line, keeps them on their lines", () => {
    const cues = parseSrt(srt(cue(1, "S01: Hello.", "S02: Hi.")))!;
    expect(toWire(cues).text).toBe("1\nHello.\nHi.");
    const t = translateSubtitles(cues, toWire(cues), "1\n你好。\n嗨。", "complete");
    expect(parseSrt(t.srt)![0]!.lines).toStrictEqual(["S01: 你好。", "S02: 嗨。"]);
  });

  test("names stay in the text for the model", () => {
    const cues = parseSrt(srt(cue(1, "JOHN: Hello."), cue(2, "JOHN: Bye.")))!;
    const wire = toWire(cues);
    expect(wire.text).toBe("1\nJOHN: Hello.\n\n2\nJOHN: Bye.");
    expect(wire.speakers).toBeUndefined();
  });
});

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

/**
 * `n` cues a second apart (`gapBefore`: positions with a 3 s gap before them instead), cue i saying
 * `text(i)`; no sentence ends unless `text` writes them.
 */
function manyCues(n: number, text = (i: number) => `line ${i}`, gapBefore: number[] = []) {
  const stamp = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  let at = 0;
  const blocks = Array.from({ length: n }, (_, k) => {
    at += gapBefore.includes(k) ? 3000 : 200;
    const start = at;
    at += 800;
    return `${k + 1}\n${stamp(start)} --> ${stamp(at)}\n${text(k + 1)}`;
  });
  const cues = parseSrt(blocks.join("\n\n"))!;
  return { cues, wire: toWire(cues) };
}

/** What a model writes for `chunk`: number i's text is `write(i)` (i of the whole file), null leaving it empty. */
function written(chunk: Chunk, write: (i: number) => string | null): string {
  return Array.from(
    { length: chunk.end - chunk.start },
    (_, k) => `${k + 1}\n${write(chunk.start + k + 1) ?? ""}`,
  ).join("\n\n");
}

const LIMITS = { cues: 100, overlap: 16, letters: 100_000 };

describe("planChunks", () => {
  test("one chunk while it fits", () => {
    const { cues, wire } = manyCues(100);
    expect(planChunks(cues, wire, LIMITS)).toStrictEqual([{ start: 0, end: 100 }]);
  });

  test("the next chunk starts `overlap` cues before the end of the one before", () => {
    const { cues, wire } = manyCues(250);
    expect(planChunks(cues, wire, LIMITS)).toStrictEqual([
      { start: 0, end: 100 },
      { start: 84, end: 184 },
      { start: 168, end: 250 },
    ]);
  });

  test("moved earlier, by up to half the overlap, to where a sentence or a scene starts", () => {
    const sentence = manyCues(150, (i) => (i === 81 ? "The end." : `line ${i}`));
    expect(planChunks(sentence.cues, sentence.wire, LIMITS)[1]!.start).toBe(81);
    const scene = manyCues(150, undefined, [79]);
    expect(planChunks(scene.cues, scene.wire, LIMITS)[1]!.start).toBe(79);
    const tooFar = manyCues(150, (i) => (i === 70 ? "The end." : `line ${i}`));
    expect(planChunks(tooFar.cues, tooFar.wire, LIMITS)[1]!.start).toBe(84);
  });

  test("at most `letters` letters, the overlap at most half a chunk; every chunk reaches past the one before the last", () => {
    const { cues, wire } = manyCues(60, (i) => "x".repeat(i % 7 === 0 ? 900 : 90));
    const chunks = planChunks(cues, wire, { cues: 100, overlap: 16, letters: 1000 });
    // Cue 7 has 900 letters: the first chunk ends before it, the second takes it however long it is.
    expect(chunks.slice(0, 2)).toStrictEqual([
      { start: 0, end: 6 },
      { start: 3, end: 7 },
    ]);
    chunks.forEach((c, k) => {
      expect(c.end).toBeGreaterThan(c.start);
      if (k > 0) {
        expect(c.start).toBeLessThan(chunks[k - 1]!.end);
      }
      if (k > 1) {
        expect(c.start).toBeGreaterThanOrEqual(chunks[k - 2]!.end);
      }
    });
    expect(chunks.at(-1)!.end).toBe(60);
  });

  test("a chunk's text is numbered from 1", () => {
    const { wire } = manyCues(5);
    expect(chunkText(wire, { start: 3, end: 5 })).toBe("1\nline 4\n\n2\nline 5");
  });
});

describe("translating in chunks", () => {
  const { cues, wire } = manyCues(150);
  const [first, second] = planChunks(cues, wire, LIMITS) as [Chunk, Chunk];
  /** The first chunk writes T, the second U, so the cues tell which one they came from. */
  const outputs = (a: (i: number) => string | null, b: (i: number) => string | null, bChunk = second) => [
    { chunk: first, output: written(first, a) },
    { chunk: bChunk, output: written(bChunk, b) },
  ];
  const texts = (srt: string) => parseSrt(srt)!.map((c) => c.lines.join(" "));

  test("one chunk is the same as one output", () => {
    const whole = { start: 0, end: 150 };
    const output = written(whole, (i) => `T${i}`);
    expect(translateSubtitles(cues, wire, [{ chunk: whole, output }], "complete")).toStrictEqual(
      translateSubtitles(cues, wire, output, "complete"),
    );
  });

  test("passes to the next chunk in the middle of the overlap", () => {
    expect(second.start).toBe(84);
    const t = translateSubtitles(
      cues,
      wire,
      outputs(
        (i) => `T${i}`,
        (i) => `U${i}`,
      ),
      "complete",
    );
    const out = texts(t.srt);
    expect(out).toHaveLength(150);
    expect(out.slice(90, 94)).toStrictEqual(["T91", "T92", "U93", "U94"]);
    expect(subtitleNotes(t)).toStrictEqual([]);
  });

  test("prefers where a sentence starts", () => {
    const ended = manyCues(150, (i) => (i === 95 ? "The end." : `line ${i}`));
    const chunks = planChunks(ended.cues, ended.wire, LIMITS);
    expect(chunks[1]!.start).toBe(84);
    const outs = chunks.slice(0, 2).map((chunk, k) => ({ chunk, output: written(chunk, (i) => `${"TU"[k]}${i}`) }));
    expect(chunkCuts(ended.cues, ended.wire, outs)).toStrictEqual([96]);
  });

  test("only where both chunks start a cue's text, so neither one's group of cues is cut in two", () => {
    // The first joined 92 to 94, the second 91 to 93: of the places nearest the middle (93), 92 to 94 are
    // inside one group or the other, 91 and 95 are not.
    const cut = chunkCuts(
      cues,
      wire,
      outputs(
        (i) => (i === 93 || i === 94 ? null : `T${i}`),
        (i) => (i === 92 || i === 93 ? null : `U${i}`),
      ),
    );
    expect(cut).toStrictEqual([91]);
  });

  test("with no such place, the next chunk takes over after the overlap, its group before joining the cue before", () => {
    // The second chunk wrote everything up to 102 under its first number.
    const t = translateSubtitles(
      cues,
      wire,
      outputs(
        (i) => `T${i}`,
        (i) => (i === 85 ? "U85" : i <= 102 ? null : `U${i}`),
      ),
      "complete",
    );
    const out = texts(t.srt);
    expect(out[99]).toBe("T100");
    expect(out[100]).toBe("U103");
    expect(t.joined).toStrictEqual(["101", "102"]);
  });

  test("while the next chunk is within the overlap, the chunk before is shown; once past it, the cut", () => {
    const within = { chunk: second, output: written({ start: 84, end: 96 }, (i) => `U${i}`) };
    const early = translateSubtitles(
      cues,
      wire,
      [
        outputs(
          (i) => `T${i}`,
          () => null,
        )[0]!,
        within,
      ],
      "streaming",
    );
    expect(texts(early.srt)).toHaveLength(100);
    expect(texts(early.srt)[99]).toBe("T100");
    const past = { chunk: second, output: written({ start: 84, end: 102 }, (i) => `U${i}`) };
    const later = translateSubtitles(
      cues,
      wire,
      [
        outputs(
          (i) => `T${i}`,
          () => null,
        )[0]!,
        past,
      ],
      "streaming",
    );
    expect(texts(later.srt).slice(91, 93)).toStrictEqual(["T92", "U93"]);
    expect(texts(later.srt)).toHaveLength(102);
  });

  test("stopped in the next chunk: what follows is untranslated", () => {
    const part = { chunk: second, output: written({ start: 84, end: 110 }, (i) => `U${i}`) };
    const t = translateSubtitles(
      cues,
      wire,
      [
        outputs(
          (i) => `T${i}`,
          () => null,
        )[0]!,
        part,
      ],
      "partial",
    );
    expect(texts(t.srt)).toHaveLength(110);
    expect(t.untranslated).toHaveLength(40);
    expect(t.untranslated[0]).toBe("111");
  });

  test("speaker ids come back across chunks", () => {
    const speakers = manyCues(150, (i) => `S0${i % 2}: line ${i}`);
    const chunks = planChunks(speakers.cues, speakers.wire, LIMITS);
    expect(chunkText(speakers.wire, chunks[1]!)).toStartWith("1\nline 85\n\n2\nline 86");
    const outs = chunks.map((chunk) => ({ chunk, output: written(chunk, (i) => `T${i}`) }));
    const out = texts(translateSubtitles(speakers.cues, speakers.wire, outs, "complete").srt);
    expect(out[120]).toBe("S01: T121");
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
