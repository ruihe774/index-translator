// Full view: one side's rendered text alone on the page, in a reading column under a bar with the
// Source / Translation switch and Exit. The page scrolls, not the pane, so a phone's browser bars
// collapse as on any page.
//
// Each panel's foot has the button that opens it, enabled while that side shows Preview. In full view
// the switch is shown at any width; going to a side shows it in Preview (the page's `preview`), and the
// side coming in is scrolled to the counterpart of the block at the top of the other (as on the
// carousel, pane-carousel.ts), or to the same share of its length while the blocks are not matched.
// Exit, Escape and Back leave: entering pushes a history entry (the same URL), so Back on a phone
// does not leave the page. Leaving puts the page back where it was and the pane on the block that
// was at the top.
//
// Nothing else knows that the panes stopped scrolling but the stream followers in app.ts (`side`):
// reading aloud is stopped and the player paused on entering, and their gutters are hidden by CSS.

import { lineElements } from "./dom.ts";
import type { ViewSwitch } from "./elements/view-switch.ts";
import type { PaneCarousel } from "./pane-carousel.ts";
import { type Alignment, counterpart } from "./paragraphs.ts";
import type { Side } from "./state.ts";
import { viewPane } from "./sync-scroll.ts";

export interface FullViewDeps {
  /** The button in each panel's foot that opens its full view. */
  open: Record<Side, HTMLButtonElement>;
  exit: HTMLButtonElement;
  /** The bar the switch and Exit sit in; the text starts below it. */
  bar: HTMLElement;
  paneSwitch: ViewSwitch;
  carousel: PaneCarousel;
  /** Each side's rendered view and the scroller around it. */
  panes: Record<Side, { view: HTMLElement; area: HTMLElement }>;
  /** Whether the side shows its Preview now, which opening its full view needs. */
  previewing(side: Side): boolean;
  /** Whether the side has a Preview to show, which going to it in full view needs. */
  showable(side: Side): boolean;
  /** Turns the side's view to Preview. */
  preview(side: Side): void;
  alignment(): Alignment | null;
  /** Called before the page changes: stops reading aloud and pauses the player. */
  entering(): void;
}

export interface FullView {
  /** The side shown in full view, or null. */
  readonly side: Side | null;
  /** Enables the open buttons, and leaves when the side shown has no Preview any more. Run on every render. */
  refresh(): void;
}

/** Where a view is scrolled to: the block at a height, and how far below that height its top is. */
interface Place {
  line: number;
  offset: number;
}

/** The block of `view` reaching below `top` (a viewport y) first, and where its top is from `top`. */
function placeAt(view: HTMLElement, top: number): Place | null {
  for (const el of lineElements(view)) {
    const box = el.getBoundingClientRect();
    if (box.bottom > top) {
      return { line: Number(el.dataset.line), offset: box.top - top };
    }
  }
  return null;
}

function setAttr(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

export function initFullView(d: FullViewDeps): FullView {
  const root = document.documentElement;
  const page = document.scrollingElement ?? root;
  let current: Side | null = null;
  /** The page's scroll position before entering, put back on leaving. */
  let saved = 0;
  /** Our history entry is the current one. */
  let pushed = false;
  /** The `popstate` of our own `history.back()` is still to come. */
  let leaving = false;

  const barBottom = () => d.bar.getBoundingClientRect().bottom;
  const reach = () => page.scrollHeight - page.clientHeight;

  /** Scrolls the page so that `place` of `side` is below the bar as it was below its own top. */
  function scrollPageTo(side: Side, place: Place) {
    const { view, area } = d.panes[side];
    const top = viewPane(view, area).lineTop(place.line);
    if (top !== null) {
      page.scrollTop += top - barBottom() - place.offset;
    }
  }

  function enter(side: Side) {
    if (current || !d.previewing(side)) {
      return;
    }
    const { view, area } = d.panes[side];
    const place = area.scrollTop > 0 ? placeAt(view, area.getBoundingClientRect().top + area.clientTop) : null;
    d.entering();
    saved = page.scrollTop;
    current = side;
    d.carousel.hold(true);
    root.dataset.fullView = side;
    d.paneSwitch.value = side;
    d.exit.hidden = false;
    history.pushState({ fullView: true }, "");
    pushed = true;
    page.scrollTop = 0;
    if (place) {
      scrollPageTo(side, place);
    }
    d.exit.focus({ preventScroll: true });
  }

  function leave() {
    if (!current) {
      return;
    }
    const side = current;
    const { view, area } = d.panes[side];
    const place = page.scrollTop > 0 ? placeAt(view, barBottom()) : null;
    current = null;
    delete root.dataset.fullView;
    d.exit.hidden = true;
    for (const b of d.paneSwitch.querySelectorAll("button")) {
      b.removeAttribute("aria-disabled");
    }
    d.carousel.hold(false);
    page.scrollTop = saved;
    d.carousel.show(side, true);
    area.scrollTop = 0;
    if (place) {
      const top = viewPane(view, area).lineTop(place.line);
      if (top !== null) {
        area.scrollTop += top - (area.getBoundingClientRect().top + area.clientTop) - place.offset;
      }
    }
    d.open[side].focus({ preventScroll: true });
    if (pushed) {
      pushed = false;
      leaving = true;
      history.back();
    }
  }

  /** The switch moved in full view: the other side comes in, at the counterpart of what this one showed. */
  function switchTo(to: Side) {
    const from = current!;
    if (to === from) {
      return;
    }
    if (!d.showable(to)) {
      d.paneSwitch.value = from;
      return;
    }
    const place = placeAt(d.panes[from].view, barBottom());
    const share = reach() > 0 ? page.scrollTop / reach() : 0;
    const a = d.alignment();
    const match = place && a && page.scrollTop > 0 ? counterpart(a, from, place.line) : null;
    // First: the render that `preview` runs must find the side shown showable, so it does not leave.
    current = to;
    root.dataset.fullView = to;
    if (!d.previewing(to)) {
      d.preview(to);
    }
    page.scrollTop = 0;
    if (match) {
      scrollPageTo(to, { line: match.other.from, offset: 0 });
    } else {
      page.scrollTop = share * reach();
    }
  }

  for (const side of ["source", "output"] as const) {
    d.open[side].addEventListener("click", () => {
      if (d.open[side].getAttribute("aria-disabled") !== "true") {
        enter(side);
      }
    });
  }
  d.exit.addEventListener("click", leave);
  // The carousel hears the change too and, held, does nothing.
  d.paneSwitch.addEventListener("change", () => {
    if (current) {
      switchTo(d.paneSwitch.value as Side);
    }
  });
  document.addEventListener("keydown", (e) => {
    // A modal dialog (the link dialog) takes Escape for itself.
    if (current && e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]")) {
      leave();
    }
  });
  window.addEventListener("popstate", () => {
    if (leaving) {
      leaving = false;
    } else if (current) {
      pushed = false;
      leave();
    }
  });

  return {
    get side() {
      return current;
    },
    refresh() {
      for (const side of ["source", "output"] as const) {
        setAttr(d.open[side], "aria-disabled", String(!d.previewing(side)));
      }
      if (current && !d.showable(current)) {
        leave();
      } else if (current) {
        // Only the source can have no Preview (an image, no text), and only while the translation is shown:
        // the switch reads its first button as the whole switch's state, so this must not be the other way round.
        for (const b of d.paneSwitch.querySelectorAll("button")) {
          setAttr(b, "aria-disabled", String(!d.showable(b.dataset.value as Side)));
        }
      }
    },
  };
}
