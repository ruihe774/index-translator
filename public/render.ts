// `render()`: what the controls look like, derived from `state` alone.
//
// The always-shown buttons stay in the page and are `aria-disabled` while they have nothing to act
// on (never `disabled`, which would take them out of the tab order); Stop takes Clear's place while
// a translation runs. Every write is skipped when the value is already there, so rendering often
// costs nothing.

import type { ViewSwitch } from "./elements/view-switch.js";
import { state } from "./state.js";

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
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function setHidden(el: HTMLElement, hidden: boolean) {
  if (el.hidden !== hidden) el.hidden = hidden;
}

export function createRender(t: RenderTargets): () => void {
  return function render() {
    const running = state.running !== null;
    const hasText = state.source.length > 0;
    const hasOutput = state.translation.length > 0;
    setAttr(t.translate, "aria-disabled", String(running || !state.languagesReady));
    setAttr(t.clear, "aria-disabled", String(!hasText && !hasOutput));
    setAttr(t.copy, "aria-disabled", String(!hasOutput || running));
    t.sourceSwitch.disabled = !hasText;
    t.outputSwitch.disabled = !hasOutput;
    setHidden(t.stop, !running);
    setHidden(t.clear, running);
    t.after();
  };
}
