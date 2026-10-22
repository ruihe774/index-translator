import { afterEach, describe, expect, test } from "bun:test";

import {
  HISTORY_KEY,
  type HistoryEntry,
  loadHistory,
  MAX_ENTRIES,
  parseHistory,
  saveHistory,
  withBlocks,
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
    expect(parseHistory(null)).toStrictEqual([]);
    expect(parseHistory("{")).toStrictEqual([]);
    expect(parseHistory('{"a":1}')).toStrictEqual([]);
  });

  test("keeps entries and drops anything that is not one", () => {
    const raw = JSON.stringify([entry(1), { id: "x" }, null, entry(2)]);
    expect(parseHistory(raw).map((e) => e.id)).toStrictEqual(["id1", "id2"]);
  });
});

describe("blocks", () => {
  const groups = [{ source: [0], output: [0, 1] }];

  test("are kept with the entry, or dropped with it when damaged", () => {
    const raw = JSON.stringify([
      entry(1, { blocks: "same" }),
      entry(2, { blocks: groups }),
      entry(3, { blocks: "other" as never }),
      entry(4, { blocks: [{ source: ["a"], output: [] }] as never }),
      entry(5),
    ]);
    expect(parseHistory(raw).map((e) => e.id)).toStrictEqual(["id1", "id2", "id5"]);
  });

  test("withBlocks sets them on one entry only", () => {
    const list = withBlocks([entry(1), entry(2)], "id2", groups);
    expect(list[0]!.blocks).toBeUndefined();
    expect(list[1]!.blocks).toStrictEqual(groups);
  });
});

describe("withEntry", () => {
  test("puts the new entry first and caps the list", () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      list = withEntry(list, entry(i));
    }
    expect(list).toHaveLength(MAX_ENTRIES);
    expect(list[0]!.id).toBe(`id${MAX_ENTRIES + 4}`);
  });

  test("the same source, languages and model replaces the older entry", () => {
    const list = withEntry([entry(1), entry(2)], entry(3, { source: "source 1" }));
    expect(list.map((e) => e.id)).toStrictEqual(["id3", "id2"]);
  });

  test("a different target language is kept beside it", () => {
    const list = withEntry([entry(1)], entry(2, { source: "source 1", to: "ja" }));
    expect(list).toHaveLength(2);
  });
});

describe("storage", () => {
  const g = globalThis as { localStorage?: unknown };
  afterEach(() => delete g.localStorage);

  function fake(limit: number) {
    const data = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > limit) {
          throw new Error("QuotaExceededError");
        }
        data.set(k, v);
      },
    };
    return data;
  }

  test("saves and loads", () => {
    const data = fake(1e6);
    saveHistory([entry(1), entry(2)]);
    expect(data.has(HISTORY_KEY)).toBe(true);
    expect(loadHistory().map((e) => e.id)).toStrictEqual(["id1", "id2"]);
  });

  test("when the browser refuses, the oldest entries go until it accepts", () => {
    fake(JSON.stringify([entry(1), entry(2)]).length);
    const kept = saveHistory([entry(1), entry(2), entry(3)]);
    expect(kept.map((e) => e.id)).toStrictEqual(["id1", "id2"]);
    expect(loadHistory().map((e) => e.id)).toStrictEqual(["id1", "id2"]);
  });

  test("without storage nothing is kept and nothing throws", () => {
    expect(saveHistory([entry(1)])).toStrictEqual([]);
    expect(loadHistory()).toStrictEqual([]);
  });
});
