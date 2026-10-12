// The page's state that decides what the controls look like. `render()` (render.ts) is the one
// place that turns it into attributes, so a change here needs no list of things to refresh.
//
// Not kept here: text still streaming into the output view, the speech player's own state and
// anything else that is rebuilt incrementally on purpose; those are written to the DOM as they
// happen and only report into this object.

export interface State {
  /** The translation under way; `null` when none runs. Aborting it stops the request. */
  running: AbortController | null;
  /** The raw translation as streamed so far (the copied text), also after it finished. */
  translation: string;
  /** False until the language selects hold their options. */
  languagesReady: boolean;
  /** The source text as in the text box. */
  source: string;
}

export const state: State = {
  running: null,
  translation: "",
  languagesReady: false,
  source: "",
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
