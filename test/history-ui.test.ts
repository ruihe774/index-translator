import { describe, expect, test } from "bun:test";

import { snippet } from "../public/history-ui";

describe("snippet", () => {
  test("a short text is kept whole, its white space collapsed, with no ellipsis", () => {
    expect(snippet("  Hello,\n\n  world  ", 40)).toBe("Hello, world");
    // 100 emoji are 200 UTF-16 units but 100 characters: nothing is cut.
    expect(snippet("😀".repeat(100), 120)).toBe("😀".repeat(100));
  });

  test("a long one is cut after whole characters and marked", () => {
    expect(snippet("a".repeat(50), 40)).toBe(`${"a".repeat(40)}…`);
    expect(snippet(`${"a".repeat(39)}👨‍👩‍👧 and more`, 40)).toBe(`${"a".repeat(39)}👨‍👩‍👧…`);
    expect(snippet(`${"a".repeat(39)}🇯🇵🇫🇷`, 40)).toBe(`${"a".repeat(39)}🇯🇵…`);
    // A letter keeps its marks (Arabic with its vowels).
    expect(snippet("كَتَبَ".repeat(20), 3)).toBe("كَتَبَ…");
  });

  test("no space is left before the ellipsis", () => {
    expect(snippet("one two three", 4)).toBe("one…");
  });
});
