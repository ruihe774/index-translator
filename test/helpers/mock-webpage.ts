// Stands in for the browser of `POST /webpage`: answers every page with `mockWebpage.markdown`.
// Module state: restore it with resetMockWebpage().

import { WebpageError, type WebpageFetcher, WebpageForbiddenError } from "../../src/webpage";
import { delay } from "./harness";

const DEFAULT_MARKDOWN = "# Example page\n\nThe first paragraph.\n\nThe [second](https://example.com/two) paragraph.";

export const mockWebpage = {
  /** What `problem()` answers: set, every fetch is refused as when turndown is not installed. */
  problem: undefined as string | undefined,
  title: "Example page",
  markdown: DEFAULT_MARKDOWN,
  /** Where the page ends up, when not where it was asked to go: checked against the allowed domains. */
  redirectTo: undefined as string | undefined,
  delayMs: 0,
  /** Makes the fetch fail as when the page cannot be opened. */
  failWith: undefined as string | undefined,
  /** Every address asked for. */
  requests: [] as string[],
  aborted: 0,
};

export function resetMockWebpage(): void {
  mockWebpage.problem = undefined;
  mockWebpage.title = "Example page";
  mockWebpage.markdown = DEFAULT_MARKDOWN;
  mockWebpage.redirectTo = undefined;
  mockWebpage.delayMs = 0;
  mockWebpage.failWith = undefined;
  mockWebpage.requests.length = 0;
  mockWebpage.aborted = 0;
}

export const webpageFetcher: WebpageFetcher = {
  problem: () => Promise.resolve(mockWebpage.problem),
  async fetch(url, allowed, signal) {
    mockWebpage.requests.push(url.href);
    await delay(mockWebpage.delayMs, signal);
    if (signal.aborted) {
      mockWebpage.aborted++;
      signal.throwIfAborted();
    }
    if (mockWebpage.failWith) {
      throw new WebpageError(mockWebpage.failWith);
    }
    const at = mockWebpage.redirectTo ?? url.href;
    if (!allowed(new URL(at))) {
      throw new WebpageForbiddenError(`the page went on to ${at}, which is not in ALLOWED_WEBPAGE_DOMAINS`);
    }
    return { url: at, title: mockWebpage.title, markdown: mockWebpage.markdown };
  },
};
