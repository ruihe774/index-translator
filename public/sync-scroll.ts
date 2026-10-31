// Click-to-sync scrolling between the source and the translation. A pane maps a click to a line of
// its text and a line to its position on screen; the paragraph alignment (`paragraphs.ts`) maps a
// block of one text to its counterpart in the other. Used only while the blocks are matched.

import { lineElements } from "./dom.ts";
import { type Alignment, counterpart, type LineRange } from "./paragraphs.ts";
import type { Side } from "./state.ts";

export interface Pane {
  /** The element that scrolls. */
  scroller: HTMLElement;
  /** Line of the text at a click inside the pane, or null if none can be told. */
  lineAt(e: MouseEvent): number | null;
  /** Viewport y of the top of `line`, or of the nearest rendered line before it. */
  lineTop(line: number): number | null;
}

/** A rendered view whose elements carry `data-line` (see `lineElements`). */
export function viewPane(view: HTMLElement, scroller: HTMLElement): Pane {
  return {
    scroller,
    lineAt(e) {
      const hit = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-line]") : null;
      return hit && view.contains(hit) ? Number(hit.dataset.line) : null;
    },
    lineTop(line) {
      const elements = lineElements(view);
      let best: HTMLElement | null = null;
      for (const el of elements) {
        if (Number(el.dataset.line) > line) {
          break;
        }
        best = el;
      }
      best ??= elements[0] ?? null;
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
  for (const key of MIRRORED) {
    mirror.style[key] = style[key];
  }
  // The text wraps at the textarea's client width, which excludes a scrollbar.
  mirror.style.inlineSize = `${area.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`;
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.insetBlockStart = "0";
  mirror.style.insetInlineStart = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.textContent = before;
  const marker = document.createElement("span");
  marker.textContent = "\u200B";
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
      if (area.selectionStart !== area.selectionEnd) {
        return null;
      }
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
  for (const el of view.querySelectorAll(`.${LINKED}`)) {
    el.classList.remove(LINKED);
  }
}

/**
 * Marks the elements of `view` that show the lines of `range`, so the block under the pointer in the
 * other pane has its counterpart shaded here.
 */
export function markLinked(view: HTMLElement, { from, to }: LineRange) {
  clearLinked(view);
  for (const el of lineElements(view)) {
    const line = Number(el.dataset.line);
    if (line >= from && line < to) {
      el.classList.add(LINKED);
    }
  }
}

/** The line of the hovered element of a rendered view, or null if the pointer is not over one. */
export function hoveredLine(e: Event, view: HTMLElement): number | null {
  const hit = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-line]") : null;
  return hit && view.contains(hit) ? Number(hit.dataset.line) : null;
}

/**
 * Scrolls `to` so that the block clicked in `from`, the pane of `side`, starts at the same height as its
 * counterpart in `to`. Nothing moves for a block with no counterpart.
 */
export function syncFrom(e: MouseEvent, from: Pane, to: Pane, a: Alignment, side: Side): boolean {
  const selection = getSelection();
  if (selection && !selection.isCollapsed && from.scroller.contains(selection.anchorNode)) {
    return false;
  }
  const line = from.lineAt(e);
  const match = line === null ? null : counterpart(a, side, line);
  if (!match) {
    return false;
  }
  const fromTop = from.lineTop(match.own.from);
  const toTop = to.lineTop(match.other.from);
  if (fromTop === null || toTop === null) {
    return false;
  }
  const anchor = fromTop - from.scroller.getBoundingClientRect().top;
  const target = toTop - to.scroller.getBoundingClientRect().top;
  to.scroller.scrollTop += target - anchor;
  return true;
}
