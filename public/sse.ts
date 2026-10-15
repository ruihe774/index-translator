// A small Server-Sent Events reader: turns a byte stream into { event, data } records.
// Pure apart from the stream it is given; no DOM access, so it can be unit tested.

import type { TranslateEvents } from "../src/api.ts";

export interface SseEvent<E extends string = string, D = unknown> {
  event: E;
  data: D;
  /** The `id:` field, when the server sent one: where to pick up again from (`Last-Event-ID`). */
  id?: string;
}

/** An event of the stream of `POST /translate`: `event` tells which schema of the API `data` has. */
export type TranslateSseEvent = {
  [E in keyof TranslateEvents]: SseEvent<E, TranslateEvents[E]>;
}[keyof TranslateEvents];

/**
 * Yields each event in an SSE response body, in order. The reader is cancelled when the
 * generator finishes, fails, or is abandoned by its consumer, so the connection is always released.
 * The wire holds no types: `T` is what the caller knows the stream carries (its `data` is only
 * parsed as JSON here).
 */
export async function* sseEvents<T extends SseEvent = SseEvent>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      // Normalise after appending, so a "\r" at the end of one chunk pairs with a "\n" at the start of the next.
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n");
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = parseBlock(block);
        if (event) {
          yield event as T;
        }
      }
    }
    // End of stream: flush the decoder and treat any unterminated final block as an event.
    buffer = (buffer + decoder.decode()).replaceAll("\r\n", "\n");
    if (buffer.trim()) {
      const event = parseBlock(buffer);
      if (event) {
        yield event as T;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already finished or errored; nothing more to release.
    }
  }
}

/** Reads one event block. Returns null when the block carries no data lines (comments, keepalives). */
function parseBlock(block: string): SseEvent | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    } // comment or keepalive
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (!data.length) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data.join("\n"));
    const eventObj: SseEvent = { event, data: parsed };
    if (id !== undefined) {
      eventObj.id = id;
    }
    return eventObj;
  } catch {
    throw new Error("the server sent an unreadable event");
  }
}
