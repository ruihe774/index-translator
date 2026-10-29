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
 * Runs `change`, which hides `within`, and then puts focus on `to` if it was in `within` (or nowhere,
 * on the body, as after a hidden button lost it). The check comes first: a hidden button loses focus.
 */
export function restoreFocusAfter(within: Element, to: HTMLElement, change: () => void) {
  const had = hasFocus(within) || document.activeElement === document.body;
  change();
  if (had) {
    to.focus();
  }
}

/** Whether Clear has anything to act on. */
export function clearEnabled(): boolean {
  return state.source.length > 0 || state.image || state.translation.length > 0;
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
    setAttr(t.clear, "aria-disabled", String(!clearEnabled()));
    setAttr(t.copy, "aria-disabled", String(!copyEnabled()));
    t.sourceSwitch.disabled = !hasText;
    t.outputSwitch.disabled = !hasOutput;
    setHidden(t.stop, !running);
    setHidden(t.clear, running);
    t.after();
  };
}
