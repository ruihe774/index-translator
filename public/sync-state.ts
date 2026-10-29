// What a finished translation's matched blocks allow: click-to-sync scrolling, the hovered block's
// counterpart and the link check by block. The state is for one source and one translation; it is
// dropped when either changes (`active` compares both texts).
//
// Asked when a finished translation does not have as many blocks as its source: which blocks match
// which (`POST /align`). The answer, for that source and translation, turns on what matched blocks
// allow and replaces the paragraph note with the places the translation went wrong. Without an answer
// the note stays as it was. Only asked where the matching was measured to be reliable (`matchable`):
// a wrong place is worse than none.

import { type LinkReference, linkReference } from "./links.ts";
import { checkLinks } from "./markdown-dom.ts";
import {
  alignFromPairs,
  type Alignment,
  type BlockGroup,
  blockTexts,
  counterpart,
  detailedMismatchMessage,
  matchable,
  paragraphMismatch,
  unitOf,
} from "./paragraphs.ts";
import { MAX_TEXTS } from "./segment.ts";
import { postAlign, type SentenceAligner } from "./sentence-align.ts";
import { type Side, state } from "./state.ts";
import { clearLinked, hoveredLine, markLinked, type Pane, syncFrom, textareaPane, viewPane } from "./sync-scroll.ts";

export interface SyncStateDeps {
  textInput: HTMLTextAreaElement;
  sourceArea: HTMLElement;
  sourceView: HTMLElement;
  outputArea: HTMLElement;
  outputEl: HTMLElement;
  aligner: SentenceAligner;
  /** The block matching a kept history entry turned out to be these groups. */
  keepBlocks(entryId: string, groups: BlockGroup[]): void;
  /** Checked links are changed in place, so the output is rebuilt before they are checked again. */
  rebuildOutput(): void;
}

export interface SyncState {
  /** The blocks' matching for the source and translation as they are now, else null. */
  active(): Alignment | null;
  /** Marks the panes as synced (or not) for `active`. */
  refresh(): void;
  /** Checks the output's links against the source, when the check was set for this translation. */
  applyLinkCheck(): void;
  /** Sets the matching of a source and its translation. */
  set(source: string, translation: string, alignment: Alignment): void;
  /** After a Markdown translation: its links are checked against `ref`. */
  setLinkCheck(translation: string, ref: LinkReference): void;
  /** Asks the server which blocks match, when that is reliable; see the head of this file. */
  match(source: string, translation: string, note: HTMLLIElement | undefined, entryId: string): Promise<void>;
  /** Drops the matching, the link check and any question still waiting. */
  reset(): void;
}

export function initSyncState(d: SyncStateDeps): SyncState {
  const { textInput, sourceArea, sourceView, outputArea, outputEl, aligner } = d;
  /** Set after a finished translation whose blocks match the source's, for that source and output. */
  let synced: { source: string; translation: string; alignment: Alignment } | null = null;
  /** Set when a translation ends: what the output's links are checked against. */
  let linkCheck: { translation: string; ref: LinkReference } | null = null;
  let pending = new AbortController();

  function active(): Alignment | null {
    return synced?.source === textInput.value && synced.translation === state.translation ? synced.alignment : null;
  }

  function refresh() {
    const on = active() !== null;
    for (const el of [textInput, sourceArea, outputArea]) {
      el.classList.toggle("synced", on);
    }
  }

  function applyLinkCheck() {
    if (linkCheck?.translation === state.translation && outputEl.classList.contains("markdown")) {
      checkLinks(outputEl, linkCheck.ref);
    }
  }

  function sourcePane(): Pane {
    return textInput.hidden ? viewPane(sourceView, sourceArea) : textareaPane(textInput);
  }

  function onSourceClick(e: MouseEvent) {
    const a = active();
    if (a) {
      syncFrom(e, sourcePane(), viewPane(outputEl, outputArea), a, "source");
    }
  }

  function onOutputClick(e: MouseEvent) {
    const a = active();
    if (a) {
      syncFrom(e, viewPane(outputEl, outputArea), sourcePane(), a, "output");
    }
  }

  /** Hovering a block of one rendered pane shades the blocks it maps to in the other rendered pane. */
  function onHover(e: MouseEvent, fromView: HTMLElement, toView: HTMLElement, side: Side) {
    const a = active();
    const line = a ? hoveredLine(e, fromView) : null;
    const match = a && line !== null ? counterpart(a, side, line) : null;
    if (match) {
      markLinked(toView, match.other);
    } else {
      clearLinked(toView);
    }
  }

  textInput.addEventListener("click", onSourceClick);
  sourceArea.addEventListener("click", onSourceClick);
  outputArea.addEventListener("click", onOutputClick);
  sourceArea.addEventListener("mouseover", (e) => onHover(e, sourceView, outputEl, "source"));
  outputArea.addEventListener("mouseover", (e) => onHover(e, outputEl, sourceView, "output"));
  sourceArea.addEventListener("mouseleave", () => clearLinked(outputEl));
  outputArea.addEventListener("mouseleave", () => clearLinked(sourceView));

  async function match(source: string, translation: string, note: HTMLLIElement | undefined, entryId: string) {
    const unit = unitOf(source);
    const sourceBlocks = blockTexts(source, unit);
    const outputBlocks = blockTexts(translation, unit);
    if (
      !aligner.available ||
      !matchable(sourceBlocks) ||
      [sourceBlocks, outputBlocks].some((blocks) => blocks.length === 0 || blocks.length > MAX_TEXTS)
    ) {
      return;
    }
    const { signal } = pending;
    let alignment: Alignment | null;
    try {
      alignment = alignFromPairs(
        source,
        translation,
        await postAlign(sourceBlocks, outputBlocks, signal, "paragraphs"),
      );
    } catch {
      // No answer (the engine is off, busy or failed): the plain paragraph note stays.
      return;
    }
    if (!alignment || signal.aborted) {
      return;
    }
    synced = { source, translation, alignment };
    refresh();
    // The entry was kept when the translation finished, before this answer came.
    d.keepBlocks(entryId, alignment.groups);
    const mismatch = paragraphMismatch(source, translation);
    if (note && mismatch) {
      note.textContent = detailedMismatchMessage(mismatch, alignment);
    }
    if (linkCheck?.translation === translation) {
      linkCheck = { translation, ref: linkReference(source, alignment) };
      if (outputEl.querySelector("[data-link-problem], [data-link-paired]")) {
        d.rebuildOutput();
      }
    }
  }

  return {
    active,
    refresh,
    applyLinkCheck,
    set(source, translation, alignment) {
      synced = { source, translation, alignment };
    },
    setLinkCheck(translation, ref) {
      linkCheck = { translation, ref };
    },
    match,
    reset() {
      synced = null;
      linkCheck = null;
      pending.abort();
      pending = new AbortController();
    },
  };
}
