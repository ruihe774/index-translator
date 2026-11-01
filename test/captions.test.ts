import { describe, expect, test } from "bun:test";

import { bilingual, type Caption, captions, vttLine } from "../public/captions";
import { parseSrt } from "../public/subtitles";

const srt = (text: string) => parseSrt(text)!;

describe("vttLine", () => {
  test("keeps SubRip's styles, drops <font> and escapes the rest", () => {
    expect(vttLine("<i>a & <b>b</b></i> <font color=red>c</font> x<y>z")).toBe(
      "<i>a &amp; </i><i><b>b</b></i> c x&lt;y&gt;z",
    );
  });
});

describe("captions", () => {
  test("takes speaker ids off, in seconds after the offset, empty cues left out", () => {
    const cues = srt(
      [
        "1\n00:00:01,000 --> 00:00:02,500\nS01: Hello there.",
        "2\n00:00:03,000 --> 00:00:04,000\n",
        "3\n00:00:04,000 --> 00:00:05,000\nS01 / S02: Fine, <i>thanks</i>.",
      ].join("\n\n"),
    );
    expect(captions(cues, 0.5)).toStrictEqual([
      { start: 0.5, end: 2, text: "Hello there." },
      { start: 3.5, end: 4.5, text: "Fine, <i>thanks</i>." },
    ]);
  });

  test("keeps names, which are said", () => {
    const cues = srt(
      [
        "1\n00:00:01,000 --> 00:00:02,000\nJOHN: Hi.",
        "2\n00:00:02,000 --> 00:00:03,000\nMARY: Hi.",
        "3\n00:00:03,000 --> 00:00:04,000\nJOHN: Bye.",
      ].join("\n\n"),
    );
    expect(captions(cues).map((c) => c.text)).toStrictEqual(["JOHN: Hi.", "MARY: Hi.", "JOHN: Bye."]);
  });

  test("a cue that ends before what is played starts is left out", () => {
    const cues = srt("1\n00:00:01,000 --> 00:00:02,000\nEarly.\n\n2\n00:00:02,000 --> 00:00:04,000\nLate.");
    expect(captions(cues, 3)).toStrictEqual([{ start: 0, end: 1, text: "Late." }]);
  });
});

describe("bilingual", () => {
  const c = (start: number, end: number, text: string): Caption => ({ start, end, text });

  test("the translation above the original, a joined translation kept over the cues it spans", () => {
    const original = [c(0, 1, "Hello there."), c(1, 2, "How are you?"), c(3, 4, "Fine.")];
    const translation = [c(0, 2, "你好。你好吗？"), c(3, 4, "很好。")];
    expect(bilingual(original, translation, { original: "en", translation: "zh" })).toStrictEqual([
      c(0, 1, "<lang zh>你好。你好吗？</lang>\n<lang en>Hello there.</lang>"),
      c(1, 2, "<lang zh>你好。你好吗？</lang>\n<lang en>How are you?</lang>"),
      c(3, 4, "<lang zh>很好。</lang>\n<lang en>Fine.</lang>"),
    ]);
  });

  test("a stretch with one side only shows that side; equal neighbours are one cue", () => {
    const original = [c(0, 2, "A"), c(2, 3, "B")];
    const translation = [c(1, 3, "X")];
    expect(bilingual(original, translation)).toStrictEqual([c(0, 1, "A"), c(1, 2, "X\nA"), c(2, 3, "X\nB")]);
    expect(bilingual([c(0, 1, "A")], [c(0, 0.5, "X"), c(0.5, 1, "X")])).toStrictEqual([c(0, 1, "X\nA")]);
    expect(bilingual(original, [])).toStrictEqual(original);
  });
});
