// A web page as the source.
//
// An address alone in the box is offered as a page to fetch. The server opens it (POST /webpage)
// and answers its content as Markdown, which goes into the box like an opened file, shown as a
// preview; translating it is a second Translate. Only the address goes to the server. What happens
// is said under the box, where the letter count is, and errors as the box's own; the status line
// under the translation keeps the last translation's.

import type { Webpage } from "../src/api.ts";
import { API, ApiFailure, failureMessage, failureOf } from "./api.ts";
import { setText, showFieldError } from "./dom.ts";
import { describeWebpageError } from "./errors.ts";
import { ask } from "./link-dialog.ts";
import { restoreFocusAfter } from "./render.ts";
import { Run } from "./run.ts";
import { setState } from "./state.ts";

/** What the person chose in the dialog; Cancel and Escape are `cancel`. */
export type WebpageAnswer = "fetch" | "text" | "cancel";

export interface WebpageFlowDeps {
  stopButton: HTMLElement;
  translateButton: HTMLElement;
  /** `#count`, which says "Fetching the page…" while it runs. */
  count: HTMLElement;
  /** The screen reader's copy of what happens to the box. */
  status: HTMLElement;
  textError: HTMLElement;
  textInput: HTMLElement;
  stopReading(): void;
  /** Puts the page's Markdown in the box, shown as a preview, in place of whatever was opened. */
  load(markdown: string): void;
  refreshSelection(): void;
}

export interface WebpageFlow {
  /** The server can fetch web pages (`webpage` in /health): only then is an address in the box offered as one. */
  available: boolean;
  /** A page is being fetched into the source box. */
  readonly fetching: boolean;
  ask(link: string): Promise<WebpageAnswer>;
  fetch(url: string): Promise<void>;
}

export function initWebpageFlow(d: WebpageFlowDeps): WebpageFlow {
  let fetching = false;

  async function fetchWebpage(url: string) {
    d.stopReading();
    const run = new Run();
    setState({ running: run });
    d.stopButton.focus();
    fetching = true;
    setText(d.count, "Fetching the page…");
    d.status.textContent = "Fetching the page…";
    /** Said when the fetch ends, unless the page took the box (its preview says enough). */
    let outcome = "";
    try {
      const res = await fetch(`${API}/webpage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
        signal: run.controller.signal,
      });
      if (!res.ok) {
        throw await failureOf(res);
      }
      const page = (await res.json()) as Webpage;
      if (!page.markdown.trim()) {
        outcome = "The page has no text to translate.";
        showFieldError(d.textError, d.textInput, outcome);
        return;
      }
      fetching = false;
      d.load(page.markdown);
      outcome = `Fetched “${page.title || page.url}”. Translate it when you are ready.`;
    } catch (e) {
      if (run.stopped) {
        outcome = "Stopped.";
      } else {
        outcome = e instanceof ApiFailure ? describeWebpageError(e.body, e.status) : failureMessage(e);
        showFieldError(d.textError, d.textInput, outcome);
      }
    } finally {
      fetching = false;
      d.refreshSelection();
      d.status.textContent = outcome;
      restoreFocusAfter(d.stopButton, d.translateButton, () => setState({ running: null }));
    }
  }

  return {
    available: false,
    get fetching() {
      return fetching;
    },
    ask: async (link) => {
      const answer = await ask({
        title: "Fetch this web page?",
        message:
          "The text is a web address. The server can open the page and put its text in the box, ready to translate. Or the address can be translated as it is.",
        target: link,
        choices: [
          { value: "text", label: "Translate as text" },
          { value: "fetch", label: "Fetch page" },
        ],
      });
      return answer === "fetch" || answer === "text" ? answer : "cancel";
    },
    fetch: fetchWebpage,
  };
}
