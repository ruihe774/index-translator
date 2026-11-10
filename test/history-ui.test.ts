import { describe, expect, test } from "bun:test";

import { snippet } from "../public/history-ui";

describe("snippet", () => {
  test("a short text is kept whole, its white space collapsed, with no ellipsis", () => {
    expect(snippet("  Hello,\n\n  world  ", 40)).toBe("Hello, world");
  });

  test("a long one is cut after whole words within the cap, and marked", () => {
    expect(snippet("one two three four", 13)).toBe("one two three…");
    expect(snippet("one two three four", 12)).toBe("one two…");
    expect(snippet("one two three four", 18)).toBe("one two three four");
    // The cap is UTF-16 units: 100 emoji are 200.
    expect(snippet("😀 ".repeat(100), 9)).toBe("😀 😀 😀…");
  });

  test("a word longer than the cap is cut at the cap, never inside a surrogate pair", () => {
    expect(snippet("a".repeat(50), 40)).toBe(`${"a".repeat(40)}…`);
    expect(snippet("😀".repeat(50), 5)).toBe("😀😀…");
  });

  test("no space is left before the ellipsis", () => {
    expect(snippet("one two three", 5)).toBe("one…");
  });
});
