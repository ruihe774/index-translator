// Marks the sentence under the pointer in the rendered views, over the shade of its paragraph. The mark
// is a range of the text, not an element: the CSS Custom Highlight API (`::highlight(sentence)`,
// css/sentence.css) paints it, so the rendered tree, copying and the Markdown stream are untouched.
// Without that API, or the way to find the text under a point, nothing is marked. The raw source in
// its text box is not a view and has no sentences to mark.
//
// While the source's blocks and the translation's are matched (`pairing.blocks`), the sentence's
// counterpart in the other view is marked too, with the rest of its group: the sentences `POST /align`
// pairs it with (`sentence-align.ts`), asked for the hovered block (with the blocks it was matched with,
// when the translation merged or split it) only once the sentence model has answered for every group of
// both sides, as the pairs are of its sentences.
//
// A view's groups (`sentence-spans.ts`) are collected at the first move after the view last changed;
// any change to a view drops the mark, as its ranges may point at removed nodes.

import { type Alignment, counterpart, type LineRange } from "./paragraphs.ts";
import type { SentenceBoundaries } from "./segment.ts";
import { pairOf, type SentenceAligner } from "./sentence-align.ts";
import { locate, type Run, sentenceSpans, spansAt } from "./sentence-spans.ts";
import type { Side } from "./state.ts";
import { collectGroups, type TextGroup } from "./text-groups.ts";

const NAME = "sentence";
/** The pointer counts as over a sentence this far (CSS pixels) beyond its lines' boxes: between two lines is not outside. */
const SLACK = 6;

export interface HoverPane {
  /** The element that scrolls and gets the pointer events. */
  scroller: HTMLElement;
  /** The rendered text. */
  view: HTMLElement;
  /** Which text it shows, as `Alignment` names it. */
  side: Side;
}

export interface Pairing {
  aligner: SentenceAligner;
  /** The matched blocks of what the views show, or null while they are not matched. */
  blocks(): Alignment | null;
}

interface Collected {
  groups: Map<Text, { group: TextGroup; run: Run<Text> }>;
  /** Every group in reading order, with the `data-line` of the top-level element it is in. */
  ordered: { group: TextGroup; line: number }[];
}

