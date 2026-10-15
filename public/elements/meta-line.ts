// <meta-line>: the one status line of the translation panel (progress, the result's numbers, a stop
// or an error), and the short messages that borrow it.
//
// `show(text, error)` replaces what is shown; `flash(text)` shows a message for a few seconds and
// then gives the line back to what it showed before. An error is styled and announced as an alert,
// anything else as a status. The line scrolls sideways when it is longer than its room, and only
// then is it focusable, so keyboard users can reach the rest of it.

const FLASH_MS = 3000;

export class MetaLine extends HTMLElement {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #shown = { text: "", error: false };
  readonly #resize = new ResizeObserver(() => this.#markScrollable());

  connectedCallback() {
    this.#resize.observe(this);
  }

  disconnectedCallback() {
    this.#resize.disconnect();
    clearTimeout(this.#timer);
  }

  show(text: string, error = false) {
    clearTimeout(this.#timer);
    this.#shown = { text, error };
    this.classList.toggle("error", error);
    this.setAttribute("role", error ? "alert" : "status");
    if (this.textContent !== text) {
      this.textContent = text;
    }
    this.#markScrollable();
  }

  flash(text: string) {
    const before = this.#shown;
    this.show(text);
    this.#timer = setTimeout(() => this.show(before.text, before.error), FLASH_MS);
  }

  #markScrollable() {
    if (this.scrollWidth > this.clientWidth) {
      this.tabIndex = 0;
    } else {
      this.removeAttribute("tabindex");
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "meta-line": MetaLine;
  }
}
