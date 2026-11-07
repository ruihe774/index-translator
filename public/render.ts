// `render()`: what the controls look like, derived from `state` alone.
//
// The always-shown buttons stay in the page and are `aria-disabled` while they have nothing to act
// on (never `disabled`, which would take them out of the tab order); Stop takes Clear's place while
// a translation runs. Every write is skipped when the value is already there, so rendering often
// costs nothing.

import type { ViewSwitch } from "./elements/view-switch.ts";
import { state } from "./state.ts";

export interface RenderTargets {
  translate: HTMLElement;
  stop: HTMLElement;
  /** Stop's twin in the translation's own actions, shown on one column only (css/buttons.css). */
  stopOutput: HTMLElement;
  clear: HTMLElement;
  copy: HTMLElement;
  sourceSwitch: ViewSwitch;
  outputSwitch: ViewSwitch;
  /** Runs after the controls are written, for what still depends on this state elsewhere. */
  after: () => void;
}

function setAttr(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

function setHidden(el: HTMLElement, hidden: boolean) {
  if (el.hidden !== hidden) {
    el.hidden = hidden;
  }
}

/** Whether focus is on one of `within` or inside it. */
export function hasFocus(...within: Element[]): boolean {
  return within.some((el) => el.contains(document.activeElement));
}

/**
 * Whether focus is nowhere the reader put it: on the body, as after a hidden button lost it, or on `<main>`
 * (`tabindex="-1"`, the skip link's target), where Safari puts it when a button is clicked: Safari focuses
 * no clicked button, but its nearest focusable ancestor.
 */
export function focusIsNowhere(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active.localName === "main";
}

/**
 * Runs `change`, which hides `within`, and then puts focus on `to` if it was in `within` (or nowhere, see
 * `focusIsNowhere`). The check comes first: a hidden button loses focus.
 */
export function restoreFocusAfter(within: Element, to: HTMLElement, change: () => void) {
  const had = hasFocus(within) || focusIsNowhere();
  change();
  if (had) {
    // `to` takes the place of what was hidden, so nothing needs scrolling; on one column the row of
    // panels would otherwise slide back to `to`'s panel (pane-carousel.ts).
    to.focus({ preventScroll: true });
  }
}

/** Whether Clear has anything to act on. */
export function clearEnabled(): boolean {
  return state.source.length > 0 || state.image || state.translation.length > 0;
}

/** Whether Translate has something new to do: an image, or text that is not what was last translated. */
export function translateIsNew(): boolean {
  if (state.image) {
    return true;
  }
  return state.source.length > 0 && !(state.translation.length > 0 && state.source === state.translatedSource);
}

/** Whether Copy has a finished translation to copy. */
export function copyEnabled(): boolean {
  return state.translation.length > 0 && state.running === null;
}

export function createRender(t: RenderTargets): () => void {
  return function render() {
    const running = state.running !== null;
    const hasText = state.source.length > 0;
    const hasOutput = state.translation.length > 0;
    setAttr(t.translate, "aria-disabled", String(running || !state.languagesReady));
    t.translate.classList.toggle("primary", translateIsNew());
    setAttr(t.clear, "aria-disabled", String(!clearEnabled()));
    setAttr(t.copy, "aria-disabled", String(!copyEnabled()));
    t.sourceSwitch.disabled = !hasText;
    t.outputSwitch.disabled = !hasOutput;
    setHidden(t.stop, !running);
    setHidden(t.stopOutput, !running);
    // The reading's own controls (pause, previous, next) are shown while it runs; Clear gives way.
    setHidden(t.clear, running || state.speaking !== null);
    t.after();
  };
}
