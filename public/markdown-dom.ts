// Writes the translation into the output element as it streams: as plain text, or rendered from
// Markdown when the source looked like Markdown. Elements are built with the DOM API only; no
// string from the model is ever parsed as HTML. The source preview is rendered the same way.
//
// Each top-level element carries `data-line`, the index of its first line in the text (one span
// per line for plain text, one element per block for Markdown), so scrolling can be synced by line.

import { LINK_NOTE, linkProblem, type LinkReference } from "./links.ts";
import { type Align, type Block, type Inline, MarkdownStream, type ParsedBlock } from "./markdown.ts";

/** What the rendered tree holds: elements and text; nothing else is ever created. */
type Child = Element | Text;

export interface OutputView {
  /** Adds streamed text. Rendering may be deferred to the next frame. */
  append(text: string): void;
  /** Renders everything appended so far; call when the stream ends, however it ends. */
  finish(): void;
}

/** Links open only to the web or mail; anything else (javascript:, data:, relative paths) stays text. */
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  children: Child[] = [],
  className = "",
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) {
    e.className = className;
  }
  e.append(...children);
  return e;
}

function link(href: string, title: string, children: Child[]): Child {
  if (!SAFE_URL.test(href)) {
    return el("span", children);
  }
  const a = el("a", children);
  a.href = href;
  if (title) {
    a.title = title;
  }
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function inlineNodes(nodes: Inline[]): Child[] {
  return nodes.map((n): Child => {
    switch (n.type) {
      case "text": {
        return document.createTextNode(n.text);
      }
      case "br": {
        return el("br");
      }
      case "code": {
        const code = el("code");
        code.textContent = n.text;
        return code;
      }
      case "em":
      case "strong":
      case "del": {
        return el(n.type, inlineNodes(n.children));
      }
      case "link": {
        return link(n.href, n.title, inlineNodes(n.children));
      }
      case "image": {
        // Shown as a link: the page loads nothing from other origins.
        return link(n.href, n.title, [document.createTextNode(n.alt || n.href)]);
      }
    }
  });
}

const ALIGN_CLASS = (a: Align) => (a ? `align-${a}` : "");

/**
 * A code block or table that is wider than its room scrolls sideways; only then is it focusable
 * (a named group; `scroll-focus.ts` does the same for the panes), so keyboard users can scroll it and the others add no tab stop.
 */
let scrollWatch: ResizeObserver | undefined;

function keyboardScrollable(box: HTMLElement, label: string) {
  scrollWatch ??= new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const scrolls = target.scrollWidth > target.clientWidth;
      if (scrolls === target.hasAttribute("tabindex")) {
        continue;
      }
      if (scrolls) {
        target.setAttribute("tabindex", "0");
        target.setAttribute("role", "group");
        target.setAttribute("aria-label", (target as HTMLElement).dataset.scrollLabel ?? "");
      } else {
        for (const name of ["tabindex", "role", "aria-label"]) {
          target.removeAttribute(name);
        }
      }
    }
  });
  box.dataset.scrollLabel = label;
  scrollWatch.observe(box);
}

