// One column: the source and translation panels side by side in a row that scrolls sideways, one
// panel to a screen (`css/pane-carousel.css`); two columns show both and this does nothing.
//
// The switch under the row ("Source" / "Translation") is the way there without a swipe (WCAG 2.5.1)
// and says which panel the row rests on. A panel coming in is scrolled to its counterpart of what the
// other one showed as soon as the row starts to move, not when it rests, so it does not jump in view.
// Tabbing into the other panel scrolls the row there by itself.

import type { ViewSwitch } from "./elements/view-switch.ts";
import { prefersReducedMotion } from "./media-query.ts";
import type { Side } from "./state.ts";

export interface PaneCarousel {
  /** Brings the panel of `side` into view, where the panels do not fit side by side. */
  show(side: Side): void;
}

const other = (side: Side): Side => (side === "source" ? "output" : "source");

/**
 * `row` scrolls between the two panels; `paneSwitch` holds a button for each side. `arriving` is called
 * with the side about to come into view, once each time the row starts to move.
 */
export function initPaneCarousel(
  row: HTMLElement,
  paneSwitch: ViewSwitch,
  arriving: (side: Side) => void,
): PaneCarousel {
  let resting: Side = "source";
  let moving = false;

  /** How far the row scrolls; 0 when both panels fit. */
  const reach = () => row.scrollWidth - row.clientWidth;

  /** The side the row rests on, or null between the two. */
  function restingSide(): Side | null {
    if (row.scrollLeft <= 1) {
      return "source";
    }
    return row.scrollLeft >= reach() - 1 ? "output" : null;
  }

  row.addEventListener(
    "scroll",
    () => {
      const side = restingSide();
      if (side) {
        moving = false;
        resting = side;
        paneSwitch.value = side;
      } else if (!moving) {
        moving = true;
        arriving(other(resting));
      }
    },
    { passive: true },
  );

  function show(side: Side) {
    if (reach() > 1) {
      row.scrollTo({ left: side === "source" ? 0 : reach(), behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
  }

  // The click has already moved the pressed button; the row follows and confirms it on arrival.
  paneSwitch.addEventListener("change", () => show(paneSwitch.value as Side));

  return { show };
}
