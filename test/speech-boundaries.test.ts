// What the sentence model's answer does to reading aloud when the text is changed on its way to the speech
// model (addresses to host names, white space collapsed, Japanese digits in kanji, line breaks, list
// numbers, closing punctuation): the cuts must still fall where the model put sentence ends. The model
// here answers for the string it is asked about, wherever that string comes from, with a probability
// after every sentence end and none elsewhere; a cut mapped to the wrong place is then no sentence end.

import { describe, expect, test } from "bun:test";

import { speechSegments, speechTexts } from "../public/speech-text";

/** A full stop (not a decimal point), question or exclamation mark, then what may follow a sentence. */
const END =
  /(?:(?<!\d)\.|[!?。！？])["'”’)）」』】]*(?=\s|$|\d|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;

/** The answer of a model that finds a sentence end after every full stop, question mark or exclamation mark. */
function model(text: string) {
  const offsets: number[] = [];
  for (const m of text.matchAll(END)) {
    offsets.push(m.index + m[0].length);
  }
  return { offsets, probabilities: offsets.map(() => 0.95) };
}

const asks: string[] = [];
const lookup = (text: string) => {
  asks.push(text);
  return model(text);
};

/** The pieces of a text, whether there are several, and those but the last that do not end at a sentence end. */
function cuts(text: string, markdown: boolean, lang: string) {
  const pieces = speechSegments(text, markdown, lang, lookup).map((s) => s.text);
  return {
    pieces,
    several: pieces.length > 1,
    misCut: pieces.slice(0, -1).filter((p) => !/[.!?。！？]["'”’)）」』】]*$/.test(p)),
  };
}

const WELL_CUT = { several: true, misCut: [] };

const EN = (n: number) =>
  Array.from({ length: n }, (_, i) => `This is sentence number ${i + 1} of the text, with some words in it.`).join(" ");
const ZH = (n: number) => Array.from({ length: n }, (_, i) => `这是文本的第${i + 1}句话，里面有一些词语。`).join("");
const JA = (n: number) =>
  Array.from({ length: n }, (_, i) => `これは本文の${i + 1}番目の文で、いくつかの語が入っています。`).join("");

describe("the model's sentence ends hold through the changes made to a text before it is spoken", () => {
  test("a web address, pipes and angle brackets, and runs of white space", () => {
    const text = `See https://www.example.com/a/long/path?x=1 for more.  ${EN(3)}  Then a|b <c> d.   ${EN(3)}`;
    expect(cuts(text, false, "en")).toMatchObject(WELL_CUT);
  });

  test("a line break inside a paragraph, which is a space in English and nothing in Chinese", () => {
    expect(cuts(`${EN(3)}  \n${EN(3)}  \nA short end.`, true, "en")).toMatchObject({
      ...WELL_CUT,
      pieces: [expect.any(String), expect.any(String)],
    });
    expect(cuts(`${ZH(6)}  \n${ZH(6)}  \n最后一句。`, true, "zh")).toMatchObject(WELL_CUT);
  });

  test("a web address in Chinese text, with spaces round it", () => {
    expect(cuts(`${ZH(4)} 参见 https://www.example.com/a/b 了解更多。${ZH(4)}`, false, "zh")).toMatchObject(WELL_CUT);
  });

  test("spaces around bold text and links in Chinese are closed up", () => {
    const text = `${ZH(4)}这里有 **加粗的字** 和 [一个链接](https://example.com) 在句子中间。${ZH(4)}`;
    expect(cuts(text, true, "zh")).toMatchObject(WELL_CUT);
  });

  test("Japanese digits are written in kanji, which changes the length", () => {
    const text = `2026年に12,345人が来ました。${JA(5)}価格は1,000,000円でした。${JA(5)}`;
    expect(cuts(text, false, "ja")).toMatchObject(WELL_CUT);
  });

  test("an ordered list item is read with its number and a task item after its box", () => {
    const md = `3. ${EN(8)}\n4. ${EN(8)}\n\n- [x] ${EN(8)}\n- [ ] ${EN(8)}\n`;
    const { pieces, ...rest } = cuts(md, true, "en");
    expect(rest).toStrictEqual(WELL_CUT);
    expect(pieces[0]!.startsWith("3. ")).toBe(true);
  });

  test("a heading and a list item without punctuation are closed, and nothing after the closing is cut", () => {
    const heading = speechSegments("# A title without a stop\n", true, "en", lookup);
    expect(heading.map((s) => s.text)).toStrictEqual(["A title without a stop."]);
    expect(cuts(`- ${EN(7)} And one without a stop`, true, "en")).toMatchObject(WELL_CUT);
  });

  test("a block quote and a nested list", () => {
    expect(cuts(`> ${EN(8)}\n`, true, "en")).toMatchObject(WELL_CUT);
    expect(cuts(`- outer\n  - ${EN(8)}\n`, true, "en")).toMatchObject(WELL_CUT);
  });

  test("plain text is read line by line", () => {
    expect(cuts(`First line.\n${EN(8)}\nlast`, false, "en")).toMatchObject(WELL_CUT);
  });

  test("emphasis, inline code and a link keep their text", () => {
    const text = `${EN(3)} Some *emphasis*, \`code.\` and [a link](https://example.com). ${EN(4)}`;
    expect(cuts(text, true, "en")).toMatchObject(WELL_CUT);
  });
});

/** A small deterministic generator, so that a failure can be had again. */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

describe("whatever is done to a text, no cut is made off a sentence end", () => {
  const pick = <T>(next: () => number, list: T[]): T => list[Math.floor(next() * list.length)]!;

  test("English, as Markdown and as plain text", () => {
    const tokens = [
      "word",
      "words",
      "https://ex.com/a/b",
      "a|b",
      "<x>",
      "12,345",
      "**bold**",
      "[link](https://ex.com)",
      "`code`",
      "some",
    ];
    for (let seed = 1; seed <= 60; seed++) {
      const next = random(seed);
      const sentences = Array.from({ length: 12 }, () => {
        const body = Array.from({ length: 6 + Math.floor(next() * 8) }, () => pick(next, tokens));
        // Now and then a line break inside the sentence, or runs of spaces between words.
        const joined = body
          .map((t, i) => (i === 0 ? t : `${pick(next, [" ", " ", "  ", "   ", "  \n"])}${t}`))
          .join("");
        return `${joined} end.`;
      });
      const text = sentences.join(pick(next, [" ", "  "]));
      expect({ seed, ...cuts(text, true, "en") }).toMatchObject({ seed, ...WELL_CUT });
      expect({ seed, ...cuts(text.replaceAll("  \n", " "), false, "en") }).toMatchObject({ seed, ...WELL_CUT });
    }
  });

  test("Chinese, with spaces between characters and a line break", () => {
    // No bare address: one runs on to the next white space, and a line break between Chinese characters is
    // dropped, so what follows an address would be taken for part of it.
    const tokens = ["字字字", "词语", "**粗体**", "[链接](https://ex.com)", "，", "一二三"];
    for (let seed = 1; seed <= 60; seed++) {
      const next = random(seed);
      const sentences = Array.from({ length: 14 }, () => {
        const body = Array.from({ length: 5 + Math.floor(next() * 6) }, () => pick(next, tokens));
        return `${body.map((t, i) => (i === 0 ? t : `${pick(next, ["", "", " ", "  \n"])}${t}`)).join("")}结束。`;
      });
      const text = sentences.join(pick(next, ["", " "]));
      expect({ seed, ...cuts(text, true, "zh") }).toMatchObject({ seed, ...WELL_CUT });
    }
  });

  test("Japanese, with numbers", () => {
    // Short sentences: written in kanji a number is long, and a sentence beyond the hard limit is cut inside.
    const tokens = ["これは", "文です", "2026年", "12,345人", "1,000円", "3.14", "100"];
    for (let seed = 1; seed <= 60; seed++) {
      const next = random(seed);
      const sentences = Array.from({ length: 14 }, () => {
        const body = Array.from({ length: 2 + Math.floor(next() * 4) }, () => pick(next, tokens));
        return `${body.join(pick(next, ["", " "]))}終わり。`;
      });
      expect({ seed, ...cuts(sentences.join(""), false, "ja") }).toMatchObject({ seed, ...WELL_CUT });
    }
  });
});

describe("the answer is asked for by the text as the page shows it", () => {
  test("a line break is a newline, an address is whole, a list item has no number, a task's box a space", () => {
    asks.length = 0;
    const md = `${EN(4)}  \nSee https://ex.com/a for more.\n\n3. ${EN(8)}\n\n- [ ] ${EN(8)}\n`;
    speechSegments(md, true, "en", lookup);
    expect(asks.some((t) => t.includes("\nSee https://ex.com/a for more."))).toBe(true);
    expect(asks).toContain(EN(8));
    expect(asks).toContain(` ${EN(8)}`);
  });

  test("a table row and a paragraph with an image are not asked for, and are not listed", () => {
    asks.length = 0;
    const md = `| a | b |\n|---|---|\n| ${EN(8)} | ${EN(8)} |\n\n${EN(8)} ![alt](https://ex.com/i.png)\n`;
    speechSegments(md, true, "en", lookup);
    expect(asks).toStrictEqual([]);
    expect(speechTexts(md, true, "en")).toStrictEqual([]);
  });

  test("every text listed is asked for", () => {
    const md = `# Title\n\n${EN(8)}\n\n- ${EN(8)}\n- [ ] ${EN(8)}\n\n> ${EN(8)}\n`;
    asks.length = 0;
    speechSegments(md, true, "en", lookup);
    const listed = speechTexts(md, true, "en").map((t) => t.text);
    expect(listed).toHaveLength(4);
    for (const text of listed) {
      expect(asks).toContain(text);
    }
  });

  test("an answer is used only for the text it is for: an offset past the end or before the start is dropped", () => {
    const text = EN(8);
    const wild = speechSegments(text, false, "en", () => ({
      offsets: [0, -3, 1.5, text.length, text.length + 50],
      probabilities: [1, 1, 1, 1, 1],
    }));
    expect(wild.map((s) => s.text)).toStrictEqual(
      speechSegments(text, false, "en", () => ({ offsets: [], probabilities: [] })).map((s) => s.text),
    );
  });
});
