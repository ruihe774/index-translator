// Click-to-sync scrolling between the source and the translation. A pane maps a click to a line of
// its text and a line to its position on screen; the paragraph alignment (`paragraphs.ts`) maps a
// block of one text to the same block of the other. Used only while the paragraph check passes.

import { blockAt } from "./paragraphs.ts";

export interface Pane {
  /** The element that scrolls. */
  scroller: HTMLElement;
  /** Line of the text at a click inside the pane, or null if none can be told. */
  lineAt(e: MouseEvent): number | null;
  /** Viewport y of the top of `line`, or of the nearest rendered line before it. */
  lineTop(line: number): number | null;
}

/** A rendered view whose top-level children carry `data-line` (see `markdown-dom.ts`). */
export function viewPane(view: HTMLElement, scroller: HTMLElement): Pane {
  return {
    scroller,
    lineAt(e) {
      const hit = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-line]") : null;
      return hit && view.contains(hit) ? Number(hit.dataset.line) : null;
    },
    lineTop(line) {
      let best: HTMLElement | null = null;
      for (const child of view.children) {
        if (!(child instanceof HTMLElement) || child.dataset.line === undefined) continue;
        if (Number(child.dataset.line) > line) break;
        best = child;
      }
      best ??= view.firstElementChild as HTMLElement | null;
      return best ? best.getBoundingClientRect().top : null;
    },
  };
}

const MIRRORED = [
  "boxSizing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "textIndent",
  "textTransform",
  "direction",
  "overflowWrap",
  "wordBreak",
] as const;

/** Offset of `line` from the top of the textarea's content, measured on a hidden copy of it. */
function textareaOffset(area: HTMLTextAreaElement, line: number): number {
  const lines = area.value.split("\n");
  const before = lines
    .slice(0, Math.min(line, lines.length))
    .map((l) => l + "\n")
    .join("");
  const style = getComputedStyle(area);
  const mirror = document.createElement("div");
  for (const key of MIRRORED) mirror.style[key] = style[key];
  // The text wraps at the textarea's client width, which excludes a scrollbar.
  mirror.style.inlineSize = `${area.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`;
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.insetBlockStart = "0";
  mirror.style.insetInlineStart = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.textContent = before;
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

/** The raw source in its textarea: a click reads the caret, a line is found by measuring. */
export function textareaPane(area: HTMLTextAreaElement): Pane {
  return {
    scroller: area,
    lineAt() {
      if (area.selectionStart !== area.selectionEnd) return null;
      return area.value.slice(0, area.selectionStart).split("\n").length - 1;
    },
    lineTop(line) {
      return area.getBoundingClientRect().top + textareaOffset(area, line) - area.scrollTop;
    },
  };
}

const LINKED = "linked";

/** Removes the linked-block background from `view`. */
export function clearLinked(view: HTMLElement) {
  for (const el of view.querySelectorAll(`.${LINKED}`)) el.classList.remove(LINKED);
}

/**
 * Marks the elements of `view` that show block `k`, so the block under the pointer in the other
 * pane has its counterpart shaded here. `starts` are the first lines of the view's blocks.
 */
export function markLinked(view: HTMLElement, starts: number[], k: number) {
  clearLinked(view);
  const from = starts[k];
  if (from === undefined) return;
  const to = starts[k + 1] ?? Infinity;
  for (const child of view.children) {
    if (!(child instanceof HTMLElement) || child.dataset.line === undefined) continue;
    const line = Number(child.dataset.line);
    if (line >= from && line < to) child.classList.add(LINKED);
  }
}

/** The block of the hovered element of a rendered view, or null if the pointer is not over one. */
export function hoveredBlock(e: Event, view: HTMLElement, starts: number[]): number | null {
  const hit = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-line]") : null;
  return hit && view.contains(hit) ? blockAt(starts, Number(hit.dataset.line)) : null;
}

/**
 * Scrolls `to` so that the block clicked in `from` starts at the same height in both panes.
 * `fromStarts` and `toStarts` are the first lines of the blocks of each pane's text.
 */
export function syncFrom(e: MouseEvent, from: Pane, fromStarts: number[], to: Pane, toStarts: number[]): boolean {
  const selection = getSelection();
  if (selection && !selection.isCollapsed && from.scroller.contains(selection.anchorNode)) return false;
  const line = from.lineAt(e);
  if (line === null) return false;
  const k = blockAt(fromStarts, line);
  const fromTop = from.lineTop(fromStarts[k]!);
  const toTop = to.lineTop(toStarts[k]!);
  if (fromTop === null || toTop === null) return false;
  const anchor = fromTop - from.scroller.getBoundingClientRect().top;
  const target = toTop - to.scroller.getBoundingClientRect().top;
  to.scroller.scrollTop += target - anchor;
  return true;
}
