import { describe, expect, test } from "bun:test";

import {
  alignBlocks,
  blockAt,
  blockStarts,
  countBlocks,
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
    expect(paragraphMismatch(source, "One.\nTwo.\nFour.")).toEqual({ unit: "lines", source: 4, output: 3 });
  });

  test("single-newline source: blank lines added by the model do not matter", () => {
    expect(paragraphMismatch("一\n二\n三", "One\n\nTwo\n\nThree")).toBeNull();
  });

  test("blank-line source: matching counts are fine, a merged paragraph is found", () => {
    const source = "A one.\n\nB two.\n\nC three.";
    expect(paragraphMismatch(source, "A.\n\nB.\n\nC.")).toBeNull();
    expect(paragraphMismatch(source, "A.\n\nB. C.")).toEqual({ unit: "paragraphs", source: 3, output: 2 });
  });

  test("blank-line source: a flattened output is found", () => {
    expect(paragraphMismatch("A\n\nB\n\nC", "A\nB\nC")).toEqual({ unit: "paragraphs", source: 3, output: 1 });
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
    expect(blockStarts("\n\nA\na\n\n \t\nB\r\n\r\nC\n", "paragraphs")).toEqual([2, 6, 8]);
  });

  test("lines: every non-blank line", () => {
    expect(blockStarts("A\n\nB\nC", "lines")).toEqual([0, 2, 3]);
  });

  test("counts as many blocks as countBlocks", () => {
    for (const text of ["", "A", "A\n\n\nB\n", "\r\nA\r\n \r\nB\r\nb", "# T\n\n- a\n- b\n\n```\nx\n\ny\n```"]) {
      for (const unit of ["paragraphs", "lines"] as const)
        expect(blockStarts(text, unit)).toHaveLength(countBlocks(text, unit));
    }
  });
});

describe("alignBlocks", () => {
  test("pairs blocks by index when the counts match, in the source's unit", () => {
    expect(alignBlocks("A\n\nB\nb\n\nC", "甲\n\n\n乙\n\n丙\n丙")).toEqual({
      unit: "paragraphs",
      source: [0, 2, 5],
      output: [0, 3, 5],
    });
    expect(alignBlocks("A\nB", "甲\n\n乙")).toEqual({ unit: "lines", source: [0, 1], output: [0, 2] });
  });

  test("null when the counts differ or there is nothing", () => {
    expect(alignBlocks("A\n\nB\n\nC", "甲\n\n乙")).toBeNull();
    expect(alignBlocks("A\n\nB", "甲")).toBeNull();
    expect(alignBlocks("", "")).toBeNull();
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
