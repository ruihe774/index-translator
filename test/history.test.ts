import { afterEach, describe, expect, test } from "bun:test";
import {
  HISTORY_KEY,
  type HistoryEntry,
  loadHistory,
  MAX_ENTRIES,
  parseHistory,
  saveHistory,
  withEntry,
} from "../public/history";

function entry(n: number, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `id${n}`,
    at: n,
    from: "en",
    to: "zh",
    model: "index-translate-9b",
    source: `source ${n}`,
    translation: `translation ${n}`,
    ...over,
  };
}

describe("parseHistory", () => {
  test("empty, damaged and foreign data give an empty list", () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory("{")).toEqual([]);
    expect(parseHistory('{"a":1}')).toEqual([]);
  });

  test("keeps entries and drops anything that is not one", () => {
    const raw = JSON.stringify([entry(1), { id: "x" }, null, entry(2)]);
    expect(parseHistory(raw).map((e) => e.id)).toEqual(["id1", "id2"]);
  });
});

describe("withEntry", () => {
  test("puts the new entry first and caps the list", () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < MAX_ENTRIES + 5; i++) list = withEntry(list, entry(i));
    expect(list).toHaveLength(MAX_ENTRIES);
    expect(list[0]!.id).toBe(`id${MAX_ENTRIES + 4}`);
  });

  test("the same source, languages and model replaces the older entry", () => {
    const list = withEntry([entry(1), entry(2)], entry(3, { source: "source 1" }));
    expect(list.map((e) => e.id)).toEqual(["id3", "id2"]);
  });

  test("a different target language is kept beside it", () => {
    const list = withEntry([entry(1)], entry(2, { source: "source 1", to: "ja" }));
    expect(list).toHaveLength(2);
  });
});

describe("storage", () => {
  const g = globalThis as { localStorage?: unknown };
  afterEach(() => {
    delete g.localStorage;
  });

  function fake(limit: number) {
    const data = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > limit) throw new Error("QuotaExceededError");
        data.set(k, v);
      },
    };
    return data;
  }

  test("saves and loads", () => {
    const data = fake(1e6);
    saveHistory([entry(1), entry(2)]);
    expect(data.has(HISTORY_KEY)).toBe(true);
    expect(loadHistory().map((e) => e.id)).toEqual(["id1", "id2"]);
  });

  test("when the browser refuses, the oldest entries go until it accepts", () => {
    fake(JSON.stringify([entry(1), entry(2)]).length);
    const kept = saveHistory([entry(1), entry(2), entry(3)]);
    expect(kept.map((e) => e.id)).toEqual(["id1", "id2"]);
    expect(loadHistory().map((e) => e.id)).toEqual(["id1", "id2"]);
  });

  test("without storage nothing is kept and nothing throws", () => {
    expect(saveHistory([entry(1)])).toEqual([]);
    expect(loadHistory()).toEqual([]);
  });
});
