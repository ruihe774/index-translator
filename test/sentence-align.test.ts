import { describe, expect, test } from "bun:test";

import { BACKOFF_MS } from "../public/segment";
import { pairOf, SentenceAligner } from "../public/sentence-align";
import type { AlignedPair } from "../src/api";

const ONE: AlignedPair[] = [{ source: [0], target: [0], similarity: 0.9 }];

/** A server whose answers the test releases one by one. */
function server() {
  const calls: {
    source: string[];
    target: string[];
    signal: AbortSignal;
    answer: (p: AlignedPair[]) => void;
    fail: () => void;
  }[] = [];
  const post = (source: string[], target: string[], signal: AbortSignal) =>
    new Promise<AlignedPair[]>((resolve, reject) => {
      calls.push({ source, target, signal, answer: resolve, fail: () => reject(new Error("502")) });
    });
  return { calls, post };
}

const flush = () => Bun.sleep(0);

function ready(post: ReturnType<typeof server>["post"], now = () => 0) {
  const aligner = new SentenceAligner(post, now);
  aligner.configure({ status: "stopped", max_chars: 100 });
  return aligner;
}

describe("SentenceAligner", () => {
  test("asks once, keeps the answer, and calls back", async () => {
    const s = server();
    const aligner = ready(s.post);
    let done = 0;
    aligner.request(["A."], ["B."], () => void done++);
    aligner.request(["A."], ["B."], () => void done++);
    expect(s.calls).toHaveLength(1);
    s.calls[0]!.answer(ONE);
    await flush();
    expect(done).toBe(1);
    expect(aligner.get(["A."], ["B."])).toStrictEqual(ONE);
    aligner.request(["A."], ["B."], () => void done++);
    expect(s.calls).toHaveLength(1);
  });

  test("one request at a time; only the latest waiting one is sent next", async () => {
    const s = server();
    const aligner = ready(s.post);
    aligner.request(["1"], ["1"], () => {});
    aligner.request(["2"], ["2"], () => {});
    aligner.request(["3"], ["3"], () => {});
    expect(s.calls.map((c) => c.source)).toStrictEqual([["1"]]);
    s.calls[0]!.answer(ONE);
    await flush();
    expect(s.calls.map((c) => c.source)).toStrictEqual([["1"], ["3"]]);
  });

  test("unavailable, too large, or an empty side: nothing is asked", () => {
    const s = server();
    const off = new SentenceAligner(s.post);
    off.configure({ status: "unavailable", max_chars: 100 });
    off.request(["A."], ["B."], () => {});
    const aligner = ready(s.post);
    aligner.request(["a".repeat(60)], ["b".repeat(41)], () => {});
    aligner.request([], ["B."], () => {});
    expect(s.calls).toHaveLength(0);
  });

  test("a failure stops asking for a while", async () => {
    const s = server();
    let now = 0;
    const aligner = ready(s.post, () => now);
    aligner.request(["A."], ["B."], () => {});
    s.calls[0]!.fail();
    await flush();
    aligner.request(["C."], ["D."], () => {});
    expect(s.calls).toHaveLength(1);
    now = BACKOFF_MS;
    aligner.request(["C."], ["D."], () => {});
    expect(s.calls).toHaveLength(2);
  });

  test("abort stops what is in flight and drops its answer", async () => {
    const s = server();
    const aligner = ready(s.post);
    let done = 0;
    aligner.request(["A."], ["B."], () => void done++);
    aligner.abort();
    expect(s.calls[0]!.signal.aborted).toBe(true);
    s.calls[0]!.answer(ONE);
    await flush();
    expect(done).toBe(0);
    expect(aligner.get(["A."], ["B."])).toBeUndefined();
  });

  test("pairOf finds the pair that holds a sentence of either side", () => {
    const pairs: AlignedPair[] = [
      { source: [0], target: [0, 1], similarity: 0.9 },
      { source: [1, 2], target: [2], similarity: 0.8 },
    ];
    expect(pairOf(pairs, "target", 1)).toBe(pairs[0]);
    expect(pairOf(pairs, "source", 2)).toBe(pairs[1]);
    expect(pairOf(pairs, "source", 3)).toBeUndefined();
  });
});
