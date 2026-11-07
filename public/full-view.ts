// Full view: one side's rendered text alone on the page, in a reading column under a bar with the
// Source text / Side by side / Translation switch and Exit. The page scrolls, not the pane, so a phone's
// browser bars collapse as on any page.
//
// Each panel's foot has the button that opens it, enabled while that side shows Preview. In full view
// the switch is shown at any width; going to a side shows it in Preview (the page's `preview`), and the
// side coming in is scrolled so that the counterpart of the block at the top of the other starts as far
// above or below the bar as that block did (as on the carousel, pane-carousel.ts), or to the same share
// of its length while the blocks are not matched.
//
// Side by side shows both in two columns, each block in the grid row of its counterpart (side-by-side.ts;
// the panes are subgrids of the workspace, css/full-view.css), keeping the block at the top where it was.
// Only where both columns fit (54rem, as outside full view), for matched blocks, and not for subtitles;
// when that stops being so, full view goes to the source. Moving between the three is a view transition
// where the browser has one: the blocks in view slide to their new places, those of a side coming in
// or going out slide from or to its end of the strip [source | translation].
// Entering and leaving (Exit and Escape; Back and a view that cannot be shown any more leave at once) zoom
// the pane: the area of the side moves between its place in the panel and the reading column, the old
// picture and the new fading into each other as it does.
// On a touch screen a sideways swipe does what the switch's next button that way does (swipe.ts): the finger
// moving left goes towards the translation, as the carousel's row would. It is told apart from a scroll on
// release, so the touches are only watched, never held: a swipe on a pinch-zoomed page pans it, one starting
// in a code block, table or equation that scrolls sideways scrolls it, and one from a side of the screen is
// the system's Back, which leaves.
// Exit, Escape and Back leave: entering pushes a history entry (the same URL), so Back on a phone
// does not leave the page. Leaving puts the page back where it was and the pane on the block that
// was at the top.
//
// Nothing else knows that the panes stopped scrolling but the stream followers in app.ts (`side`):
// reading aloud is stopped and the player paused on entering, and their gutters are hidden by CSS.

import { lineElements } from "./dom.ts";
import type { ViewSwitch } from "./elements/view-switch.ts";
import { prefersReducedMotion } from "./media-query.ts";
import type { PaneCarousel } from "./pane-carousel.ts";
import { type Alignment, counterpart } from "./paragraphs.ts";
import { shareText, shareTypeFor } from "./share.ts";
import { sideBySideRows } from "./side-by-side.ts";
import type { Side } from "./state.ts";
import { moveTrack, startTrack, swipeOf, type TouchTrack } from "./swipe.ts";
import { viewPane } from "./sync-scroll.ts";

export interface FullViewDeps {
  /** The button in each panel's foot that opens its full view. */
  open: Record<Side, HTMLButtonElement>;
  exit: HTMLButtonElement;
  /** Shares the text shown; hidden unless `share` says it can. */
  share: HTMLButtonElement;
  /** The bar the switch and Exit sit in; the text starts below it. */
  bar: HTMLElement;
  paneSwitch: ViewSwitch;
  carousel: PaneCarousel;
  /** Each side's rendered view and the scroller around it. */
  panes: Record<Side, { view: HTMLElement; area: HTMLElement }>;
  /** The grid both panels are in; side by side makes its rows the blocks'. */
  workspace: HTMLElement;
  /** Whether the side shows its Preview now, which opening its full view needs. */
  previewing(side: Side): boolean;
  /** Whether the side has a Preview to show, which going to it in full view needs. */
  showable(side: Side): boolean;
  /** Turns the side's view to Preview. */
  preview(side: Side): void;
  alignment(): Alignment | null;
  /** Whether the blocks are matched and are not subtitles' cues, which side by side needs. */
  sideBySide(): boolean;
  /** Called before the page changes: stops reading aloud and pauses the player. */
  entering(): void;
  /** The text of the side and whether it is Markdown, for the share button. */
  content(side: Side): { text: string; markdown: boolean };
}

/** What full view shows: one side, or both side by side. */
export type Shown = Side | "both";

