import { describe, expect, test } from "bun:test";

import { alignBlocks, alignFromPairs } from "../public/paragraphs";
import { sideBySideRows } from "../public/side-by-side";

const pair = (source: number[], target: number[]) => ({ source, target });

describe("sideBySideRows", () => {
  test("one element per block, matched one to one: a row each", () => {
    const a = alignBlocks("a\n\nb\n\nc", "x\n\ny\n\nz")!;
    expect(sideBySideRows(a, { source: [0, 2, 4], output: [0, 2, 4] })).toStrictEqual({
      rows: 3,
      source: [
        { row: 1, span: 1 },
        { row: 2, span: 1 },
        { row: 3, span: 1 },
      ],
      output: [
        { row: 1, span: 1 },
        { row: 2, span: 1 },
        { row: 3, span: 1 },
      ],
    });
  });

  test("a block left out leaves its cell empty, and the rows after it stay matched", () => {
    const a = alignFromPairs("a\n\nb\n\nc", "x\n\nz", [pair([0], [0]), pair([1], []), pair([2], [1])])!;
    expect(sideBySideRows(a, { source: [0, 2, 4], output: [0, 2] })).toStrictEqual({
      rows: 3,
      source: [
        { row: 1, span: 1 },
        { row: 2, span: 1 },
        { row: 3, span: 1 },
      ],
      output: [
        { row: 1, span: 1 },
        { row: 3, span: 1 },
      ],
    });
  });

  test("two blocks matched with one: the one spans both rows", () => {
    const a = alignFromPairs("a\n\nb\n\nc", "xy\n\nz", [pair([0, 1], [0]), pair([2], [1])])!;
    const layout = sideBySideRows(a, { source: [0, 2, 4], output: [0, 2] });
    expect(layout.rows).toBe(3);
    expect(layout.output).toStrictEqual([
      { row: 1, span: 2 },
      { row: 3, span: 1 },
    ]);
  });

  test("an element holding several blocks joins their groups into one band", () => {
    // One block per line; the source renders lines 0–2 as one list, the translation one element per line.
    const a = alignBlocks("- a\n- b\n- c\nd", "- x\n- y\n- z\nw")!;
    expect(sideBySideRows(a, { source: [0, 3], output: [0, 1, 2, 3] })).toStrictEqual({
      rows: 4,
      source: [
        { row: 1, span: 3 },
        { row: 4, span: 1 },
      ],
      output: [
        { row: 1, span: 1 },
        { row: 2, span: 1 },
        { row: 3, span: 1 },
        { row: 4, span: 1 },
      ],
    });
  });

  test("an element reaching over a group the other side alone has takes that group into its band", () => {
    const a = alignFromPairs("- a\n- b", "- x\n- n\n- y", [pair([0], [0]), pair([], [1]), pair([1], [2])])!;
    // The source's list is one element; each translated line is its own.
    expect(sideBySideRows(a, { source: [0], output: [0, 1, 2] })).toStrictEqual({
      rows: 3,
      source: [{ row: 1, span: 3 }],
      output: [
        { row: 1, span: 1 },
        { row: 2, span: 1 },
        { row: 3, span: 1 },
      ],
    });
  });

  test("blank-line elements of plain text stay in the band of the block before them", () => {
    const a = alignBlocks("a\n\nb", "x\n\ny")!;
    // Plain text: one element per line, the blank line included.
    expect(sideBySideRows(a, { source: [0, 1, 2], output: [0, 1, 2] })).toStrictEqual({
      rows: 3,
      source: [
        { row: 1, span: 1 },
        { row: 2, span: 1 },
        { row: 3, span: 1 },
      ],
      output: [
        { row: 1, span: 1 },
        { row: 2, span: 1 },
        { row: 3, span: 1 },
      ],
    });
  });

  test("a block with no element (a link definition) takes no row", () => {
    const a = alignBlocks("a\n\n[l]: https://example.com\n\nc", "x\n\n[l]: https://example.com\n\nz")!;
    const layout = sideBySideRows(a, { source: [0, 4], output: [0, 4] });
    expect(layout.rows).toBe(2);
    expect(layout.source).toStrictEqual([
      { row: 1, span: 1 },
      { row: 2, span: 1 },
    ]);
  });
});
