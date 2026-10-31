// How a text is shown when it is not shown raw, read from the text itself: SubRip subtitles as a table
// of cues (subtitle-dom.ts), Markdown rendered (markdown-dom.ts), anything else line by line. Pure, so
// bun test can import it.

import { looksLikeMarkdown } from "./markdown.ts";
import { parseSrt } from "./subtitles.ts";

export type Format = "plain" | "markdown" | "subtitles";

export function formatOf(text: string): Format {
  if (parseSrt(text)) {
    return "subtitles";
  }
  return looksLikeMarkdown(text) ? "markdown" : "plain";
}
