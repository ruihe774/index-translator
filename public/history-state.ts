// The kept translations of this page and the controls around the list: what is added, deleted and
// paused. history.ts is the data, history-ui.ts draws the list; this ties them to local storage.
// Nothing goes to the server.

import { type HistoryUiDeps, initHistoryUi } from "./history-ui.ts";
import { type HistoryEntry, loadHistory, saveHistory, withBlocks, withEntry } from "./history.ts";
import type { BlockGroup } from "./paragraphs.ts";
import { KEYS, store, stored } from "./storage.ts";

export interface HistoryDeps extends Pick<HistoryUiDeps, "list" | "empty" | "count" | "clear" | "languageName"> {
  /** The button that pauses and resumes keeping entries. */
  pause: HTMLElement;
  /** Puts an entry back on the page. */
  restore: (entry: HistoryEntry) => void;
}

export interface History {
  /** Draws the list again, as when the language names have arrived. */
  show(): void;
  /** Keeps a finished translation, unless the history is paused. */
  add(entry: HistoryEntry): void;
  /** The block matching `POST /align` found for an entry kept earlier. */
  setBlocks(id: string, groups: BlockGroup[]): void;
  /** Restoring replaces what is on screen, so it waits for a running translation. */
  setBusy(busy: boolean): void;
}

export function initHistory(d: HistoryDeps): History {
  let entries = loadHistory();
  // Pausing only stops new entries; the kept ones stay and can be restored or deleted.
  let paused = stored(KEYS.historyPaused) === "1";

  /** Saves the list; a browser that refuses all storage still keeps it until the page is closed. */
  function set(list: HistoryEntry[]) {
    const kept = saveHistory(list);
    entries = kept.length === 0 && list.length > 0 ? list : kept;
    ui.show(entries);
  }

  const ui = initHistoryUi({
    list: d.list,
    empty: d.empty,
    count: d.count,
    clear: d.clear,
    languageName: d.languageName,
    restore: d.restore,
    remove: (entry) => {
      set(entries.filter((e) => e.id !== entry.id));
      const next = d.list.querySelector<HTMLElement>("[data-delete]");
      (next ?? d.clear).focus();
    },
    clearAll: () => {
      set([]);
      d.clear.focus();
    },
  });

  function showPaused() {
    d.pause.textContent = paused ? "Resume" : "Pause";
    d.pause.setAttribute("aria-label", paused ? "Resume history" : "Pause history");
    d.empty.textContent = paused
      ? "History is paused: finished translations are not being kept."
      : "Finished translations appear here. They are kept in this browser only and never sent to the server.";
  }
  d.pause.addEventListener("click", () => {
    paused = !paused;
    store(KEYS.historyPaused, paused ? "1" : "0");
    showPaused();
  });
  showPaused();

  return {
    show: () => ui.show(entries),
    add(entry) {
      if (!paused) {
        set(withEntry(entries, entry));
      }
    },
    setBlocks: (id, groups) => set(withBlocks(entries, id, groups)),
    setBusy: (busy) => ui.setBusy(busy),
  };
}
