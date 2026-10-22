import { describe, expect, test } from "bun:test";

import {
  alignBlocks,
  alignFromPairs,
  blockAt,
  blockStarts,
  blockTexts,
  countBlocks,
  counterpart,
  detailedMismatchMessage,
  matchable,
  MAX_LISTED,
  MIN_MATCHED_BLOCKS,
  mismatchDetails,
  mismatchMessage,
  paragraphMismatch,
  unitOf,
} from "../public/paragraphs";

describe("unitOf", () => {
  test("a blank line makes the unit paragraphs, otherwise lines", () => {
    expect(unitOf("a\n\nb")).toBe("paragraphs");
    expect(unitOf("a\n \t\nb")).toBe("paragraphs");
    expect(unitOf("a\r\n\r\nb")).toBe("paragraphs");
    expect(unitOf("a\nb\nc")).toBe("lines");
    expect(unitOf("a")).toBe("lines");
  });

  test("blank lines around the text do not count", () => {
    expect(unitOf("\n\na\nb\nc\n\n")).toBe("lines");
  });

  test("a blank line inside a code block does not make paragraphs", () => {
    expect(unitOf("a\nb\n```\nx\n\ny\n```\nc")).toBe("lines");
    expect(unitOf("a\n\n```\nx\n```")).toBe("paragraphs");
  });
});

describe("countBlocks", () => {
  test("paragraphs: runs of blank lines and CRLF count once", () => {
    expect(countBlocks("a\n\n\n\nb\r\n\r\nc\n\n", "paragraphs")).toBe(3);
    expect(countBlocks("a\nsame paragraph\n\nb", "paragraphs")).toBe(2);
  });

  test("lines: blank lines are ignored", () => {
    expect(countBlocks("a\n\nb\n  \nc\r\n", "lines")).toBe(3);
  });

  test("empty and whitespace-only text has no blocks", () => {
    expect(countBlocks("", "paragraphs")).toBe(0);
    expect(countBlocks(" \n \n ", "lines")).toBe(0);
  });
});

describe("paragraphMismatch", () => {
  test("single-newline CJK source: a dropped line is found", () => {
    const source = "第一段。\n第二段。\n第三段。\n第四段。";
    expect(paragraphMismatch(source, "One.\nTwo.\nFour.")).toStrictEqual({ unit: "lines", source: 4, output: 3 });
  });

  test("single-newline source: blank lines added by the model do not matter", () => {
    expect(paragraphMismatch("一\n二\n三", "One\n\nTwo\n\nThree")).toBeNull();
  });

  test("blank-line source: matching counts are fine, a merged paragraph is found", () => {
    const source = "A one.\n\nB two.\n\nC three.";
    expect(paragraphMismatch(source, "A.\n\nB.\n\nC.")).toBeNull();
    expect(paragraphMismatch(source, "A.\n\nB. C.")).toStrictEqual({ unit: "paragraphs", source: 3, output: 2 });
  });

  test("blank-line source: a flattened output is found", () => {
    expect(paragraphMismatch("A\n\nB\n\nC", "A\nB\nC")).toStrictEqual({ unit: "paragraphs", source: 3, output: 1 });
  });

  test("hard-wrapped paragraphs are counted as paragraphs, not lines", () => {
    const source = "line one\nline two\n\nline three\nline four\n\nline five\nline six";
    expect(paragraphMismatch(source, "a\nb\n\nc\nd\n\ne\nf")).toBeNull();
  });

  test("a repeated paragraph is found", () => {
    expect(paragraphMismatch("A\n\nB\n\nC", "A\n\nB\n\nB\n\nC")).toMatchObject({ source: 3, output: 4 });
  });

  test("fewer than three blocks are not checked", () => {
    expect(paragraphMismatch("A\n\nB", "A")).toBeNull();
    expect(paragraphMismatch("only one line", "")).toBeNull();
    expect(paragraphMismatch("", "")).toBeNull();
  });

  test("CRLF source and trailing whitespace", () => {
    expect(paragraphMismatch("A\r\n\r\nB\r\n\r\nC\r\n\r\n", "a\n\nb\n\nc  \n")).toBeNull();
  });
});

describe("mismatchMessage", () => {
  test("names the unit", () => {
    expect(mismatchMessage({ unit: "lines", source: 5, output: 4 })).toStartWith(
      "The source has 5 lines and the translation has 4.",
    );
    expect(mismatchMessage({ unit: "paragraphs", source: 3, output: 1 })).toStartWith(
      "The source has 3 paragraphs and",
    );
  });
});

