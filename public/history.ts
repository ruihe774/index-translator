// Translation history: finished translations kept in this browser's local storage only. Nothing
// here is sent to the server, and the server has no endpoint for it.

import { alignBlocks, alignFromPairs, type Alignment, type BlockGroup } from "./paragraphs.ts";
import { KEYS, store, stored } from "./storage.ts";

export const HISTORY_KEY = KEYS.history;
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
  /**
   * How the translation's blocks match the source's, kept so that click-to-sync and sentence matching
   * work again when the entry is restored: `"same"` for block i ↔ i (recomputed from the texts), else the
   * groups `POST /align` found. Absent when the blocks were not matched. Checked against the texts on restore.
   */
  blocks?: "same" | BlockGroup[];
}

const isNumbers = (v: unknown) => Array.isArray(v) && v.every((n) => Number.isInteger(n));

function isBlocks(v: unknown): v is NonNullable<HistoryEntry["blocks"]> {
  return (
    v === "same" ||
    (Array.isArray(v) &&
      v.every((g: unknown) => {
        const group = g as Record<string, unknown> | null;
        return typeof group === "object" && group !== null && isNumbers(group.source) && isNumbers(group.output);
      }))
  );
}

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    typeof e.from === "string" &&
    typeof e.to === "string" &&
    typeof e.model === "string" &&
    typeof e.source === "string" &&
    typeof e.translation === "string" &&
    (e.blocks === undefined || isBlocks(e.blocks))
  );
}

/** What was stored, minus anything that is not an entry; damaged or foreign data gives an empty list. */
export function parseHistory(raw: string | null): HistoryEntry[] {
  if (!raw) {
    return [];
  }
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

/** The list with the blocks of entry `id` set, for a matching that arrived after the entry was kept. */
export function withBlocks(list: HistoryEntry[], id: string, blocks: BlockGroup[]): HistoryEntry[] {
  return list.map((e) => (e.id === id ? { ...e, blocks } : e));
}

/** The block matching kept with an entry, if it still fits both texts (damaged storage is ignored). */
export function restoredAlignment(entry: HistoryEntry): Alignment | null {
  const { blocks } = entry;
  if (blocks === "same") {
    return alignBlocks(entry.source, entry.translation);
  }
  return blocks
    ? alignFromPairs(
        entry.source,
        entry.translation,
        blocks.map((g) => ({ source: g.source, target: g.output })),
      )
    : null;
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
    if (kept.length === 0) {
      return kept;
    }
    kept = kept.slice(0, -1);
  }
  return kept;
}

let counter = 0;
export function newId(): string {
  return `${Date.now().toString(36)}-${(counter++).toString(36)}`;
}
