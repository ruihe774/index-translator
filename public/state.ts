// The page's state that decides what the controls look like. `render()` (render.ts) is the one
// place that turns it into attributes, so a change here needs no list of things to refresh.
//
// Not kept here: text still streaming into the output view, the speech player's own state (the
// player is asked) and anything else that is rebuilt incrementally on purpose; those are written to
// the DOM as they happen and only report into this object.

import type { Run } from "./run.ts";

/** The two texts that can be read aloud. */
export type Side = "source" | "output";

export interface State {
  /** The translation or page fetch under way; `null` when none runs. Its `stop()` ends it. */
  running: Run | null;
  /** The raw translation as streamed so far (the copied text), also after it finished. */
  translation: string;
  /** False until the language selects hold their options. */
  languagesReady: boolean;
  /** The source text as in the text box. */
  source: string;
  /** An image stands in place of the text box and is what Translate sends. */
  image: boolean;
  /** Why nothing can be read aloud at all (not installed, no voices); empty when it can. */
  speechProblem: string;
  /** The side being read and the first line of the block being spoken; `null` when none is. */
  speaking: { side: Side; line: number | null } | null;
  /** A reading failed: the voice list or the engine may have changed, so look again at the next chance. */
  voicesStale: boolean;
}

export const state: State = {
  running: null,
  translation: "",
  languagesReady: false,
  source: "",
  image: false,
  speechProblem: "Checking whether reading aloud is available…",
  speaking: null,
  voicesStale: false,
};

let renderer: (() => void) | undefined;

/** Registers the function that writes `state` to the page, and runs it once. */
export function bindRender(render: () => void) {
  renderer = render;
  render();
}

/** Merges the patch and renders at once: callers read attributes and move focus right after. */
export function setState(patch: Partial<State>) {
  Object.assign(state, patch);
  renderer?.();
}

/**
 * Adds streamed text to the translation. Only the first token changes what the controls show (Copy
 * and Clear become available), so only it renders; the rest just grows the copied text.
 */
export function appendTranslation(text: string) {
  if (state.translation.length === 0) {
    setState({ translation: text });
  } else {
    state.translation += text;
  }
}
