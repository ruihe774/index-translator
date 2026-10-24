// `POST /webpage`: a web page's content as Markdown, for the web app to put in the source box. The
// page is opened by a headless browser (Bun.WebView: the system WebKit on macOS, an installed
// Chrome, Chromium, Edge or Brave elsewhere), so what a reader sees is what is taken, scripts
// included. Turndown (`vendor/turndown`, scripts/fetch_turndown.ts) and src/page/extract.ts then
// run inside the page and hand back the Markdown.
//
// Every page gets a view of its own, closed when its answer is in. Bun starts the browser with the
// first view and keeps it; it is stopped again after IDLE_CLOSE_MS without a fetch.

import { join, resolve } from "node:path";

import type { Webpage } from "./api";

export interface WebpageFetcher {
  /** Why no page can be fetched (something is not installed), or undefined when a fetch can be tried. */
  problem(): Promise<string | undefined>;
  /**
   * Opens `url` and gives its content as Markdown. `allowed` is asked for every address the page
   * lands on (redirects, a script moving it); a page outside it is refused with WebpageForbiddenError.
   */
  fetch(url: URL, allowed: (url: URL) => boolean, signal: AbortSignal): Promise<Webpage>;
}

/** The page could not be opened or read (502). */
export class WebpageError extends Error {}

/** Nothing here can open pages: turndown or a browser is missing (503). */
export class WebpageUnavailableError extends Error {}

/** The page went to an address the allowed domains do not cover (403). */
export class WebpageForbiddenError extends Error {}

/** `MAX_WEBPAGE_FETCHES` pages are being fetched already (429). */
export class WebpageBusyError extends Error {
  constructor() {
    super(`${MAX_WEBPAGE_FETCHES} web pages are being fetched already; try again in a moment`);
  }
}

/** How long the page's `load` event is waited for after it is first shown; then it is read as it is. */
const LOAD_WAIT_MS = 30_000;
/**
 * After `load`, the page's scripts may still render what they fetch (a single-page app's content):
 * it is read once its DOM has not changed for QUIET_MS, or after RENDER_WAIT_MS however busy it is.
 */
const QUIET_MS = 500;
const RENDER_WAIT_MS = 5000;
/** The whole fetch, from opening the view to the Markdown. */
const TIMEOUT_MS = 60_000;
const IDLE_CLOSE_MS = 60_000;
/** Pages fetched at the same time; each is a browser tab. */
export const MAX_WEBPAGE_FETCHES = 2;

/** `fetcher` that refuses with `WebpageBusyError` while MAX_WEBPAGE_FETCHES fetches are running: the one place the limit lives. */
export function limitFetches(fetcher: WebpageFetcher): WebpageFetcher {
  let running = 0;
  return {
    problem: () => fetcher.problem(),
    async fetch(url, allowed, signal) {
      if (running >= MAX_WEBPAGE_FETCHES) {
        throw new WebpageBusyError();
      }
      running++;
      try {
        return await fetcher.fetch(url, allowed, signal);
      } finally {
        running--;
      }
    },
  };
}

export function turndownPath(vendorDir = resolve(import.meta.dir, "..", "vendor")): string {
  return join(vendorDir, "turndown", "turndown.js");
}

const NO_TURNDOWN = "turndown is not installed on this server; run: bun scripts/fetch_turndown.ts";

/** turndown, then src/page/extract.ts without its types, called: one expression for `evaluate`. */
async function pageScript(turndown: string): Promise<string> {
  const extract = new Bun.Transpiler({ loader: "ts" }).transformSync(
    await Bun.file(join(import.meta.dir, "page", "extract.ts")).text(),
  );
  return `(async () => {\n${await Bun.file(turndown).text()}\n${extract}\nreturn await extractPage(${LOAD_WAIT_MS}, ${QUIET_MS}, ${RENDER_WAIT_MS});\n})()`;
}

function isWebpage(v: unknown): v is Webpage {
  const page = v as Partial<Webpage> | null;
  return typeof page?.url === "string" && typeof page.title === "string" && typeof page.markdown === "string";
}