function blockNode(b: Block, tight = false): Child[] {
  switch (b.type) {
    case "heading": {
      // Two levels down, below the page's own h1 and h2; the class keeps the source level for styling.
      return [el(`h${Math.min(b.level + 2, 6)}` as "h3", inlineNodes(b.children), `md-h${b.level}`)];
    }
    case "paragraph": {
      return tight ? inlineNodes(b.children) : [el("p", inlineNodes(b.children))];
    }
    case "code": {
      const code = el("code");
      code.textContent = b.text;
      if (/^[\w+#.-]+$/.test(b.lang)) {
        code.className = `language-${b.lang}`;
      }
      const pre = el("pre", [code]);
      keyboardScrollable(pre, "Code");
      return [pre];
    }
    case "quote": {
      return [el("blockquote", blockNodes(b.children))];
    }
    case "hr": {
      return [el("hr")];
    }
    case "list": {
      const list = el(b.ordered ? "ol" : "ul");
      if (b.ordered && b.start !== 1) {
        (list as HTMLOListElement).start = b.start;
      }
      for (const item of b.items) {
        const li = el("li", blockNodes(item.children, b.tight));
        if (item.task !== null) {
          const box = el("input");
          box.type = "checkbox";
          box.checked = item.task;
          box.disabled = true;
          // The item's own text follows it; the box says only its state.
          box.lang = "en";
          box.setAttribute("aria-label", item.task ? "Done" : "Not done");
          li.prepend(box, " ");
          li.className = "task";
        }
        list.append(li);
      }
      return [list];
    }
    case "table": {
      const cell = (tag: "th" | "td", content: Inline[], k: number) =>
        el(tag, inlineNodes(content), ALIGN_CLASS(b.align[k] ?? null));
      const head = el("thead", [
        el(
          "tr",
          b.head.map((h, k) => cell("th", h, k)),
        ),
      ]);
      const body = el(
        "tbody",
        b.rows.map((r) =>
          el(
            "tr",
            r.map((c, k) => cell("td", c, k)),
          ),
        ),
      );
      const scroll = el("div", [el("table", [head, body])], "table-scroll");
      keyboardScrollable(scroll, "Table");
      return [scroll];
    }
  }
}

function blockNodes(blocks: Block[], tight = false): Child[] {
  return blocks.flatMap((b) => blockNode(b, tight));
}

/** With prefers-reduced-motion: reduce, streamed text is shown in batches this far apart. */
const REDUCED_MOTION_FLUSH_MS = 1000;

function prefersReducedMotion(): boolean {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Plain text: one span per line, holding the line and its newline; the last span grows. */
function plainOutput(target: HTMLElement, reduced: boolean): OutputView {
  target.replaceChildren();
  let line: HTMLSpanElement | null = null;
  let count = 0;
  const write = (t: string) => {
    for (const part of t.split(/(?<=\n)/)) {
      if (!part) {
        continue;
      }
      if (!line) {
        line = el("span");
        line.dataset.line = String(count++);
        line.append("");
        target.append(line);
      }
      (line.firstChild as Text).appendData(part);
      if (part.endsWith("\n")) {
        line = null;
      }
    }
  };
  if (!reduced) {
    return { append: write, finish() {} };
  }

  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending) {
      write(pending);
    }
    pending = "";
  };
  return {
    append(t) {
      pending += t;
      timer ??= setTimeout(flush, REDUCED_MOTION_FLUSH_MS);
    },
    finish: flush,
  };
}

/** `settled` marks blocks that will not change again; the stylesheet's costly text layout waits for it. */
function lineNodes(parsed: ParsedBlock[], settled: boolean): Child[] {
  return parsed.flatMap(({ block, line }) => {
    const nodes = blockNode(block);
    for (const n of nodes) {
      if (!(n instanceof HTMLElement)) {
        continue;
      }
      n.dataset.line = String(line);
      if (settled) {
        n.classList.add("settled");
      }
    }
    return nodes;
  });
}

/**
 * Markdown, rendered incrementally: finished blocks are appended once and left alone; only the
 * blocks of the open tail are rebuilt, at most once per animation frame.
 */
function markdownOutput(target: HTMLElement, reduced: boolean): OutputView {
  target.replaceChildren();
  const stream = new MarkdownStream();
  let tail: Child[] = [];
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const render = (final = false) => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = 0;
    timer = undefined;
    const { done, tail: open } = stream.takeParsed();
    for (const node of tail) {
      node.remove();
    }
    tail = lineNodes(open, final);
    target.append(...lineNodes(done, true), ...tail);
  };

  return {
    append(t) {
      stream.push(t);
      if (reduced) {
        timer ??= setTimeout(() => render(), REDUCED_MOTION_FLUSH_MS);
      } else if (!frame) {
        frame = requestAnimationFrame(() => render());
      }
    },
    finish: () => render(true),
  };
}

/** Marks the links under a freshly rendered, complete output. */
export function checkLinks(root: HTMLElement, ref: LinkReference) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    const line = Number(a.closest<HTMLElement>("[data-line]")?.dataset.line ?? 0);
    const problem = linkProblem(ref, href, line);
    if (!problem) {
      a.dataset.linkPaired = "true";
      continue;
    }
    a.dataset.linkProblem = problem;
    a.title = LINK_NOTE[problem];
    const note = el("span", [document.createTextNode(` (${LINK_NOTE[problem]})`)], "sr-only");
    a.append(note);
    if (problem === "missing") {
      // Not a link any more: no target to follow, still announced as a disabled link.
      a.removeAttribute("href");
      a.setAttribute("role", "link");
      a.setAttribute("aria-disabled", "true");
    }
  }
}

/** Clears `target` and returns the view that streamed text should be written to. */
export function createOutput(target: HTMLElement, markdown: boolean): OutputView {
  target.classList.toggle("markdown", markdown);
  const reduced = prefersReducedMotion();
  return markdown ? markdownOutput(target, reduced) : plainOutput(target, reduced);
}

/** Writes a whole text into `target` at once, rendered as `createOutput` would stream it. */
export function renderText(target: HTMLElement, text: string, markdown: boolean) {
  const view = createOutput(target, markdown);
  view.append(text);
  view.finish();
}
