import { describe, expect, test } from "bun:test";
import { countBlocks, mismatchMessage, paragraphMismatch, unitOf } from "../public/paragraphs";

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
    expect(mismatchMessage({ unit: "lines", source: 5, output: 4 })).toStartWith("The source has 5 lines and the translation has 4.");
    expect(mismatchMessage({ unit: "paragraphs", source: 3, output: 1 })).toStartWith("The source has 3 paragraphs and");
  });
});
