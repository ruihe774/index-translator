// The "read from here" buttons beside the blocks of a pane, shown while that side's Read aloud is
// pressed. A click on the text itself stays click-to-sync; these buttons are separate targets in a
// column at the pane's start edge.
//
// One tab stop for the whole column (a vertical toolbar with a roving tabindex): Tab lands on the
// block being read, or on the one last focused, or on the first in view; Up and Down move between
// blocks, Home and End go to the first and last; Enter or Space reads from there. Focusing a
// button scrolls its block into view, as focus does.
//
// The buttons sit in the scroller, not in the view: the view's elements are what Copy, the link
// check, `data-line` and the streaming Markdown renderer work on, and nothing is added to them.
// Each button is placed at its block's height and as tall as the block, so it scrolls with the
// text by itself; the places are measured again when the scroller or any block changes size.

export interface GutterBlock {
  /** The block's first line, its `data-line`. */
  line: number;
  /** What the block says first: the button's name is "Read from: <label>". */
  label: string;
  /** The elements that show the block: one when rendered, its non-empty lines in Raw. */
  elements: HTMLElement[];
}

const SVG = "http://www.w3.org/2000/svg";

function playIcon(): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(SVG, "path");
  shape.setAttribute("d", "M8 5v14l11-7z");
  svg.append(shape);
  return svg;
}

/** Where `elements` are in the scroller's content, in CSS pixels from its top; null if not rendered. */
function extent(elements: HTMLElement[], scroller: HTMLElement): { top: number; bottom: number } | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of elements) {
    // A line of Raw is an inline span: its first box is where its text starts.
    const [first] = el.getClientRects();
    if (!first) {
      continue;
    }
    top = Math.min(top, first.top);
    bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
  }
  if (top === Infinity) {
    return null;
  }
  const origin = scroller.getBoundingClientRect().top + scroller.clientTop - scroller.scrollTop;
  return { top: top - origin, bottom: bottom - origin };
}

export class ReadGutter {
  private readonly el: HTMLElement;
  private blocks: GutterBlock[] = [];
  private buttons: HTMLButtonElement[] = [];
  /** The button that takes Tab. */
  private stop = 0;
  /** A button was focused since the gutter was shown: Tab goes back there. */
  private chosen = false;
  private readonly resize = new ResizeObserver(() => this.place());

  /** `label` names the column ("Read the translation aloud from"); `onPick` gets the line of a pressed button. */
  constructor(
    private readonly scroller: HTMLElement,
    label: string,
    private readonly onPick: (line: number) => void,
  ) {
    this.el = document.createElement("div");
    this.el.className = "read-gutter";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-orientation", "vertical");
    this.el.setAttribute("aria-label", label);
    this.el.hidden = true;
    scroller.prepend(this.el);
    this.el.addEventListener("keydown", (e) => this.key(e));
    this.el.addEventListener("focusin", (e) => {
      const i = this.buttons.indexOf(e.target as HTMLButtonElement);
      if (i !== -1) {
        this.chosen = true;
        this.setStop(i);
      }
    });
  }

  /** Shows a button per block, marking the block at line `current` (being read) when there is one. */
  show(blocks: GutterBlock[], current: number | null) {
    const same =
      blocks.length === this.blocks.length &&
      blocks.every((b, i) => b.line === this.blocks[i]!.line && b.label === this.blocks[i]!.label);
    this.blocks = blocks;
    if (!same) {
      this.build();
    }
    if (this.el.hidden) {
      this.el.hidden = false;
      this.scroller.classList.add("with-gutter");
      this.chosen = false;
    }
    // Any block that changes height moves the ones below it (a wider pane, text spacing, fonts).
    this.resize.disconnect();
    this.resize.observe(this.scroller);
    for (const block of blocks) {
      for (const el of block.elements) {
        this.resize.observe(el);
      }
    }
    this.buttons.forEach((b, i) => {
      if (blocks[i]!.line === current) {
        b.setAttribute("aria-current", "true");
      } else {
        b.removeAttribute("aria-current");
      }
    });
    // Tab goes to the block being read, unless the reader is choosing in the column.
    const reading = blocks.findIndex((b) => b.line === current);
    if (reading !== -1 && !this.el.contains(document.activeElement)) {
      this.setStop(reading);
    }
    this.place();
  }

  /** Hides the column. Returns whether focus was in it, so the caller can put it somewhere useful. */
  hide(): boolean {
    if (this.el.hidden) {
      return false;
    }
    const hadFocus = this.el.contains(document.activeElement);
    this.el.hidden = true;
    this.scroller.classList.remove("with-gutter");
    this.resize.disconnect();
    return hadFocus;
  }

  /** Moves focus into the column: to the block being read, the one last chosen, else the first in view. */
  focus() {
    const current = this.buttons.findIndex((b) => b.hasAttribute("aria-current"));
    if (current !== -1) {
      this.setStop(current);
    } else if (!this.chosen) {
      const top = this.scroller.scrollTop;
      const first = this.buttons.findIndex((b) => !b.hidden && b.offsetTop + b.offsetHeight > top);
      this.setStop(first);
    }
    this.buttons[this.stop]?.focus();
  }

  /** Puts every button at its block's height; a block that is not rendered hides its button. */
  place() {
    if (this.el.hidden) {
      return;
    }
    this.blocks.forEach((block, i) => {
      const button = this.buttons[i]!;
      const at = extent(block.elements, this.scroller);
      button.hidden = at === null;
      if (at) {
        button.style.insetBlockStart = `${at.top}px`;
        button.style.blockSize = `${at.bottom - at.top}px`;
      }
    });
  }

  private build() {
    const focused = this.el.contains(document.activeElement);
    this.buttons = this.blocks.map((block) => {
      const b = document.createElement("button");
      b.type = "button";
      // No `data-line`: that names the text's own elements, which sync scrolling looks for.
      b.className = "read-from";
      const name = `Read from: ${block.label}`;
      b.setAttribute("aria-label", name);
      b.title = name;
      b.append(playIcon());
      b.addEventListener("click", () => this.onPick(block.line));
      return b;
    });
    this.el.replaceChildren(...this.buttons);
    this.setStop(Math.min(this.stop, this.buttons.length - 1));
    if (focused) {
      this.buttons[this.stop]?.focus();
    }
  }

  private setStop(i: number) {
    this.stop = Math.max(i, 0);
    this.buttons.forEach((b, k) => {
      b.tabIndex = k === this.stop ? 0 : -1;
    });
  }

  private key(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey) {
      return;
    }
    const visible = this.buttons.flatMap((b, i) => (b.hidden ? [] : [i]));
    const at = visible.indexOf(this.stop);
    const moves: Record<string, () => number | undefined> = {
      ArrowDown: () => visible[at + 1],
      ArrowUp: () => visible[at - 1],
      Home: () => visible[0],
      End: () => visible.at(-1),
    };
    const to = moves[e.key];
    if (!to) {
      return;
    }
    // The keys are the column's own: they move focus and never scroll the pane by themselves.
    e.preventDefault();
    const i = to();
    if (i !== undefined) {
      this.setStop(i);
      this.buttons[i]!.focus();
    }
  }
}
