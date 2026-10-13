// Keeps a translation stream going across a dropped connection. iOS cuts a page's connections when
// the user leaves it; the server keeps a resumable translation running for a while and replays its
// events from any point, so the page reconnects and carries on. No DOM access: unit tested.

import { type SseEvent, sseEvents } from "./sse.js";

export interface ResumeOptions {
  /** Opens the stream: the first call (`lastId` 0) starts the translation, later ones read it again from after `lastId`. */
  connect: (lastId: number, signal: AbortSignal) => Promise<Response>;
  /** Stops everything (the user pressed Stop). */
  signal: AbortSignal;
  /** Calls back when the page may have its connections back (it became visible); returns the way to stop listening. */
  wake: (callback: () => void) => () => void;
  /** Whether the page is on screen; nothing is retried while it is not. */
  visible: () => boolean;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  /** Delays between failed attempts; the stream gives up after the last one. */
  delays?: number[];
}

const RETRY_DELAYS = [0, 500, 1000, 2000, 4000];

/** `x-translation-id` is what makes a stream resumable; without it a failure is final. */
export const TRANSLATION_ID_HEADER = "x-translation-id";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/** Resolves when the page is visible again (at once if it is). */
function whenVisible(o: ResumeOptions): Promise<void> {
  if (o.visible() || o.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const off = o.wake(() => {
      if (!o.visible()) return;
      off();
      resolve();
    });
    o.signal.addEventListener("abort", () => (off(), resolve()), { once: true });
  });
}

/**
 * The events of one translation, in order and each once, however many connections it takes. Ends
 * after a `done` or `error` event. A connection that fails, ends early, or is still open when the
 * page comes back is replaced by a new one that starts after the last event seen. Errors from the
 * first connection (a refused request) and from a server that does not support resuming are thrown.
 */
export async function* resumableEvents(o: ResumeOptions): AsyncGenerator<SseEvent> {
  const delays = o.delays ?? RETRY_DELAYS;
  let lastId = 0;
  let resumable = false;
  let failures = 0;
  let reconnecting = false;

  while (!o.signal.aborted) {
    const link = new AbortController();
    const off = o.wake(() => link.abort());
    const signal = AbortSignal.any([o.signal, link.signal]);
    try {
      const res = await o.connect(lastId, signal);
      if (lastId === 0 && res.headers.has(TRANSLATION_ID_HEADER)) resumable = true;
      if (!res.body) throw new TypeError("no response body");
      if (reconnecting) {
        reconnecting = false;
        o.onReconnected?.();
      }
      for await (const ev of sseEvents(res.body)) {
        failures = 0;
        const n = Number(ev.id);
        if (Number.isInteger(n) && n > lastId) lastId = n;
        yield ev;
        if (ev.event === "done" || ev.event === "error") return;
      }
      // Ended without a final event: the connection was cut.
      throw new TypeError("the stream ended early");
    } catch (e) {
      if (o.signal.aborted) throw e;
      // Only a dropped connection is worth another try: a refused request (an ApiFailure) is the answer.
      const dropped = e instanceof TypeError || (e instanceof DOMException && e.name === "AbortError");
      if (!resumable || !dropped) throw e;
      if (!reconnecting) {
        reconnecting = true;
        o.onReconnecting?.();
      }
    } finally {
      off();
    }

    // Replaced by the page coming back: try again at once, without counting a failure.
    if (link.signal.aborted) continue;
    await whenVisible(o);
    if (o.signal.aborted) break;
    if (failures >= delays.length) throw new TypeError("the connection could not be restored");
    await sleep(delays[failures++]!, o.signal);
  }
  throw new DOMException("aborted", "AbortError");
}
