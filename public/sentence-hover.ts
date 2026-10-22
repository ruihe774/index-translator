// Marks the sentence under the pointer in the rendered views, over the shade of its paragraph. The mark
// is a range of the text, not an element: the CSS Custom Highlight API (`::highlight(sentence)`,
// css/sentence.css) paints it, so the rendered tree, copying and the Markdown stream are untouched.
// Without that API, or the way to find the text under a point, nothing is marked. The raw source in
// its text box is not a view and has no sentences to mark.
//
// A view's groups (`sentence-spans.ts`) are collected at the first move after the view last changed;
// any change to a view drops the mark, as its ranges may point at removed nodes.

import type { SentenceBoundaries } from "./segment.ts";
import { locate, type Run, sentenceSpans, spansAt } from "./sentence-spans.ts";
import { collectGroups, type TextGroup } from "./text-groups.ts";

const NAME = "sentence";
/** The pointer counts as over a sentence this far (CSS pixels) beyond its lines' boxes: between two lines is not outside. */
const SLACK = 6;

export interface HoverPane {
  /** The element that scrolls and gets the pointer events. */
  scroller: HTMLElement;
  /** The rendered text. */
  view: HTMLElement;
}

interface Collected {
  groups: Map<Text, { group: TextGroup; run: Run<Text> }>;
}

/** The node and offset under a point. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const at = document.caretPositionFromPoint(x, y);
  return at ? { node: at.offsetNode, offset: at.offset } : null;
}

function over(range: Range, x: number, y: number): boolean {
  for (const r of range.getClientRects()) {
    if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - SLACK && y <= r.bottom + SLACK) {
      return true;
    }
  }
  return false;
}

function supported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight === "function" &&
    typeof document.caretPositionFromPoint === "function"
  );
}

export interface SentenceHover {
  /** Asks the server where the sentences of what the views show end, after what is already waiting. */
  prefetch(): void;
}

/** A group's sentences, and whether they are the sentence model's (those by `Intl.Segmenter` are replaced when it answers). */
interface Cut {
  spans: [number, number][];
  model: boolean;
}

/** A text with something to say: a sentence model has nothing to tell about a rule or a bare number sign. */
const WORDS = /[\p{L}\p{N}]/u;

/**
 * Starts marking sentences in `panes`, while `enabled()` (not while a translation streams). Where they end
 * is what `boundaries` has for the group's text, `Intl.Segmenter` until it has.
 */
export function initSentenceHover(
  panes: HoverPane[],
  enabled: () => boolean,
  boundaries: SentenceBoundaries,
): SentenceHover {
  if (!supported()) {
    return { prefetch() {} };
  }
  const prefetchers: (() => void)[] = [];
  const highlight = new Highlight();
  CSS.highlights.set(NAME, highlight);
  /** The sentence marked now, to leave it alone while the pointer stays in it. */
  let current: { group: TextGroup; span: [number, number] } | null = null;
  const clear = () => {
    highlight.clear();
    current = null;
  };

  for (const { scroller, view } of panes) {
    let collected: Collected | null = null;
    const collect = (): Collected => {
      const groups = new Map<Text, { group: TextGroup; run: Run<Text> }>();
      for (const group of collectGroups(view)) {
        for (const run of group.runs) {
          groups.set(run.node, { group, run });
        }
      }
      return { groups };
    };
    const cuts = new WeakMap<TextGroup, Cut>();
    new MutationObserver(() => {
      collected = null;
      clear();
    }).observe(view, { childList: true, subtree: true, characterData: true });
    prefetchers.push(() => {
      // Without the language an answer is not used (`sentenceSpans`), so it is not asked for.
      if (!view.lang) {
        return;
      }
      // The view has just been rebuilt, maybe in this very task: what was collected may be of the one before.
      collected = collect();
      const groups = new Set([...collected.groups.values()].map((hit) => hit.group));
      boundaries.request([...groups].map((g) => g.text).filter((t) => WORDS.test(t)));
    });

    let frame = 0;
    let x = 0;
    let y = 0;
    let dragging = false;
    const update = () => {
      frame = 0;
      if (!enabled() || dragging) {
        clear();
        return;
      }
      const caret = caretAt(x, y);
      collected ??= collect();
      const hit = caret && caret.node instanceof Text ? collected.groups.get(caret.node) : undefined;
      if (!hit) {
        clear();
        return;
      }
      const { group, run } = hit;
      // What the model has said by now; if it has not, it is asked for this text before the others.
      const { lang } = view;
      const answer = lang ? boundaries.get(group.text) : undefined;
      if (lang && !answer) {
        boundaries.request([group.text], true);
      }
      let cut = cuts.get(group);
      if (!cut || (answer && !cut.model)) {
        cut = { spans: sentenceSpans(group.text, lang, answer), model: answer !== undefined };
        cuts.set(group, cut);
      }
      for (const span of spansAt(cut.spans, run.start + caret!.offset)) {
        const start = locate(group.runs, span[0], "start");
        const end = locate(group.runs, span[1], "end");
        if (!start || !end) {
          continue;
        }
        const range = new Range();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        if (!over(range, x, y)) {
          continue;
        }
        if (current?.group !== group || current.span !== span) {
          highlight.clear();
          highlight.add(range);
          current = { group, span };
        }
        return;
      }
      clear();
    };

    scroller.addEventListener("mousemove", (e) => {
      x = e.clientX;
      y = e.clientY;
      // Selecting text with the button down: the selection is what is shown.
      dragging = e.buttons !== 0;
      frame ||= requestAnimationFrame(update);
    });
    scroller.addEventListener("mouseleave", () => {
      cancelAnimationFrame(frame);
      frame = 0;
      clear();
    });
    // The text moves under a still pointer; the next move marks again.
    scroller.addEventListener("scroll", clear, { passive: true });
  }
  return {
    prefetch() {
      for (const prefetcher of prefetchers) {
        prefetcher();
      }
    },
  };
}
