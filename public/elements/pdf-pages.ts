/* eslint-disable no-restricted-syntax */
// <pdf-pages>: the strip of page thumbnails beside the source box while a PDF is open.
//
// A light-DOM element that enhances the markup in index.html (an empty list) and fills the list
// with one button per page. It knows nothing about PDF libraries: the page hands it something
// that can draw a page into a canvas (`show`), and hears `page` (detail: the 1-based page number)
// when a thumbnail is clicked. Putting the PDF away is the page's business (`clear`).
//
// Thumbnails are drawn one at a time and only once they scroll near the strip's visible part, so
// a long document costs what is looked at. `disabled` is `aria-disabled` on every button (never
// `disabled`); `selected` marks the page whose text is in the box with `aria-current`, `busy`
// the one being extracted with `aria-busy`.

export interface PageSource {
  readonly pageCount: number;
  render(page: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>;
}

export class PdfPages extends HTMLElement {
  #source: PageSource | null = null;
  #observer: IntersectionObserver | null = null;
  #queue: HTMLCanvasElement[] = [];
  #drawing = false;
  #off = false;

  constructor() {
    super();
    this.addEventListener("click", (e) => {
      const button = (e.target as Element).closest("button");
      if (!button || !this.contains(button) || button.getAttribute("aria-disabled") === "true") {
        return;
      }
      this.dispatchEvent(new CustomEvent("page", { detail: Number(button.dataset.page) }));
    });
  }

  get #list(): HTMLElement {
    return this.querySelector("ol")!;
  }

  #pageButton(page: number | null): HTMLButtonElement | null {
    return page === null ? null : this.querySelector<HTMLButtonElement>(`button[data-page="${page}"]`);
  }

  /** Shows the strip with a button per page of `source`, in place of what it showed before. */
  show(source: PageSource) {
    this.clear();
    this.#source = source;
    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          this.#observer?.unobserve(entry.target);
          this.#queue.push(entry.target as HTMLCanvasElement);
        }
        void this.#draw();
      },
      { root: this.#list, rootMargin: "50%" },
    );
    const items: HTMLLIElement[] = [];
    for (let page = 1; page <= source.pageCount; page++) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.page = String(page);
      button.setAttribute("aria-label", `Page ${page}`);
      button.setAttribute("aria-disabled", String(this.#off));
      // A portrait sheet until the page is drawn, so the strip's length is about right from the start.
      const canvas = document.createElement("canvas");
      canvas.width = 3;
      canvas.height = 4;
      // The canvas gets a box of its own so the busy spinner sits on the picture, not the button.
      const picture = document.createElement("span");
      picture.className = "picture";
      picture.append(canvas);
      const number = document.createElement("span");
      number.textContent = String(page);
      button.append(picture, number);
      const li = document.createElement("li");
      li.append(button);
      items.push(li);
      this.#observer.observe(canvas);
    }
    this.#list.replaceChildren(...items);
    this.hidden = false;
    this.#list.scrollTop = 0;
  }

  /** Empties and hides the strip. */
  clear() {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#source = null;
    this.#queue = [];
    this.#list.replaceChildren();
    this.hidden = true;
  }

  async #draw() {
    if (this.#drawing) {
      return;
    }
    this.#drawing = true;
    try {
      for (let canvas = this.#queue.shift(); canvas; canvas = this.#queue.shift()) {
        const source = this.#source;
        if (!source || !canvas.isConnected) {
          continue;
        }
        const page = Number(canvas.closest("button")!.dataset.page);
        try {
          await source.render(page, canvas, canvas.clientWidth);
          canvas.dataset.drawn = "";
        } catch (e) {
          // A page that cannot be drawn keeps its blank sheet and can still be extracted.
          if (this.#source === source) {
            console.warn(`page ${page} was not drawn:`, e);
          }
        }
      }
    } finally {
      this.#drawing = false;
    }
  }

  get selected(): number | null {
    const page = this.querySelector<HTMLElement>('button[aria-current="true"]')?.dataset.page;
    return page === undefined ? null : Number(page);
  }

  set selected(page: number | null) {
    for (const b of this.querySelectorAll('button[aria-current="true"]')) {
      b.removeAttribute("aria-current");
    }
    const button = this.#pageButton(page);
    button?.setAttribute("aria-current", "true");
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // eslint-disable-next-line accessor-pairs -- no user for a getter for now
  set busy(page: number | null) {
    for (const b of this.querySelectorAll('button[aria-busy="true"]')) {
      b.removeAttribute("aria-busy");
    }
    this.#pageButton(page)?.setAttribute("aria-busy", "true");
  }

  get disabled(): boolean {
    return this.#off;
  }

  set disabled(disabled: boolean) {
    this.#off = disabled;
    const text = String(disabled);
    for (const b of this.getElementsByTagName("button")) {
      if (b.getAttribute("aria-disabled") !== text) {
        b.setAttribute("aria-disabled", text);
      }
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "pdf-pages": PdfPages;
  }
}