/** One sentence of a group: [start, end) of its text. */
interface Sentence {
  group: TextGroup;
  span: [number, number];
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

/** The range of a sentence, or null when its ends cannot be placed. */
function rangeOf({ group, span }: Sentence): Range | null {
  const start = locate(group.runs, span[0], "start");
  const end = locate(group.runs, span[1], "end");
  if (!start || !end) {
    return null;
  }
  const range = new Range();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/** The `data-line` of the top-level element of `view` that holds `node`. */
function lineOf(node: Node, view: HTMLElement): number | null {
  let top = node.parentElement;
  while (top && top.parentElement !== view) {
    top = top.parentElement;
  }
  return top?.dataset.line === undefined ? null : Number(top.dataset.line);
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

interface PaneState {
  pane: HoverPane;
  collected: Collected | null;
  cuts: WeakMap<TextGroup, Cut>;
  /** Marks again under the pointer, if it is still over this pane. */
  refresh(): void;
}

/**
 * Starts marking sentences in `panes`, while `enabled()` (not while a translation streams). Where they end
 * is what `boundaries` has for the group's text, `Intl.Segmenter` until it has. With `pairing`, the
 * counterpart in the other pane is marked as well.
 */
export function initSentenceHover(
  panes: HoverPane[],
  enabled: () => boolean,
  boundaries: SentenceBoundaries,
  pairing?: Pairing,
): SentenceHover {
  if (!supported()) {
    return { prefetch() {} };
  }
  const prefetchers: (() => void)[] = [];
  const highlight = new Highlight();
  CSS.highlights.set(NAME, highlight);
  /** What is marked now, to leave it alone while it stays the same. */
  let current: { group: TextGroup; span: [number, number]; with: string } | null = null;
  const clear = () => {
    highlight.clear();
    current = null;
  };

  const collect = (view: HTMLElement): Collected => {
    const groups = new Map<Text, { group: TextGroup; run: Run<Text> }>();
    const ordered: Collected["ordered"] = [];
    for (const group of collectGroups(view)) {
      for (const run of group.runs) {
        groups.set(run.node, { group, run });
      }
      const line = lineOf(group.runs[0]!.node, view);
      if (line !== null) {
        ordered.push({ group, line });
      }
    }
    return { groups, ordered };
  };

  /** The group's sentences, by the model once it has answered. */
  const cutOf = (state: PaneState, group: TextGroup): Cut => {
    const { lang } = state.pane.view;
    const answer = lang ? boundaries.get(group.text) : undefined;
    let cut = state.cuts.get(group);
    if (!cut || (answer && !cut.model)) {
      cut = { spans: sentenceSpans(group.text, lang, answer), model: answer !== undefined };
      state.cuts.set(group, cut);
    }
    return cut;
  };

  /**
   * The sentences of the lines `from` to `to` of a pane as the sentence model cuts them, or null while it has not answered
   * for each of its groups (or cannot, without a language).
   */
  const blockSentences = (state: PaneState, { from, to }: LineRange): Sentence[] | null => {
    if (!state.pane.view.lang) {
      return null;
    }
    state.collected ??= collect(state.pane.view);
    const sentences: Sentence[] = [];
    for (const { group, line } of state.collected.ordered) {
      if (line < from || line >= to || !WORDS.test(group.text)) {
        continue;
      }
      const cut = cutOf(state, group);
      if (!cut.model) {
        return null;
      }
      sentences.push(...cut.spans.map((span) => ({ group, span })));
    }
    return sentences;
  };

  /** The sentences marked with `hovered` in its pane and the other, and a key that tells whether that changed. */
  const counterparts = (state: PaneState, hovered: Sentence): { sentences: Sentence[]; key: string } => {
    const none = { sentences: [], key: "" };
    const blocks = pairing?.blocks();
    const other = states.find((s) => s !== state);
    if (!pairing || !blocks || !other) {
      return none;
    }
    state.collected ??= collect(state.pane.view);
    const line = state.collected.ordered.find((o) => o.group === hovered.group)?.line;
    if (line === undefined) {
      return none;
    }
    const { side } = state.pane;
    const match = counterpart(blocks, side, line);
    if (!match) {
      return none;
    }
    const own = blockSentences(state, match.own);
    const theirs = blockSentences(other, match.other);
    if (!own || !theirs || own.length === 0 || theirs.length === 0) {
      return none;
    }
    const index = own.findIndex((s) => s.group === hovered.group && s.span === hovered.span);
    if (index === -1) {
      return none;
    }
    const texts = (list: Sentence[]) => list.map((s) => s.group.text.slice(s.span[0], s.span[1]));
    const [source, target] = side === "source" ? [own, theirs] : [theirs, own];
    const pairs = pairing.aligner.get(texts(source), texts(target));
    if (!pairs) {
      pairing.aligner.request(texts(source), texts(target), () => state.refresh());
      return none;
    }
    const pair = pairOf(pairs, side === "source" ? "source" : "target", index);
    if (!pair) {
      return none;
    }
    return {
      sentences: [...pair.source.map((i) => source[i]!), ...pair.target.map((i) => target[i]!)].filter(
        (s) => s.group !== hovered.group || s.span !== hovered.span,
      ),
      key: `${match.own.from}:${JSON.stringify(pair)}`,
    };
  };

  const states: PaneState[] = [];
  for (const pane of panes) {
    const { scroller, view } = pane;
    let frame = 0;
    let x = 0;
    let y = 0;
    let dragging = false;
    let inside = false;
    const state: PaneState = {
      pane,
      collected: null,
      cuts: new WeakMap(),
      refresh() {
        if (inside) {
          frame ||= requestAnimationFrame(update);
        }
      },
    };
    states.push(state);
    new MutationObserver(() => {
      state.collected = null;
      clear();
    }).observe(view, { childList: true, subtree: true, characterData: true });
    prefetchers.push(() => {
      // Without the language an answer is not used (`sentenceSpans`), so it is not asked for.
      if (!view.lang) {
        return;
      }
      // The view has just been rebuilt, maybe in this very task: what was collected may be of the one before.
      state.collected = collect(view);
      const groups = new Set([...state.collected.groups.values()].map((hit) => hit.group));
      boundaries.request([...groups].map((g) => g.text).filter((t) => WORDS.test(t)));
    });

    const update = () => {
      frame = 0;
      if (!enabled() || dragging) {
        clear();
        return;
      }
      const caret = caretAt(x, y);
      state.collected ??= collect(view);
      const hit = caret && caret.node instanceof Text ? state.collected.groups.get(caret.node) : undefined;
      if (!hit) {
        clear();
        return;
      }
      const { group, run } = hit;
      // What the model has said by now; if it has not, it is asked for this text before the others.
      if (view.lang && !boundaries.get(group.text)) {
        boundaries.request([group.text], true);
      }
      const cut = cutOf(state, group);
      for (const span of spansAt(cut.spans, run.start + caret!.offset)) {
        const range = rangeOf({ group, span });
        if (!range || !over(range, x, y)) {
          continue;
        }
        const linked = counterparts(state, { group, span });
        if (current?.group !== group || current.span !== span || current.with !== linked.key) {
          highlight.clear();
          highlight.add(range);
          for (const s of linked.sentences) {
            const r = rangeOf(s);
            if (r) {
              highlight.add(r);
            }
          }
          current = { group, span, with: linked.key };
        }
        return;
      }
      clear();
    };

    scroller.addEventListener("mousemove", (e) => {
      x = e.clientX;
      y = e.clientY;
      inside = true;
      // Selecting text with the button down: the selection is what is shown.
      dragging = e.buttons !== 0;
      frame ||= requestAnimationFrame(update);
    });
    scroller.addEventListener("mouseleave", () => {
      inside = false;
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
