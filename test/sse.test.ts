import { describe, expect, test } from "bun:test";

import { type SseEvent, sseEvents } from "../public/sse";
import { collect } from "./helpers/harness";

const encoder = new TextEncoder();

/** A body that yields the given byte chunks, one per read. Records cancel() calls. */
function body(chunks: (string | Uint8Array)[]) {
  const state = { cancelled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) {
        controller.close();
      } else {
        controller.enqueue(typeof next === "string" ? encoder.encode(next) : next);
      }
    },
    cancel() {
      state.cancelled++;
    },
  });
  return { stream, state };
}

function collectChunks(chunks: (string | Uint8Array)[]): Promise<SseEvent[]> {
  return collect(sseEvents(body(chunks).stream));
}

describe("sseEvents", () => {
  test("parses a simple event into { event, data }", async () => {
    await expect(collectChunks(['event: delta\ndata: {"text":"hi"}\n\n'])).resolves.toStrictEqual([
      { event: "delta", data: { text: "hi" } },
    ]);
  });

  test("defaults the event name to message", async () => {
    await expect(collectChunks(['data: {"a":1}\n\n'])).resolves.toStrictEqual([{ event: "message", data: { a: 1 } }]);
  });

  test("accepts data: without a space after the colon", async () => {
    await expect(collectChunks(['event:delta\ndata:{"text":"x"}\n\n'])).resolves.toStrictEqual([
      { event: "delta", data: { text: "x" } },
    ]);
  });

  test("joins multi-line data with newlines before parsing", async () => {
    await expect(collectChunks(['data: {"text":\ndata: "a\\nb"}\n\n'])).resolves.toStrictEqual([
      { event: "message", data: { text: "a\nb" } },
    ]);
  });

  test("reassembles an event split across chunks", async () => {
    await expect(collectChunks(["event: del", 'ta\ndata: {"te', 'xt":"hi"}', "\n\n"])).resolves.toStrictEqual([
      { event: "delta", data: { text: "hi" } },
    ]);
  });

  test("handles a multi-byte UTF-8 character split across chunks", async () => {
    const bytes = encoder.encode('event: delta\ndata: {"text":"译文"}\n\n');
    // Cut inside the 3-byte encoding of 译 (U+8BD1).
    const cut = bytes.indexOf(0xe8) + 1;
    const events = await collectChunks([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(events).toStrictEqual([{ event: "delta", data: { text: "译文" } }]);
  });

  test(String.raw`handles a \n\n separator that falls on a chunk boundary`, async () => {
    await expect(collectChunks(['data: {"a":1}\n', '\ndata: {"a":2}\n', "\n"])).resolves.toStrictEqual([
      { event: "message", data: { a: 1 } },
      { event: "message", data: { a: 2 } },
    ]);
  });

  test("ignores comment and keepalive lines", async () => {
    await expect(
      collectChunks([": keepalive\n\n", ': ping\n: another\n\nevent: delta\ndata: {"text":"x"}\n\n: keepalive\n\n']),
    ).resolves.toStrictEqual([{ event: "delta", data: { text: "x" } }]);
  });

  test("a block with only comments yields nothing", async () => {
    await expect(collectChunks([": just a comment\n\n"])).resolves.toStrictEqual([]);
  });

  test("accepts CRLF line endings", async () => {
    await expect(
      collectChunks(['event: delta\r\ndata: {"text":"x"}\r\n\r\nevent: done\r\ndata: {"n":2}\r\n\r\n']),
    ).resolves.toStrictEqual([
      { event: "delta", data: { text: "x" } },
      { event: "done", data: { n: 2 } },
    ]);
  });

  test("a CR at the end of a chunk pairs with an LF at the start of the next", async () => {
    // Without normalising after appending, "\r" + "\n\r\n" would look like an extra blank line.
    await expect(collectChunks(['data: {"a":1}\r', "\n\r\n", 'data: {"a":2}\r\n\r\n'])).resolves.toStrictEqual([
      { event: "message", data: { a: 1 } },
      { event: "message", data: { a: 2 } },
    ]);
  });

  test("yields a trailing event that has no blank line at the end", async () => {
    await expect(
      collectChunks(['event: delta\ndata: {"text":"a"}\n\nevent: done\ndata: {"n":1}\n']),
    ).resolves.toStrictEqual([
      { event: "delta", data: { text: "a" } },
      { event: "done", data: { n: 1 } },
    ]);
  });

  test("a multi-byte character split inside an unterminated final event is decoded", async () => {
    const bytes = encoder.encode('data: {"text":"译"}');
    const cut = bytes.indexOf(0xe8) + 1;
    const events = await collectChunks([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(events).toStrictEqual([{ event: "message", data: { text: "译" } }]);
  });

  test("ignores trailing whitespace after the last event", async () => {
    await expect(collectChunks(['data: {"a":1}\n\n\n  \n'])).resolves.toStrictEqual([
      { event: "message", data: { a: 1 } },
    ]);
  });

  test("throws a clear error for invalid JSON in data", async () => {
    const run = collectChunks(["event: delta\ndata: {not json\n\n"]);
    await expect(run).rejects.toThrow("the server sent an unreadable event");
  });

  test("throws the clear error for a trailing event with invalid JSON", async () => {
    await expect(collectChunks(["data: {oops"])).rejects.toThrow("the server sent an unreadable event");
  });

  test("events before a malformed one are still delivered in order", async () => {
    const seen: SseEvent[] = [];
    const run = (async () => {
      for await (const ev of sseEvents(body(['data: {"a":1}\n\ndata: {bad\n\n']).stream)) {
        seen.push(ev);
      }
    })();
    await expect(run).rejects.toThrow("the server sent an unreadable event");
    expect(seen).toStrictEqual([{ event: "message", data: { a: 1 } }]);
  });

  test("cancels the reader when the consumer stops early", async () => {
    const { stream, state } = body(['data: {"a":1}\n\n', 'data: {"a":2}\n\n', 'data: {"a":3}\n\n']);
    for await (const ev of sseEvents(stream)) {
      expect(ev.data).toStrictEqual({ a: 1 });
      break;
    }
    expect(state.cancelled).toBe(1);
  });

  test("cancels the reader when the consumer throws", async () => {
    const { stream, state } = body(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']);
    const run = (async () => {
      for await (const _ of sseEvents(stream)) {
        throw new Error("consumer failed");
      }
    })();
    await expect(run).rejects.toThrow("consumer failed");
    expect(state.cancelled).toBe(1);
  });

  test("a body that fails mid-stream rejects with that error after delivering earlier events", async () => {
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(encoder.encode('data: {"a":1}\n\n'));
        } else {
          controller.error(new Error("connection reset"));
        }
      },
    });
    const seen: SseEvent[] = [];
    await expect(
      (async () => {
        for await (const ev of sseEvents(stream)) {
          seen.push(ev);
        }
      })(),
    ).rejects.toThrow("connection reset");
    expect(seen).toStrictEqual([{ event: "message", data: { a: 1 } }]);
  });

  test("a normal end of stream completes without error", async () => {
    // A closed stream ignores cancel(); the point is that the finally block does not throw.
    const { stream } = body(['data: {"a":1}\n\n']);
    const seen: SseEvent[] = [];
    for await (const ev of sseEvents(stream)) {
      seen.push(ev);
    }
    expect(seen).toStrictEqual([{ event: "message", data: { a: 1 } }]);
  });
});
