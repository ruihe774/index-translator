// <view-switch>: a group of buttons of which one is pressed (Raw / Preview, the model choice).
//
// A light-DOM element (`role="group"`, named by the page's `aria-label`): it enhances the buttons
// written in index.html and adds no markup, so the
// stylesheet, `aria-describedby` references and the tests see ordinary buttons. Each button names
// its value in `data-value`; the pressed one carries `aria-pressed="true"`. The page is the only
// place that holds the value (the DOM is the state), so `value` reads and writes the attributes.
//
// `disabled` is `aria-disabled` on every button, never `disabled`, which would take them out of the
// tab order and hide them from screen reader users; a click on a disabled switch does nothing.
// `change` fires when a click moves the pressed button, not when `value` is set from code.

export class ViewSwitch extends HTMLElement {
  constructor() {
    super();
    this.addEventListener("click", (e) => {
      const button = (e.target as Element).closest("button");
      if (!button || !this.contains(button)) return;
      const value = button.dataset.value;
      if (value === undefined || this.disabled || value === this.value) return;
      this.value = value;
      this.dispatchEvent(new Event("change"));
    });
  }

  connectedCallback() {
    // The group is what this element is; the page only has to name it with `aria-label`.
    if (!this.hasAttribute("role")) this.setAttribute("role", "group");
  }

  private get buttons(): HTMLCollectionOf<HTMLButtonElement> {
    return this.getElementsByTagName("button");
  }

  /** The `data-value` of the pressed button; empty when none is. */
  get value(): string {
    for (const b of this.buttons) if (b.getAttribute("aria-pressed") === "true") return b.dataset.value ?? "";
    return "";
  }

  set value(value: string) {
    for (const b of this.buttons) {
      const pressed = String(b.dataset.value === value);
      if (b.getAttribute("aria-pressed") !== pressed) b.setAttribute("aria-pressed", pressed);
    }
  }

  get disabled(): boolean {
    return this.buttons[0]?.getAttribute("aria-disabled") === "true";
  }

  set disabled(disabled: boolean) {
    const text = String(disabled);
    for (const b of this.buttons) if (b.getAttribute("aria-disabled") !== text) b.setAttribute("aria-disabled", text);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-switch": ViewSwitch;
  }
}
