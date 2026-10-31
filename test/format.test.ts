import { describe, expect, test } from "bun:test";

import { formatOf } from "../public/format";

describe("formatOf", () => {
  test("subtitles before Markdown, else plain", () => {
    expect(formatOf("1\n00:00:01,000 --> 00:00:02,000\n**Hi**\n")).toBe("subtitles");
    expect(formatOf("# Title\n\nSome *text*.")).toBe("markdown");
    expect(formatOf("Just a line.")).toBe("plain");
  });
});
