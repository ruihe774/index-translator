// The History panel: one list item per kept translation, built with the DOM API. The page supplies
// what to do with an entry (app.ts) and the names of the languages; this file only draws the list.

import type { HistoryEntry } from "./history.ts";
import { modelLabel } from "./messages.ts";

export interface HistoryUiDeps {
  list: HTMLElement;
  empty: HTMLElement;
  count: HTMLElement;
  clear: HTMLElement;
  /** Language name for a code (or `auto`). */
  languageName: (code: string) => string;
  restore: (entry: HistoryEntry) => void;
  remove: (entry: HistoryEntry) => void;
  clearAll: () => void;
}

export interface HistoryUi {
  show(entries: HistoryEntry[]): void;
  /** Restoring replaces what is on screen, so it waits for a running translation. */
  setBusy(busy: boolean): void;
}

const SNIPPET = 120;

function snippet(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- splitting by code point is the point here
  return flat.length > SNIPPET ? `${[...flat].slice(0, SNIPPET).join("")}…` : flat;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function initHistoryUi(d: HistoryUiDeps): HistoryUi {
  let busy = false;

  const setBusyAttr = (b: HTMLElement) => b.setAttribute("aria-disabled", String(busy));

  function item(e: HistoryEntry): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "history-item";

    const head = document.createElement("p");
    head.className = "history-meta hint";
    const time = document.createElement("time");
    time.dateTime = new Date(e.at).toISOString();
    time.textContent = dateTime.format(e.at);
    head.append(time, ` · ${d.languageName(e.from)} → ${d.languageName(e.to)} · ${modelLabel(e.model)}`);

    const text = document.createElement("p");
    text.className = "history-text";
    text.dir = "auto";
    text.textContent = snippet(e.source);
    // The language of a stored text is only known when it was chosen; a guess is left to the browser.
    if (e.from !== "auto") {
      text.lang = e.from;
    }

    const label = `from ${dateTime.format(e.at)}, ${snippet(e.source).slice(0, 40)}`;
    const actions = document.createElement("div");
    actions.className = "history-actions";
    // Links, not buttons: they act on the page without a navigation, so the href is only a fallback
    // target (the list) and every click is cancelled.
    const restore = document.createElement("a");
    restore.href = "#history-list";
    restore.textContent = "Restore";
    restore.setAttribute("aria-label", `Restore translation ${label}`);
    setBusyAttr(restore);
    restore.dataset.restore = "";
    restore.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (restore.getAttribute("aria-disabled") !== "true") {
        d.restore(e);
      }
    });
    const del = document.createElement("a");
    del.href = "#history-list";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete translation ${label} from the history`);
    del.dataset.delete = "";
    del.addEventListener("click", (ev) => {
      ev.preventDefault();
      d.remove(e);
    });
    actions.append(restore, del);

    li.append(head, text, actions);
    return li;
  }

  d.clear.addEventListener("click", () => {
    if (d.clear.getAttribute("aria-disabled") !== "true") {
      d.clearAll();
    }
  });

  return {
    show(entries) {
      d.list.replaceChildren(...entries.map(item));
      d.empty.hidden = entries.length > 0;
      d.list.hidden = entries.length === 0;
      d.count.textContent = entries.length === 0 ? "" : `${entries.length} kept in this browser`;
      d.clear.setAttribute("aria-disabled", String(entries.length === 0));
    },
    setBusy(b) {
      busy = b;
      for (const r of d.list.querySelectorAll<HTMLElement>("[data-restore]")) {
        setBusyAttr(r);
      }
    },
  };
}
