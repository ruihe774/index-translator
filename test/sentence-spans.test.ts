import { describe, expect, test } from "bun:test";

import { locate, type Run, sentenceSpans, spansAt } from "../public/sentence-spans";

/** `locate` only hands the nodes back, so any value stands in for one. */
interface Node {
  data: string;
}
const fakeNode = (data: string): Node => ({ data });

function runs(...parts: string[]): Run<Node>[] {
  let start = 0;
  return parts.map((p) => {
    const run = { node: fakeNode(p), start, end: start + p.length };
    start = run.end;
    return run;
  });
}

describe("sentenceSpans", () => {
  test("cuts at sentence ends and leaves the white space out", () => {
    const text = "First one.  Second one! Third?";
    expect(sentenceSpans(text, "en").map(([s, e]) => text.slice(s, e))).toStrictEqual([
      "First one.",
      "Second one!",
      "Third?",
    ]);
  });

  test("cuts Chinese and Japanese, which have no spaces", () => {
    const text = "我们修复了错误。然后发布了。";
    expect(sentenceSpans(text, "zh").map(([s, e]) => text.slice(s, e))).toStrictEqual([
      "我们修复了错误。",
      "然后发布了。",
    ]);
  });

  test("a newline written for a line break is white space", () => {
    const text = "one line\nsecond line.";
    expect(sentenceSpans(text, "en").map(([s, e]) => text.slice(s, e))).toStrictEqual(["one line\nsecond line."]);
  });

  test("a language tag the browser does not know is cut like none", () => {
    expect(sentenceSpans("A. B.", "not a tag")).toStrictEqual([
      [0, 2],
      [3, 5],
    ]);
  });

  test("nothing but white space has no sentence", () => {
    expect(sentenceSpans(" \n ", "en")).toStrictEqual([]);
  });
});

describe("sentenceSpans with the sentence model's answer", () => {
  const cut = (text: string, lang: string, offsets: number[], probabilities: number[]) =>
    sentenceSpans(text, lang, { offsets, probabilities }).map(([s, e]) => text.slice(s, e));

  test("cuts where the model is likelier than not, even where Intl.Segmenter does not", () => {
    // A full stop before a lowercase letter is no end for Intl.Segmenter.
    const text = "lorem ipsum done. then more.";
    expect(sentenceSpans(text, "en")).toStrictEqual([[0, text.length]]);
    expect(cut(text, "en", [17, 28], [0.95, 0.99])).toStrictEqual(["lorem ipsum done.", "then more."]);
  });

  test("leaves out the cuts the model finds unlikely", () => {
    const text = "One, two. Three.";
    expect(cut(text, "en", [4, 9, 16], [0.3, 0.9, 0.99])).toStrictEqual(["One, two.", "Three."]);
    expect(cut(text, "en", [4, 9, 16], [0.3, 0.49, 0.99])).toStrictEqual(["One, two. Three."]);
  });

  test("an offset after the white space of a sentence's end is a cut before it", () => {
    const text = "First one.  Second one!";
    expect(cut(text, "en", [12], [0.9])).toStrictEqual(["First one.", "Second one!"]);
  });

  test("never inside a word, outside Chinese and Japanese", () => {
    expect(cut("abcdef ghi jkl", "en", [3], [0.9])).toStrictEqual(["abcdef ghi jkl"]);
    expect(cut("我们修复了错误然后发布了", "zh", [7], [0.9])).toStrictEqual(["我们修复了错误", "然后发布了"]);
  });

  test("not between the halves of a surrogate pair", () => {
    const text = "𠀀𠀁𠀂";
    // Each character is two units: 1 is inside the first, 2 between it and the next.
    expect(cut(text, "zh", [1], [0.9])).toStrictEqual([text]);
    expect(cut(text, "zh", [2], [0.9])).toStrictEqual(["𠀀", "𠀁𠀂"]);
  });

  test("without the language the answer is not used: Chinese would have no cut", () => {
    const text = "我们修复了错误。然后发布了。";
    const answer = { offsets: [8], probabilities: [0.9] };
    const both: [number, number][] = [
      [0, 8],
      [8, 14],
    ];
    expect(sentenceSpans(text, "zh", answer)).toStrictEqual(both);
    expect(sentenceSpans(text, "", answer)).toStrictEqual(both);
    expect(sentenceSpans(text, undefined, answer)).toStrictEqual(both);
  });

  test("the ends of the text are no cuts, and an answer with none leaves one sentence", () => {
    expect(cut("Just this.", "en", [10], [0.99])).toStrictEqual(["Just this."]);
    expect(cut("  Padded one  ", "en", [], [])).toStrictEqual(["Padded one"]);
  });
});

describe("spansAt", () => {
  const spans: [number, number][] = [
    [0, 10],
    [12, 20],
  ];

  test("the sentence the caret is inside", () => {
    expect(spansAt(spans, 5)).toStrictEqual([spans[0]!]);
    expect(spansAt(spans, 12)).toStrictEqual([spans[1]!]);
  });

  test("a caret at a sentence's end may mean it", () => {
    expect(spansAt(spans, 10)).toStrictEqual([spans[0]!]);
    expect(spansAt(spans, 20)).toStrictEqual([spans[1]!]);
  });

  test("where sentences touch, the one it is inside comes first", () => {
    const touching: [number, number][] = [
      [0, 4],
      [4, 8],
    ];
    expect(spansAt(touching, 4)).toStrictEqual([touching[1]!, touching[0]!]);
  });

  test("in the gap between sentences, none", () => {
    expect(spansAt(spans, 11)).toStrictEqual([]);
  });
});

describe("locate", () => {
  const r = runs("Hello ", "big", " world");

  test("a range starts in the node that holds the position", () => {
    expect(locate(r, 0, "start")).toMatchObject({ node: r[0]!.node, offset: 0 });
    expect(locate(r, 7, "start")).toMatchObject({ node: r[1]!.node, offset: 1 });
  });

  test("a range starts in the next node when the position is the end of one", () => {
    expect(locate(r, 6, "start")).toMatchObject({ node: r[1]!.node, offset: 0 });
  });

  test("a range ends in the node that holds the position before it", () => {
    expect(locate(r, 6, "end")).toMatchObject({ node: r[0]!.node, offset: 6 });
    expect(locate(r, 8, "end")).toMatchObject({ node: r[1]!.node, offset: 2 });
    expect(locate(r, 15, "end")).toMatchObject({ node: r[2]!.node, offset: 6 });
  });

  test("a newline without a node: a range starts after it and ends before it", () => {
    // "ab", a <br> written as "\n", "cd"
    const broken: Run<Node>[] = [
      { node: fakeNode("ab"), start: 0, end: 2 },
      { node: fakeNode("cd"), start: 3, end: 5 },
    ];
    expect(locate(broken, 2, "start")).toMatchObject({ node: broken[1]!.node, offset: 0 });
    expect(locate(broken, 3, "end")).toMatchObject({ node: broken[0]!.node, offset: 2 });
  });

  test("outside the text, none", () => {
    expect(locate(r, 99, "start")).toBeNull();
    expect(locate(r, 0, "end")).toBeNull();
    expect(locate([], 0, "start")).toBeNull();
  });
});
