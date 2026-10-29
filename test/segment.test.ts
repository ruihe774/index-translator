import { describe, expect, test } from "bun:test";

import { BACKOFF_MS, MAX_TEXTS, SentenceBoundaries } from "../public/segment";
import { flush } from "./helpers/harness";

interface Call {
  texts: string[];
  signal: AbortSignal;
  answer(): void;
  fail(e?: Error): void;
}

/** A client whose requests the test answers by hand; each answer has one offset, the text's length minus one. */
function setup(maxChars = 100) {
  const calls: Call[] = [];
  let clock = 0;
  const post = (texts: string[], signal: AbortSignal) =>
    new Promise<{ offsets: number[]; probabilities: number[] }[]>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      calls.push({
        texts,
        signal,
        answer: () => resolve(texts.map((t) => ({ offsets: [t.length - 1], probabilities: [0.9] }))),
        fail: (e: Error = new Error("boom")) => reject(e),
      });
    });
  const client = new SentenceBoundaries(post, () => clock);
  client.configure({ status: "ready", max_chars: maxChars });
  return { client, calls, flush, tick: (ms: number) => void (clock += ms) };
}

describe("SentenceBoundaries", () => {
  test("asks nothing unless the server has the model", () => {
    const { client, calls } = setup();
    client.configure({ status: "unavailable", max_chars: 100 });
    client.request(["hello"]);
    client.configure(undefined);
    client.request(["hello"]);
    expect(calls).toHaveLength(0);
    expect(client.available).toBe(false);
    expect(client.allSettled(["hello"])).toBe(true);
  });

  test("batches within max_chars, one request at a time, in order", async () => {
    const { client, calls, flush } = setup(100);
    const texts = ["a".repeat(60), "b".repeat(30), "c".repeat(50), "d".repeat(100), "e".repeat(101)];
    client.request(texts);
    await flush();
    expect(calls.map((c) => c.texts.map((t) => t[0]))).toStrictEqual([["a", "b"]]);
    calls[0]!.answer();
    await flush();
    expect(calls.map((c) => c.texts.map((t) => t[0]))).toStrictEqual([["a", "b"], ["c"]]);
    calls[1]!.answer();
    await flush();
    calls[2]!.answer();
    await flush();
    // The 101 characters are more than a request holds: never asked for, and nothing waits for it.
    expect(calls).toHaveLength(3);
    expect(client.allSettled(texts)).toBe(true);
    expect(client.get(texts[3]!)).toStrictEqual({ offsets: [99], probabilities: [0.9] });
    expect(client.get(texts[4]!)).toBeUndefined();
  });

  test("at most 256 texts in a request", async () => {
    const { client, calls, flush } = setup(1_000_000);
    client.request(Array.from({ length: MAX_TEXTS + 3 }, (_, i) => `t${i}`));
    await flush();
    expect(calls[0]!.texts).toHaveLength(MAX_TEXTS);
    calls[0]!.answer();
    await flush();
    expect(calls[1]!.texts).toStrictEqual(["t256", "t257", "t258"]);
  });

  test("an answer is kept: the text is not asked for again", async () => {
    const { client, calls, flush } = setup();
    client.request(["hello"]);
    client.request(["hello"]);
    await flush();
    expect(calls).toHaveLength(1);
    calls[0]!.answer();
    await flush();
    client.request(["hello", "hello"]);
    await flush();
    expect(calls).toHaveLength(1);
    expect(client.get("hello")?.offsets).toStrictEqual([4]);
  });

  test("a text asked for first goes before those waiting, not before the one in flight", async () => {
    const { client, calls, flush } = setup(10);
    client.request(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]);
    await flush();
    client.request(["cccccccccc"], true);
    await flush();
    calls[0]!.answer();
    await flush();
    expect(calls.map((c) => c.texts[0])).toStrictEqual(["aaaaaaaaaa", "cccccccccc"]);
  });

  test("ready waits for the texts, and gives up after the time", async () => {
    const { client, calls, flush } = setup();
    client.request(["hello"]);
    await flush();
    let done = false;
    const waiting = client.ready(["hello"], 10_000).then(() => void (done = true));
    await flush();
    expect(done).toBe(false);
    calls[0]!.answer();
    await waiting;
    expect(done).toBe(true);
    // Never answered: back after the time, with nothing.
    client.request(["slow"]);
    await flush();
    const started = Date.now();
    await client.ready(["slow"], 30);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(client.get("slow")).toBeUndefined();
  });

  test("a failure settles everything waiting, and nothing is asked for a while", async () => {
    const { client, calls, flush, tick } = setup(10);
    client.request(["aaaaaaaaaa", "bbbbbbbbbb"]);
    await flush();
    const waiting = client.ready(["aaaaaaaaaa", "bbbbbbbbbb"], 10_000);
    calls[0]!.fail();
    await waiting;
    expect(client.allSettled(["aaaaaaaaaa", "bbbbbbbbbb"])).toBe(true);
    expect(client.get("aaaaaaaaaa")).toBeUndefined();
    client.request(["cccccccccc"]);
    await flush();
    expect(calls).toHaveLength(1);
    tick(BACKOFF_MS);
    client.request(["cccccccccc"]);
    await flush();
    expect(calls).toHaveLength(2);
  });

  test("an answer that does not fit the request is a failure", async () => {
    const { flush } = setup();
    const odd = new SentenceBoundaries(
      () => Promise.resolve([]),
      () => 0,
    );
    odd.configure({ status: "ready", max_chars: 100 });
    odd.request(["hello"]);
    await flush();
    expect(odd.get("hello")).toBeUndefined();
    expect(odd.allSettled(["hello"])).toBe(true);
  });

  test("abort stops the request in flight, drops the rest and lets later requests through", async () => {
    const { client, calls, flush } = setup(10);
    client.request(["aaaaaaaaaa", "bbbbbbbbbb"]);
    await flush();
    const waiting = client.ready(["aaaaaaaaaa", "bbbbbbbbbb"], 10_000);
    client.abort();
    await waiting;
    expect(calls[0]!.signal.aborted).toBe(true);
    await flush();
    expect(calls).toHaveLength(1);
    // Not a failure: no wait before asking again.
    client.request(["bbbbbbbbbb"]);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.signal.aborted).toBe(false);
    calls[1]!.answer();
    await flush();
    expect(client.get("bbbbbbbbbb")).toBeDefined();
  });

  test("the cache is bounded", async () => {
    const client = new SentenceBoundaries((texts) =>
      Promise.resolve(texts.map(() => ({ offsets: [], probabilities: [] }))),
    );
    client.configure({ status: "ready", max_chars: 200_000 });
    const big = (c: string) => c.repeat(150_000);
    for (const c of ["a", "b", "c"]) {
      client.request([big(c)]);
      await client.ready([big(c)], 1000);
    }
    expect(client.get(big("a"))).toBeUndefined();
    expect(client.get(big("c"))).toBeDefined();
  });
});
