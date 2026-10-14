// Translation history: finished translations kept in this browser's local storage only. Nothing
// here is sent to the server, and the server has no endpoint for it.

import { store, stored } from "./storage.ts";

export const HISTORY_KEY = "history";
/** Newest first; the oldest entry goes when a new one would be the 51st. */
export const MAX_ENTRIES = 50;

export interface HistoryEntry {
  id: string;
  /** Milliseconds since the epoch, when the translation finished. */
  at: number;
  /** The From selection as chosen (`auto` or a code), restored with the text. */
  from: string;
  to: string;
  /** The model that did the translation. */
  model: string;
  source: string;
  translation: string;
}

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    typeof e.from === "string" &&
    typeof e.to === "string" &&
    typeof e.model === "string" &&
    typeof e.source === "string" &&
    typeof e.translation === "string"
  );
}

/** What was stored, minus anything that is not an entry; damaged or foreign data gives an empty list. */
export function parseHistory(raw: string | null): HistoryEntry[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? data.filter(isEntry).slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

/** The list with `entry` first. The same source, languages and model as an older entry replaces it. */
export function withEntry(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const same = (e: HistoryEntry) =>
    e.source === entry.source && e.from === entry.from && e.to === entry.to && e.model === entry.model;
  return [entry, ...list.filter((e) => !same(e))].slice(0, MAX_ENTRIES);
}

export function loadHistory(): HistoryEntry[] {
  return parseHistory(stored(HISTORY_KEY));
}

/**
 * Writes the list. Storage holds a few megabytes and entries can be long, so when the browser
 * refuses, the oldest entries are dropped until it accepts. Returns what was kept.
 */
export function saveHistory(list: HistoryEntry[]): HistoryEntry[] {
  let kept = list;
  while (!store(HISTORY_KEY, JSON.stringify(kept))) {
    if (kept.length === 0) return kept;
    kept = kept.slice(0, -1);
  }
  return kept;
}

let counter = 0;
export function newId(): string {
  return `${Date.now().toString(36)}-${(counter++).toString(36)}`;
}
