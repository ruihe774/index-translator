// Runs inside the web page that `POST /webpage` opens, not in the server: src/webpage.ts reads this
// file, strips its types and evaluates it in the page after turndown's browser build, which defines
// `TurndownService`. A script, not a module: it may not import anything, and everything it needs
// from the server comes in as an argument. What it returns crosses back as JSON.

/** The part of turndown's API used here (turndown 7, `vendor/turndown/turndown.js`). */
interface Turndown {
  addRule(
    name: string,
    rule: {
      filter: string | string[] | ((node: HTMLElement) => boolean);
      replacement: (content: string, node: HTMLElement) => string;
    },
  ): Turndown;
  remove(filter: string[]): Turndown;
  turndown(node: HTMLElement): string;
}
declare const TurndownService: new (options: Record<string, string>) => Turndown;

interface ExtractedPage {
  /** Where the page ended up, after redirects of any kind. */
  url: string;
  title: string;
  markdown: string;
}

/** Elements that never hold text a reader of the page sees as its content. */
const NOT_CONTENT =
  "script, style, noscript, template, iframe, object, embed, canvas, svg, button, input, select, textarea";
/** The parts of a page around its content: menus, sidebars, search. The page's own header and footer are found apart. */
const AROUND_CONTENT =
  "nav, aside, dialog, [role=navigation], [role=complementary], [role=search], [role=banner], [role=contentinfo]";

/** The one element matching `selector`, or null when there are none or several. */
function only(selector: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(selector);
  return all.length === 1 ? all[0]! : null;
}

/** A response that is not a page: its media type, for src/webpage.ts to refuse. */
interface UnsupportedPage {
  contentType: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- called by src/webpage.ts in the page
async function extractPage(
  loadWaitMs: number,
  quietMs: number,
  renderWaitMs: number,
): Promise<ExtractedPage | UnsupportedPage> {
  // The view reports a navigation when it commits; the page's own scripts may still be filling it.
  // Not `readyState`: it is "complete" just before the `load` handlers run. `loadEventEnd` is set
  // once they have; a listener added now runs after the page's own, then one task more.
  const timing = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!timing || timing.loadEventEnd === 0) {
    await new Promise((resolve) => {
      addEventListener("load", () => void setTimeout(resolve, 0), { once: true });
      setTimeout(resolve, loadWaitMs);
    });
  }
  // Markdown and plain text are already what we answer: the browser shows them as text in a single
  // <pre>, which is taken as it is. Any other response that is not HTML (an image, JSON, a PDF) has no page to read.
  // `document.contentType` is the media type without parameters; the browser has decoded the text by
  // the charset it names, a BOM or a <meta>, so nothing here depends on UTF-8.
  const contentType = document.contentType.toLowerCase();
  if (contentType === "text/markdown" || contentType === "text/plain") {
    const pre = document.querySelector("pre");
    return { url: location.href, title: "", markdown: pre?.textContent ?? document.body.textContent };
  }
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    return { contentType };
  }
  // Many pages only start filling themselves on `load`: wait until the DOM stays unchanged for
  // `quietMs`, or `renderWaitMs` at most for a page that never stops (a clock, a carousel).
  // Attributes are not watched: animations change styles without changing the text.
  await new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(limit);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    quiet = setTimeout(done, quietMs);
    const limit = setTimeout(done, renderWaitMs);
  });
  // A page that marks its content as one <main> or <article> is taken at its word; the header,
  // navigation and footer around it are left out. Several of them (a list of posts) or none: the
  // whole body.
  const main = only("main") ?? only("[role=main]") ?? document.body;
  const articles = main.querySelectorAll<HTMLElement>("article");
  const root = articles.length === 1 ? articles[0]! : main;
  // The page is this request's own and is closed afterwards, so it is changed in place: what the
  // page hides is only known from its live styles, which a copy would not have. Everything is
  // looked at before anything is removed, so the styles are computed once.
  const hidden = [...root.querySelectorAll<HTMLElement>("*")].filter(
    (el) =>
      el.matches(NOT_CONTENT) ||
      el.matches(AROUND_CONTENT) ||
      // A heading's "#" or "¶" that links to itself.
      (el.matches("a[href^='#']") && /^[#¶§]?$/u.test(el.textContent.trim())) ||
      (el.matches("header, footer") && !el.parentElement?.closest("article, section, main, aside, nav")) ||
      getComputedStyle(el).display === "none",
  );
  for (const el of hidden) {
    el.remove();
  }
  // Turndown copies attributes as written; a relative address would be resolved against our page.
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    a.setAttribute("href", a.href);
  }
  for (const img of root.querySelectorAll<HTMLImageElement>("img[src]")) {
    img.setAttribute("src", img.currentSrc || img.src);
  }
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  // A link that leads nowhere a reader could follow (a script, an empty name) keeps only its text.
  service.addRule("plainLinks", {
    filter: (node) =>
      node.nodeName === "A" &&
      (!/^(https?|mailto):/i.test(node.getAttribute("href") ?? "") || node.textContent.trim() === ""),
    replacement: (content) => content,
  });
  // An image with an empty `alt` is decoration, by HTML's own rule.
  service.addRule("decorativeImages", {
    filter: (node) => node.nodeName === "IMG" && node.getAttribute("alt") === "",
    replacement: () => "",
  });
  const markdown = service
    .turndown(root)
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
  return { url: location.href, title: document.title.trim(), markdown };
}