describe("blockStarts", () => {
  test("paragraphs: the first line after each run of blank lines", () => {
    expect(blockStarts("\n\nA\na\n\n \t\nB\r\n\r\nC\n", "paragraphs")).toStrictEqual([2, 6, 8]);
  });

  test("lines: every non-blank line", () => {
    expect(blockStarts("A\n\nB\nC", "lines")).toStrictEqual([0, 2, 3]);
  });

  test("paragraphs: a fenced code block is one block, blank lines and all", () => {
    const text = "Intro.\n\n```sh\na\n\nb\n```\n\nAfter.";
    expect(blockStarts(text, "paragraphs")).toStrictEqual([0, 2, 8]);
    expect(blockTexts(text, "paragraphs")[1]).toBe("```sh\na\n\nb\n```");
    // Tildes, a longer closing fence, and a fence of the other character inside.
    expect(blockStarts("~~~\n```\n\n~~~~\n\nEnd.", "paragraphs")).toStrictEqual([0, 5]);
    // A closing fence takes nothing after it; an unclosed fence runs to the end.
    expect(blockStarts("```\n``` not a close\n\nstill code", "paragraphs")).toStrictEqual([0]);
  });

  test("lines: each line of code is a line", () => {
    expect(blockStarts("```\na\nb\n```", "lines")).toStrictEqual([0, 1, 2, 3]);
  });

  test("counts as many blocks as countBlocks", () => {
    for (const text of ["", "A", "A\n\n\nB\n", "\r\nA\r\n \r\nB\r\nb", "# T\n\n- a\n- b\n\n```\nx\n\ny\n```"]) {
      for (const unit of ["paragraphs", "lines"] as const) {
        expect(blockStarts(text, unit)).toHaveLength(countBlocks(text, unit));
      }
    }
  });
});

const oneToOne = (n: number) => Array.from({ length: n }, (_, i) => ({ source: [i], output: [i] }));

describe("alignBlocks", () => {
  test("pairs blocks by index when the counts match, in the source's unit", () => {
    expect(alignBlocks("A\n\nB\nb\n\nC", "甲\n\n\n乙\n\n丙\n丙")).toStrictEqual({
      unit: "paragraphs",
      source: [0, 2, 5],
      output: [0, 3, 5],
      groups: oneToOne(3),
    });
    expect(alignBlocks("A\nB", "甲\n\n乙")).toStrictEqual({
      unit: "lines",
      source: [0, 1],
      output: [0, 2],
      groups: oneToOne(2),
    });
  });

  test("null when the counts differ or there is nothing", () => {
    expect(alignBlocks("A\n\nB\n\nC", "甲\n\n乙")).toBeNull();
    expect(alignBlocks("A\n\nB", "甲")).toBeNull();
    expect(alignBlocks("", "")).toBeNull();
  });
});

