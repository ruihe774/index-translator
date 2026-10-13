// <speech-controls side="source" subject="source text">: Listen / Stop, and while that side is read
// Previous, Pause / Resume and Next. One element per panel; both are the same buttons, so they are
// built here once instead of being written out twice in index.html.
//
// A light-DOM element (the page gives it `role="group"`; the label comes from `subject`): the buttons keep the ids `listen-<side>`, `prev-<side>`,
// `pause-<side>`, `next-<side>`, which the stylesheet's `data-state` rules and the tests use. The
// page tells it what to show with `show()`; the element writes the attributes and says what was
// pressed with events: `listen`, `prev`, `pause`, `next`. Nothing here knows about the player.
//
// Buttons are `aria-disabled`, never `disabled`. Listen always sends its event, even when blocked:
// the page answers by saying why, which is how a keyboard or touch user learns the reason.

export type ReadingState = "idle" | "loading" | "playing" | "paused";

/** What one side's controls show. */
export interface SpeechView {
  /** This side is the one being read. */
  reading: boolean;
  /** The player's state while `reading`; `idle` otherwise. */
  state: ReadingState;
  /** Why this side cannot be read now; empty when it can. */
  blocked: string;
  canPrev: boolean;
  canNext: boolean;
}

const SVG = "http://www.w3.org/2000/svg";

function icon(className: string | null, ...shapes: [tag: string, attrs: Record<string, string>][]): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  if (className) {
    svg.setAttribute("class", className);
  }
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) {
      shape.setAttribute(name, value);
    }
    svg.append(shape);
  }
  return svg;
}

const path = (d: string): [string, Record<string, string>] => ["path", { d }];

function button(id: string, ...icons: SVGElement[]): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = id;
  b.className = "icon";
  b.append(...icons);
  return b;
}

function setAttr(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

export class SpeechControls extends HTMLElement {
  #listen!: HTMLButtonElement;
  #prev!: HTMLButtonElement;
  #pause!: HTMLButtonElement;
  #next!: HTMLButtonElement;
  #why!: HTMLElement;
  #built = false;

  connectedCallback() {
    if (this.#built) {
      return;
    }
    this.#built = true;
    const side = this.getAttribute("side") ?? "";
    const { subject } = this;
    this.setAttribute("aria-label", `Read the ${subject} aloud`);

    this.#listen = button(
      `listen-${side}`,
      icon(
        "when-idle",
        path(
          "M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z",
        ),
      ),
      icon("when-active", path("M6 6h12v12H6z")),
    );
    this.#listen.setAttribute("aria-describedby", `listen-${side}-why`);
    this.#prev = button(`prev-${side}`, icon(null, path("M6 6h2v12H6zm3.5 6 8.5 6V6z")));
    this.#pause = button(
      `pause-${side}`,
      icon("when-playing", path("M6 5h4v14H6zm8 0h4v14h-4z")),
      icon("when-paused", path("M8 5v14l11-7z")),
      icon("when-loading", [
        "circle",
        {
          cx: "12",
          cy: "12",
          r: "8",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "3",
          "stroke-linecap": "round",
          "stroke-dasharray": "36 14",
        },
      ]),
    );
    this.#next = button(`next-${side}`, icon(null, path("m6 18 8.5-6L6 6zM16 6v12h2V6z")));
    this.#why = document.createElement("span");
    this.#why.id = `listen-${side}-why`;
    this.#why.className = "sr-only";
    this.append(this.#listen, this.#prev, this.#pause, this.#next, this.#why);

    this.#prev.setAttribute("aria-label", "Previous block");
    this.#prev.title = "Previous block (from inside a block, its start)";
    this.#next.setAttribute("aria-label", "Next block");
    this.#next.title = "Next block";
    this.show({ reading: false, state: "idle", blocked: "", canPrev: false, canNext: false });

    this.#listen.addEventListener("click", () => this.dispatchEvent(new Event("listen")));
    for (const [b, name] of [
      [this.#prev, "prev"],
      [this.#pause, "pause"],
      [this.#next, "next"],
    ] as const) {
      b.addEventListener("click", () => {
        if (b.getAttribute("aria-disabled") !== "true") {
          this.dispatchEvent(new Event(name));
        }
      });
    }
  }

  /** What the side's text is called in the labels: "source text", "translation". */
  private get subject(): string {
    return this.getAttribute("subject") ?? "text";
  }

  show({ reading, state, blocked, canPrev, canNext }: SpeechView) {
    const { subject } = this;
    // The controls that appear while reading go away when it ends: do not leave focus on one.
    if (!reading && [this.#pause, this.#prev, this.#next].includes(document.activeElement as HTMLButtonElement)) {
      this.#listen.focus();
    }
    const label = reading ? `Stop reading the ${subject}` : `Listen to the ${subject}`;
    setAttr(this.#listen, "data-state", state);
    setAttr(this.#listen, "aria-disabled", String(blocked !== ""));
    setAttr(this.#listen, "aria-label", label);
    this.#listen.title = blocked || label;
    // The reason is also the button's description: `title` alone is not reachable by keyboard or touch.
    if (this.#why.textContent !== blocked) {
      this.#why.textContent = blocked;
    }

    for (const b of [this.#prev, this.#pause, this.#next]) {
      if (b.hidden === reading) {
        b.hidden = !reading;
      }
    }
    // While the next audio is being made, only Stop works.
    const waiting = state === "loading";
    setAttr(this.#prev, "aria-disabled", String(waiting || !(reading && canPrev)));
    setAttr(this.#next, "aria-disabled", String(waiting || !(reading && canNext)));
    setAttr(this.#pause, "aria-disabled", String(waiting));
    setAttr(this.#pause, "data-state", state);
    const pause = waiting ? "Preparing the audio…" : state === "paused" ? "Resume reading" : "Pause reading";
    this.#pause.title = pause;
    setAttr(this.#pause, "aria-label", pause);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "speech-controls": SpeechControls;
  }
}