export interface FullView {
  /** What full view shows, or null. */
  readonly side: Shown | null;
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

/** The part of an area on the screen: how far below the area's top it starts, its height, and the area's height. */
interface OnScreen {
  offset: number;
  height: number;
  whole: number;
}

const SIDES = ["source", "output"] as const;

const sidesOf = (shown: Shown): readonly Side[] => (shown === "both" ? SIDES : [shown]);

function setAttr(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

export function initFullView(d: FullViewDeps): FullView {
  const root = document.documentElement;
  const page = document.scrollingElement ?? root;
  /** Where both columns fit; css/full-view.css shows Side by side by the same query. */
  const wide = matchMedia("(min-width: 54rem)");
  let current: Shown | null = null;
  /** The side full view was opened on, which leaving side by side goes back to. */
  let entered: Side = "source";
  /** The page's scroll position before entering, put back on leaving. */
  let saved = 0;
  /** Our history entry is the current one. */
  let pushed = false;
  /** The `popstate` of our own `history.back()` is still to come. */
  let leaving = false;
  /** The alignment side by side's rows were set for. */
  let laidOut: Alignment | null = null;
  /**
   * The source's block at the top while side by side, kept as the page scrolls: when the page narrows, the
   * columns have reflowed before `wide` says so, and the block to keep is the one that was there before.
   */
  let sourceTop: Place | null = null;

  const barBottom = () => d.bar.getBoundingClientRect().bottom;
  const reach = () => page.scrollHeight - page.clientHeight;
  const bothShowable = () => wide.matches && d.sideBySide() && d.showable("source");
  const showable = (shown: Shown) => (shown === "both" ? bothShowable() : d.showable(shown));

  /** Scrolls the page so that `place` of `side` is below the bar as it was below its own top. */
  function scrollPageTo(side: Side, place: Place) {
    const { view, area } = d.panes[side];
    const top = viewPane(view, area).lineTop(place.line);
    if (top !== null) {
      page.scrollTop += top - barBottom() - place.offset;
    }
  }

  /**
   * Shows the share button when the browser can share text in some type, so it does not come and go with the view;
   * side by side has two texts and none to pick, so there it is disabled.
   */
  function showShare(shown: Shown) {
    d.share.hidden = shareTypeFor(d.content(shown === "both" ? "source" : shown).markdown) === null;
    setAttr(d.share, "aria-disabled", String(shown === "both"));
  }

  /** Marks the buttons of what cannot be shown now, as the switch sees them. */
  function markUnavailable() {
    for (const b of d.paneSwitch.querySelectorAll("button")) {
      setAttr(b, "aria-disabled", String(!showable(b.dataset.value as Shown)));
    }
  }

  /** Puts every block of both views in its grid row (side-by-side.ts). */
  function layOut() {
    const a = d.alignment();
    if (!a) {
      return;
    }
    const elements = { source: lineElements(d.panes.source.view), output: lineElements(d.panes.output.view) };
    const lines = (side: Side) => elements[side].map((el) => Number(el.dataset.line));
    const layout = sideBySideRows(a, { source: lines("source"), output: lines("output") });
    for (const side of SIDES) {
      elements[side].forEach((el, i) => {
        const { row, span } = layout[side][i]!;
        el.style.gridRow = `${row} / span ${span}`;
      });
    }
    d.workspace.style.setProperty("--rows", String(Math.max(layout.rows, 1)));
    laidOut = a;
  }

  function clearLayout() {
    for (const side of SIDES) {
      for (const el of lineElements(d.panes[side].view)) {
        el.style.removeProperty("grid-row");
      }
    }
    d.workspace.style.removeProperty("--rows");
    laidOut = null;
  }

  // A view rebuilt while side by side (the link check rebuilds the translation) gets its rows again.
  const rebuilt = new MutationObserver(() => {
    if (current === "both") {
      layOut();
    }
  });

  /** The blocks named for the view transition running. */
  const named = new Set<HTMLElement>();

  /** Names the blocks in view of what is shown, so that the transition moves each one by itself. */
  function nameBlocks() {
    for (const side of current ? sidesOf(current) : []) {
      for (const el of lineElements(d.panes[side].view)) {
        const box = el.getBoundingClientRect();
        if (box.top > innerHeight) {
          break;
        }
        if (box.bottom > 0 && !named.has(el)) {
          el.style.setProperty("view-transition-name", `full-${side}-${el.dataset.line}`);
          el.style.setProperty("view-transition-class", side);
          named.add(el);
        }
      }
    }
  }

  function unnameBlocks() {
    for (const el of named) {
      el.style.removeProperty("view-transition-name");
      el.style.removeProperty("view-transition-class");
    }
    named.clear();
  }

  /** The part of `area` on screen while in full view; null out of full view or when all of it is. */
  function onScreen(area: HTMLElement): OnScreen | null {
    if (!current) {
      return null;
    }
    const box = area.getBoundingClientRect();
    const top = Math.max(box.top, 0);
    const height = Math.min(box.bottom, innerHeight) - top;
    return height > 0 && (top > box.top || height < box.height)
      ? { offset: top - box.top, height, whole: box.height }
      : null;
  }

  /**
   * Moves the picture of full view up in the zoom's box (css/full-view.css) by where the part on screen starts:
   * as a share of the picture's own height, which holds at every width the box scales it to. Null: not moved.
   */
  function shiftZoom(part: OnScreen | null) {
    if (part) {
      root.style.setProperty("--zoom-shift", `${(-100 * part.offset) / part.whole}%`);
    } else {
      root.style.removeProperty("--zoom-shift");
    }
  }

  /**
   * Ends the zoom's box in full view at the part of the area on screen, not at the whole area: scrolled, the
   * area's top is far above the screen, and the box would sweep there in a moment like a fast scroll.
   */
  function fitZoom(end: "old" | "new", part: OnScreen) {
    const effect = document
      .getAnimations()
      .map((a) => a.effect as KeyframeEffect | null)
      .find((e) => e?.pseudoElement === "::view-transition-group(full-zoom)");
    const frames = effect?.getKeyframes();
    if (!effect || frames?.length !== 2) {
      return;
    }
    const full = end === "new" ? frames[1]! : frames[0]!;
    full.transform = `${full.transform} translateY(${part.offset}px)`;
    full.height = `${part.height}px`;
    effect.setKeyframes(frames);
  }

  /**
   * Runs `update` as a view transition where the browser has them and motion is welcome. Moving between the
   * views, the blocks in view each move by themselves; entering and leaving (`zoom`), the side's area does,
   * as one picture (css/full-view.css), so no block is named.
   */
  function transition(update: () => void, zoom?: { area: HTMLElement; direction: "in" | "out" }) {
    if (!("startViewTransition" in document) || prefersReducedMotion()) {
      update();
      return;
    }
    // Leaving, full view is the old picture, measured now; entering, the new one, measured after the change.
    let part: OnScreen | null = null;
    if (zoom) {
      zoom.area.style.setProperty("view-transition-name", "full-zoom");
      root.dataset.zoom = zoom.direction;
      part = zoom.direction === "out" ? onScreen(zoom.area) : null;
      shiftZoom(part);
    } else {
      nameBlocks();
    }
    const t = document.startViewTransition(() => {
      update();
      if (!zoom) {
        nameBlocks();
      } else if (zoom.direction === "in") {
        part = onScreen(zoom.area);
        shiftZoom(part);
      }
    });
    // A transition skipped (by the next one) rejects `ready`; the change itself is made all the same.
    t.ready
      .then(() => {
        if (zoom && part) {
          fitZoom(zoom.direction === "in" ? "new" : "old", part);
        }
      })
      .catch(() => {});
    const done = () => {
      unnameBlocks();
      if (zoom) {
        zoom.area.style.removeProperty("view-transition-name");
        // A later transition has set its own by now.
        if (root.dataset.zoom === zoom.direction && !document.querySelector("[style*='full-zoom']")) {
          delete root.dataset.zoom;
          shiftZoom(null);
        }
      }
    };
    void t.finished.finally(done).catch(() => {});
  }

  function enter(side: Side) {
    if (current || !d.previewing(side)) {
      return;
    }
    transition(() => change(side), { area: d.panes[side].area, direction: "in" });
  }

  function change(side: Side) {
    if (current || !d.previewing(side)) {
      return;
    }
    const { view, area } = d.panes[side];
    const place = area.scrollTop > 0 ? placeAt(view, area.getBoundingClientRect().top + area.clientTop) : null;
    d.entering();
    saved = page.scrollTop;
    current = side;
    entered = side;
    d.carousel.hold(true);
    root.dataset.fullView = side;
    d.paneSwitch.value = side;
    d.exit.hidden = false;
    showShare(side);
    markUnavailable();
    history.pushState({ fullView: true }, "");
    pushed = true;
    page.scrollTop = 0;
    if (place) {
      scrollPageTo(side, place);
    }
    d.exit.focus({ preventScroll: true });
  }

  /** Leaves with the zoom, or at once (`animate` false) where the page is leaving of itself. */
  function leave(animate = false) {
    if (!current) {
      return;
    }
    if (animate) {
      const { area } = d.panes[current === "both" ? entered : current];
      transition(() => drop(), { area, direction: "out" });
    } else {
      drop();
    }
  }

  function drop() {
    if (!current) {
      return;
    }
    const side = current === "both" ? entered : current;
    const { view, area } = d.panes[side];
    const place = page.scrollTop > 0 ? placeAt(view, barBottom()) : null;
    if (current === "both") {
      rebuilt.disconnect();
      clearLayout();
    }
    current = null;
    delete root.dataset.fullView;
    d.exit.hidden = true;
    d.share.hidden = true;
    d.share.removeAttribute("aria-disabled");
    d.paneSwitch.value = side;
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

  /**
   * Shows `to` in place of what is shown. A side that stays shown keeps the block at the top where it
   * was; a side coming in alone is scrolled so that the counterpart of the block at the top of the other
   * starts where that block did.
   */
  function show(to: Shown, kept?: Place | null) {
    const from = current!;
    if (to === from) {
      return;
    }
    const scrolled = page.scrollTop > 0;
    const share = reach() > 0 ? page.scrollTop / reach() : 0;
    let target: { side: Side; place: Place } | null = null;
    if (scrolled && (from === "both" || to === "both")) {
      const side = to === "both" ? (from as Side) : to;
      const place = kept === undefined ? placeAt(d.panes[side].view, barBottom()) : kept;
      target = place && { side, place };
    } else if (scrolled) {
      // As syncLine (sync-scroll.ts) on the carousel: the counterpart starts as far from the bar as the
      // own group does, so a block read halfway down stays read halfway down.
      const { view, area } = d.panes[from as Side];
      const place = placeAt(view, barBottom());
      const a = d.alignment();
      const match = place && a ? counterpart(a, from as Side, place.line) : null;
      const top = match && viewPane(view, area).lineTop(match.own.from);
      target =
        match && top !== null
          ? { side: to as Side, place: { line: match.other.from, offset: top - barBottom() } }
          : null;
    }
    // First: the render that `preview` runs must find what is shown showable, so it does not leave.
    current = to;
    root.dataset.fullView = to;
    d.paneSwitch.value = to;
    showShare(to);
    for (const side of sidesOf(to)) {
      if (!d.previewing(side)) {
        d.preview(side);
      }
    }
    if (to === "both") {
      layOut();
      for (const side of SIDES) {
        rebuilt.observe(d.panes[side].view, { childList: true });
      }
    } else if (from === "both") {
      rebuilt.disconnect();
      clearLayout();
    }
    page.scrollTop = 0;
    if (target) {
      scrollPageTo(target.side, target.place);
    } else {
      page.scrollTop = share * reach();
    }
    keepSourceTop();
  }

  function keepSourceTop() {
    // Once narrower (`matches` is current before its `change` comes), the columns have reflowed: keep the last.
    if (wide.matches) {
      sourceTop = current === "both" && page.scrollTop > 0 ? placeAt(d.panes.source.view, barBottom()) : null;
    }
  }

  /** Side by side cannot be shown any more (too narrow, or the blocks not matched): the source alone, else none. */
  function fallBack() {
    if (d.showable("source")) {
      show("source", sourceTop);
    } else {
      leave();
    }
  }

  /** The switch moved in full view. */
  function switchTo(to: Shown) {
    const from = current!;
    if (to === from) {
      return;
    }
    if (!showable(to)) {
      d.paneSwitch.value = from;
      return;
    }
    // Read when the transition runs it: an earlier one skipped by this click has made its change by then.
    transition(() => {
      if (current) {
        show(to);
      }
    });
  }

  /** The view next to the one shown in the switch's order (left to right) towards `by`, skipping what cannot be shown. */
  function next(by: 1 | -1): Shown | null {
    const order = [...d.paneSwitch.querySelectorAll("button")].map((b) => b.dataset.value as Shown);
    for (let i = order.indexOf(current!) + by; i >= 0 && i < order.length; i += by) {
      if (showable(order[i]!)) {
        return order[i]!;
      }
    }
    return null;
  }

  /** Whether `el` or a box around it scrolls sideways (a code block, a table, an equation). */
  function inSidewaysScroller(el: Element | null) {
    for (; el && el !== root; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) {
        return true;
      }
    }
    return false;
  }

  const zoomed = () => (visualViewport?.scale ?? 1) > 1.01;

  /** The one finger on the screen since it touched down in full view, while it may still be a swipe. */
  let finger: { id: number; track: TouchTrack } | null = null;
  document.addEventListener(
    "touchstart",
    (e) => {
      const [t] = e.touches;
      const free =
        current &&
        e.touches.length === 1 &&
        !zoomed() &&
        !document.querySelector("dialog[open]") &&
        !inSidewaysScroller(e.target as Element);
      finger = free && t ? { id: t.identifier, track: startTrack(t.clientX, t.clientY, e.timeStamp) } : null;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      const t = finger && e.touches.length === 1 ? e.touches[0] : undefined;
      if (finger && t?.identifier === finger.id) {
        moveTrack(finger.track, t.clientX, t.clientY, e.timeStamp);
      } else {
        finger = null;
      }
    },
    { passive: true },
  );
  document.addEventListener(
    "touchend",
    (e) => {
      const t = [...e.changedTouches].find((c) => c.identifier === finger?.id);
      const track = t && finger?.track;
      finger = null;
      if (!track || !current || zoomed()) {
        return;
      }
      moveTrack(track, t.clientX, t.clientY, e.timeStamp);
      const way = swipeOf(track, innerWidth);
      const to = way && next(way === "left" ? 1 : -1);
      if (to) {
        switchTo(to);
      }
    },
    { passive: true },
  );
  // The system took the touch (its back gesture) or the browser did.
  document.addEventListener(
    "touchcancel",
    () => {
      finger = null;
    },
    { passive: true },
  );

  for (const side of SIDES) {
    d.open[side].addEventListener("click", () => {
      if (d.open[side].getAttribute("aria-disabled") !== "true") {
        enter(side);
      }
    });
  }
  d.exit.addEventListener("click", () => leave(true));
  d.share.addEventListener("click", () => {
    if (!current || current === "both" || d.share.getAttribute("aria-disabled") === "true") {
      return;
    }
    const { text, markdown } = d.content(current);
    const type = shareTypeFor(markdown);
    if (type) {
      // A failed share (not a dismissed sheet) has nothing to say that the sheet has not shown.
      void shareText(text, type, current === "source" ? "source" : "translation").catch(() => {});
    }
  });
  // The carousel hears the change too and, held, does nothing.
  d.paneSwitch.addEventListener("change", () => {
    if (current) {
      switchTo(d.paneSwitch.value as Shown);
    }
  });
  let keeping = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (current === "both" && !keeping) {
        keeping = requestAnimationFrame(() => {
          keeping = 0;
          keepSourceTop();
        });
      }
    },
    { passive: true },
  );
  wide.addEventListener("change", () => {
    if (current === "both" && !wide.matches) {
      fallBack();
    }
  });
  document.addEventListener("keydown", (e) => {
    // A modal dialog (the link dialog) takes Escape for itself.
    if (current && e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]")) {
      leave(true);
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
      for (const side of SIDES) {
        setAttr(d.open[side], "aria-disabled", String(!d.previewing(side)));
      }
      if (current === "both" && !bothShowable()) {
        fallBack();
      } else if (current === "both" && laidOut !== d.alignment()) {
        layOut();
      }
      if (current && !showable(current)) {
        leave();
      } else if (current) {
        // Only the source can have no Preview (an image, no text), and only while the translation is shown:
        // the switch reads its first button as the whole switch's state, so this must not be the other way
        // round. Side by side, in the middle, is unavailable without matched blocks.
        markUnavailable();
      }
    },
  };
}