/**
 * Where Bun.WebView runs: the system WebKit on macOS; elsewhere Chrome or a sibling, never the
 * user's own running browser (which Bun would otherwise attach to) but a fresh, private one, found
 * by Bun (BUN_CHROME_PATH, then the usual places) unless `browser` names it.
 */
export function webViewBackend(browser?: string): Bun.WebView.ConstructorOptions["backend"] {
  if (process.platform === "darwin" && !browser) {
    return "webkit";
  }
  return browser ? { type: "chrome", path: browser } : { type: "chrome", url: false };
}

/**
 * The fetcher that opens pages in Bun.WebView; `turndown` is the path of turndown's browser build,
 * `browser` an executable to use instead of the one Bun finds.
 */
export function webViewFetcher(turndown = turndownPath(), browser?: string): WebpageFetcher {
  /** Built by the first fetch; a failure is not remembered, so installing turndown needs no restart. */
  let script: Promise<string> | undefined;
  let running = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;

  // Whether a browser is there shows only when one is started.
  const problem = async () => ((await Bun.file(turndown).exists()) ? undefined : NO_TURNDOWN);

  async function fetchPage(url: URL, allowed: (url: URL) => boolean, signal: AbortSignal): Promise<Webpage> {
    // Whether turndown is there was checked by the caller (`problem`); it may have gone since.
    script ??= pageScript(turndown).catch(async (e: unknown) => {
      script = undefined;
      throw (await problem()) ? new WebpageUnavailableError(NO_TURNDOWN) : e;
    });
    const code = await script;
    signal.throwIfAborted();

    let view: Bun.WebView;
    try {
      view = new Bun.WebView({ url: url.href, backend: webViewBackend(browser) });
    } catch (e) {
      throw new WebpageUnavailableError(
        `no browser to open web pages with (${e instanceof Error ? e.message : String(e)}); install Chrome or Chromium, or set BUN_CHROME_PATH`,
      );
    }
    running++;
    clearTimeout(idle);
    const forbidden = (at: string) =>
      new WebpageForbiddenError(`the page went on to ${at}, which is not in ALLOWED_WEBPAGE_DOMAINS`);
    // Whatever ends the fetch early (the client leaving, the time running out, a page going where it
    // may not) rejects `stopped`, which every wait below races against.
    let stop!: (e: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = (e) => {
        reject(e);
        view.close();
      };
    });
    // A stop after the answer is in rejects with nobody waiting.
    stopped.catch(() => {});
    const onAbort = () => stop(new DOMException("the request was cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort);
    const timer = setTimeout(
      () => stop(new WebpageError(`the page did not finish within ${TIMEOUT_MS / 1000} s`)),
      TIMEOUT_MS,
    );
    try {
      // The first navigation is reported before the page has loaded; extractPage waits for the rest.
      const navigated = new Promise<void>((resolve, reject) => {
        view.onNavigationFailed = (e) => reject(new WebpageError(`the page could not be opened: ${e.message}`));
        view.onNavigated = (at) => {
          if (allowed(new URL(at))) {
            resolve();
          } else {
            stop(forbidden(at));
          }
        };
      });
      await Promise.race([navigated, stopped]);
      const page: unknown = await Promise.race([view.evaluate(code), stopped]);
      const unsupported = (page as { contentType?: unknown } | null)?.contentType;
      if (typeof unsupported === "string") {
        throw new WebpageError(`the address answers ${unsupported}, not a web page (HTML, Markdown or plain text)`);
      }
      if (!isWebpage(page)) {
        throw new WebpageError("the page could not be read");
      }
      if (!allowed(new URL(page.url))) {
        throw forbidden(page.url);
      }
      return page;
    } catch (e) {
      if (e instanceof WebpageError || e instanceof WebpageForbiddenError || signal.aborted) {
        throw e;
      }
      console.error("[webpage] unexpected error:", e);
      throw new WebpageError(`the page could not be read: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      view.close();
      if (--running === 0) {
        idle = setTimeout(() => {
          if (running === 0) {
            Bun.WebView.closeAll();
          }
        }, IDLE_CLOSE_MS);
        idle.unref();
      }
    }
  }

  return { problem, fetch: fetchPage };
}