describe("matchable", () => {
  const prose = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i}.`);

  test(`at least ${MIN_MATCHED_BLOCKS} blocks, of any kind`, () => {
    expect(matchable(prose(MIN_MATCHED_BLOCKS))).toBe(true);
    expect(matchable(prose(MIN_MATCHED_BLOCKS - 1))).toBe(false);
    expect(matchable([...prose(MIN_MATCHED_BLOCKS - 2), "| a | b |\n| --- | --- |", "```sh\nls\n```"])).toBe(true);
  });
});

describe("blockTexts", () => {
  test("each block's lines, trimmed, as blockStarts finds them", () => {
    expect(blockTexts("\nA\na \n\n  \nB\n", "paragraphs")).toStrictEqual(["A\na", "B"]);
    expect(blockTexts("A\n\nB\nC", "lines")).toStrictEqual(["A", "B", "C"]);
  });
});

const pair = (source: number[], target: number[]) => ({ source, target, similarity: 0.9 });

describe("alignFromPairs", () => {
  const source = "A\n\nB\n\nC\n\nD";
  const output = "甲\n\n丙\n\n丁";

  test("the groups of the answer, with both texts' block starts", () => {
    expect(
      alignFromPairs(source, output, [pair([0], [0]), pair([1], []), pair([2], [1]), pair([3], [2])]),
    ).toStrictEqual({
      unit: "paragraphs",
      source: [0, 2, 4, 6],
      output: [0, 2, 4],
      groups: [
        { source: [0], output: [0] },
        { source: [1], output: [] },
        { source: [2], output: [1] },
        { source: [3], output: [2] },
      ],
    });
  });

  test("null when the answer does not cover both texts in order", () => {
    expect(alignFromPairs(source, output, [pair([0], [0]), pair([2], [1]), pair([3], [2])])).toBeNull();
    expect(alignFromPairs(source, output, [pair([1, 0], [0]), pair([2], [1]), pair([3], [2])])).toBeNull();
    expect(alignFromPairs(source, output, [pair([0, 1], [0]), pair([2, 3], [1])])).toBeNull();
  });
});

describe("counterpart", () => {
  // Source blocks at lines 0, 2, 4, 6, 8; the translation dropped B and split D in two.
  const a = alignFromPairs("A\n\nB\n\nC\n\nD\n\nE", "甲\n\n丙\n\n丁一\n\n丁二\n\n戊", [
    pair([0], [0]),
    pair([1], []),
    pair([2], [1]),
    pair([3], [2, 3]),
    pair([4], [4]),
  ])!;

  test("the lines of a block's group and of its counterpart, from either side", () => {
    expect(counterpart(a, "source", 4)).toStrictEqual({ own: { from: 4, to: 6 }, other: { from: 2, to: 4 } });
    expect(counterpart(a, "source", 6)).toStrictEqual({ own: { from: 6, to: 8 }, other: { from: 4, to: 8 } });
    expect(counterpart(a, "output", 6)).toStrictEqual({ own: { from: 4, to: 8 }, other: { from: 6, to: 8 } });
  });

  test("the last block runs to the end; a block with no counterpart has none", () => {
    expect(counterpart(a, "output", 9)).toStrictEqual({
      own: { from: 8, to: Number.POSITIVE_INFINITY },
      other: { from: 8, to: Number.POSITIVE_INFINITY },
    });
    expect(counterpart(a, "source", 2)).toBeNull();
  });
});

describe("mismatchDetails", () => {
  const blocks = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i)).join("\n\n");
  const details = (sourceCount: number, outputCount: number, pairs: ReturnType<typeof pair>[], unit = "\n\n") =>
    mismatchDetails(
      alignFromPairs(
        unit === "\n" ? blocks(sourceCount).replaceAll("\n\n", "\n") : blocks(sourceCount),
        blocks(outputCount).replaceAll("\n\n", unit),
        pairs,
      )!,
    );

  test("one to one: nothing", () => {
    expect(details(2, 2, [pair([0], [0]), pair([1], [1])])).toStrictEqual([]);
  });

  test("left out, one or several in a row, numbered from 1", () => {
    expect(details(3, 2, [pair([0], [0]), pair([1], []), pair([2], [1])])).toStrictEqual([
      "Paragraph 2 of the source seems to be missing from the translation.",
    ]);
    expect(details(4, 2, [pair([0], [0]), pair([1], []), pair([2], []), pair([3], [1])])).toStrictEqual([
      "Paragraphs 2–3 of the source seem to be missing from the translation.",
    ]);
  });

  test("added, merged, split, and matched only as a whole; lines are lines", () => {
    expect(details(2, 3, [pair([0], [0]), pair([], [1]), pair([1], [2])])).toStrictEqual([
      "Paragraph 2 of the translation has no counterpart in the source (added or repeated).",
    ]);
    expect(details(3, 2, [pair([0, 1], [0]), pair([2], [1])])).toStrictEqual([
      "Paragraphs 1–2 of the source match only paragraph 1 of the translation: merged, or one is missing.",
    ]);
    expect(details(1, 3, [pair([0], [0, 1, 2])], "\n")).toStrictEqual([
      "Line 1 of the source matches lines 1–3 of the translation: split, or one was added.",
    ]);
    expect(details(2, 2, [pair([0, 1], [0, 1])])).toStrictEqual([
      "Paragraphs 1–2 of the source and paragraphs 1–2 of the translation only match as a whole.",
    ]);
  });

  test("lone blocks apart from each other are separate places", () => {
    expect(details(3, 1, [pair([0], []), pair([1], [0]), pair([2], [])])).toHaveLength(2);
  });
});

describe("detailedMismatchMessage", () => {
  const m = { unit: "paragraphs" as const, source: 9, output: 8 };
  const drops = (n: number) =>
    alignFromPairs(
      Array.from({ length: n * 2 }, (_, i) => `S${i}`).join("\n\n"),
      Array.from({ length: n }, (_, i) => `T${i}`).join("\n\n"),
      Array.from({ length: n }, (_, i) => [pair([2 * i], [i]), pair([2 * i + 1], [])]).flat(),
    )!;

  test("the counts, then the places", () => {
    expect(detailedMismatchMessage(m, drops(1))).toBe(
      "The source has 9 paragraphs and the translation has 8. Paragraph 2 of the source seems to be missing from the translation. Check it against the source.",
    );
  });

  test(`at most ${MAX_LISTED} places, the rest counted`, () => {
    expect(detailedMismatchMessage(m, drops(MAX_LISTED + 1))).toContain("There is 1 other place like these.");
    expect(detailedMismatchMessage(m, drops(MAX_LISTED + 3))).toContain("There are 3 other places like these.");
  });

  test("with no place found, the plain message", () => {
    expect(detailedMismatchMessage(m, alignBlocks("A", "B")!)).toBe(mismatchMessage(m));
  });
});

describe("blockAt", () => {
  test("the last block starting at or before the line", () => {
    expect(blockAt([2, 5, 9], 0)).toBe(0);
    expect(blockAt([2, 5, 9], 5)).toBe(1);
    expect(blockAt([2, 5, 9], 8)).toBe(1);
    expect(blockAt([2, 5, 9], 100)).toBe(2);
  });
});
