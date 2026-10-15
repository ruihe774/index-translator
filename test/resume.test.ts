/* eslint-disable @typescript-eslint/await-thenable */
import { describe, expect, test } from "bun:test";

import { resumableEvents, TRANSLATION_ID_HEADER } from "../public/resume";
import type { SseEvent } from "../public/sse";

const encoder = new TextEncoder();

function frame(id: number, event: string, data: unknown) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A response that sends `frames`, then ends (a cut connection) or stays open when `hang` is set. */
function response(frames: string[], opts: { hang?: AbortSignal; id?: boolean } = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) {
        c.enqueue(encoder.encode(f));
      }
      if (!opts.hang) {
        c.close();
      } else {
        opts.hang.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      }
    },
  });
  return new Response(body, { headers: opts.id === false ? {} : { [TRANSLATION_ID_HEADER]: "abc" } });
}

async function run(connect: (last: number, signal: AbortSignal) => Promise<Response>, extra = {}) {
  const out: SseEvent[] = [];
  const notes: string[] = [];
  for await (const ev of resumableEvents({
    connect,
    signal: new AbortController().signal,
    wake: () => () => {},
    visible: () => true,
    onReconnecting: () => void notes.push("lost"),
    onReconnected: () => void notes.push("back"),
    delays: [0, 0],
    ...extra,
  })) {
    out.push(ev);
  }
  return { events: out.map((e) => `${e.event}:${e.id}`), notes };
}

describe("resumableEvents", () => {
  test("a stream that ends with done is passed through", async () => {
    const r = await run(() => Promise.resolve(response([frame(1, "start", {}), frame(2, "done", {})])));
    expect(r.events).toStrictEqual(["start:1", "done:2"]);
    expect(r.notes).toStrictEqual([]);
  });

  test("a cut connection is resumed after the last event seen, without repeats", async () => {
    const asked: number[] = [];
    const r = await run((last) => {
      asked.push(last);
      return Promise.resolve(
        last === 0
          ? response([frame(1, "start", {}), frame(2, "delta", { text: "a" })])
          : response([frame(3, "delta", { text: "b" }), frame(4, "done", {})]),
      );
    });
    expect(asked).toStrictEqual([0, 2]);
    expect(r.events).toStrictEqual(["start:1", "delta:2", "delta:3", "done:4"]);
    expect(r.notes).toStrictEqual(["lost", "back"]);
  });

  test("a failed reconnect is retried, then given up", async () => {
    let calls = 0;
    const events = run((last) => {
      calls++;
      if (last === 0) {
        return Promise.resolve(response([frame(1, "start", {})]));
      }
      return Promise.reject(new TypeError("offline"));
    });
    await expect(events).rejects.toThrow("could not be restored");
    expect(calls).toBe(3);
  });

  test("the page coming back replaces a connection that is still open", async () => {
    const wakes = new Set<() => void>();
    const asked: number[] = [];
    const r = await run(
      (last, signal) => {
        asked.push(last);
        if (last === 0) {
          queueMicrotask(() => void setTimeout(() => wakes.forEach((w) => w()), 10));
          return Promise.resolve(response([frame(1, "start", {})], { hang: signal }));
        }
        return Promise.resolve(response([frame(2, "done", {})]));
      },
      {
        wake: (cb: () => void) => {
          wakes.add(cb);
          return () => wakes.delete(cb);
        },
      },
    );
    expect(asked).toStrictEqual([0, 1]);
    expect(r.events).toStrictEqual(["start:1", "done:2"]);
  });

  test("a server that cannot resume ends the stream with the failure", async () => {
    const events = run(() => Promise.resolve(response([frame(1, "start", {})], { id: false })));
    await expect(events).rejects.toThrow("ended early");
  });
});
