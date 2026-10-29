// Sentence boundaries from the server (`POST /segment`, SaT) for the texts reading aloud cuts into pieces.
//
// Reading aloud never waits long for them: `ready` gives up after a moment, a failed request of any kind
// is only remembered for a while, and the caller then cuts with `Intl.Segmenter` alone. The answers are
// kept per text for the page's life (up to `MAX_CACHED_CHARS` of text), so reading a text again, or
// another one that shares a paragraph, asks nothing. Requests go one at a time, in the order
// asked, within the server's limits (`max_chars` UTF-16 units and `MAX_TEXTS` texts); a text asked for
// as `first` is sent before the ones still waiting. `abort` drops everything waiting or in flight.

import type { Health, Segmentation, SegmentedText, SegmentRequest } from "../src/api.ts";
import { API, failureOf } from "./api.ts";

/**
 * Most texts in one request: the server's limit (`maxItems` of `SegmentRequest` and of each side of
 * `AlignRequest` in docs/openapi.yaml, both 256; `sentence-align.ts` and `sync-state.ts` use it too).
 */
export const MAX_TEXTS = 256;
/** The answers kept, as the total length of their texts. */
const MAX_CACHED_CHARS = 400_000;
/** After a failure nothing is asked for this long, so a server without the model costs no waiting. */
export const BACKOFF_MS = 10_000;

export type PostSegment = (texts: string[], signal: AbortSignal) => Promise<SegmentedText[]>;

/** One request to the server. */
async function postSegment(texts: string[], signal: AbortSignal): Promise<SegmentedText[]> {
  const body: SegmentRequest = { texts };
  const res = await fetch(`${API}/segment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw await failureOf(res);
  }
  return ((await res.json()) as Segmentation).texts;
}

interface Waiter {
  promise: Promise<void>;
  settle(): void;
}

export class SentenceBoundaries {
  private enabled = false;
  private maxChars = 0;
  private readonly cache = new Map<string, SegmentedText>();
  private cachedChars = 0;
  /** Texts asked for and not answered, each with the promise that settles when it is (or fails). */
  private readonly waiters = new Map<string, Waiter>();
  /** The ones of those not yet sent, in the order they will be. */
  private waiting: string[] = [];
  /** The ones in the request being answered. */
  private readonly inFlight = new Set<string>();
  private sending = false;
  private controller = new AbortController();
  private backoffUntil = 0;

  constructor(
    private readonly post: PostSegment = postSegment,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes what `GET /health` says about segmentation: nothing is asked for unless it is not `unavailable`. */
  configure(segment: Health["segment"]): void {
    this.enabled = segment !== undefined && segment.status !== "unavailable";
    this.maxChars = segment?.max_chars ?? 0;
    if (!this.enabled) {
      this.abort();
    }
  }

  get available(): boolean {
    return this.enabled;
  }

  /** The answer for a text, once there is one. An arrow, so it can be handed on as `speechSegments`' lookup. */
  readonly get = (text: string): SegmentedText | undefined => this.cache.get(text);

  /** Whether `text` has an answer or nothing more is expected for it (it fails to be asked for, or is too long). */
  private settled(text: string): boolean {
    return !this.enabled || this.cache.has(text) || !this.waiters.has(text);
  }

  /** Whether every text has been dealt with: answered, failed, or not to be asked for. */
  allSettled(texts: string[]): boolean {
    return texts.every((t) => this.settled(t));
  }

  /**
   * Asks for texts not known yet, after the ones already waiting, or before them with `first`. Returns at
   * once. A text longer than the server takes in a request is never asked for.
   */
  request(texts: string[], first = false): void {
    if (!this.enabled || this.now() < this.backoffUntil) {
      return;
    }
    const fresh: string[] = [];
    for (const text of texts) {
      if (this.cache.has(text) || text.length > this.maxChars || fresh.includes(text)) {
        continue;
      }
      if (!this.waiters.has(text)) {
        let settle!: () => void;
        const promise = new Promise<void>((resolve) => void (settle = resolve));
        this.waiters.set(text, { promise, settle });
      }
      fresh.push(text);
    }
    // Those in flight are on their way already.
    const queued = fresh.filter((t) => !this.inFlight.has(t));
    if (first) {
      const moved = new Set(queued);
      this.waiting = [...queued, ...this.waiting.filter((t) => !moved.has(t))];
    } else {
      this.waiting.push(...queued.filter((t) => !this.waiting.includes(t)));
    }
    void this.pump();
  }

  /** Resolves when `texts` are settled, or after `ms`, whichever is first. Never rejects. */
  async ready(texts: string[], ms: number): Promise<void> {
    const pending = texts.filter((t) => !this.settled(t)).map((t) => this.waiters.get(t)!.promise);
    if (pending.length === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => void (timer = setTimeout(resolve, ms)));
    try {
      await Promise.race([Promise.all(pending), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drops what is waiting and stops what is in flight; what is asked for afterwards is sent anew. */
  abort(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.waiting = [];
    for (const [text, waiter] of this.waiters) {
      if (!this.cache.has(text)) {
        waiter.settle();
      }
    }
    this.waiters.clear();
    this.inFlight.clear();
  }

  /** Sends the next batch when none is out; each ends by sending the one after. */
  private async pump(): Promise<void> {
    if (this.sending) {
      return;
    }
    this.sending = true;
    try {
      while (this.waiting.length > 0) {
        const { signal } = this.controller;
        const batch: string[] = [];
        let chars = 0;
        while (
          this.waiting.length > 0 &&
          batch.length < MAX_TEXTS &&
          chars + this.waiting[0]!.length <= this.maxChars
        ) {
          const text = this.waiting.shift()!;
          chars += text.length;
          batch.push(text);
        }
        if (batch.length === 0) {
          // Not even one text fits (the limit changed under us): they cannot be asked for.
          this.drop(this.waiting.splice(0));
          break;
        }
        batch.forEach((t) => void this.inFlight.add(t));
        try {
          const answers = await this.post(batch, signal);
          if (answers.length !== batch.length) {
            throw new Error("segmentation: the answer does not match the request");
          }
          if (!signal.aborted) {
            batch.forEach((t, i) => void this.keep(t, answers[i]!));
          }
        } catch {
          // Any failure, 429, 502, 503 or the network alike: reading goes on with `Intl.Segmenter`.
          if (!signal.aborted) {
            this.backoffUntil = this.now() + BACKOFF_MS;
            this.drop([...batch, ...this.waiting.splice(0)]);
          }
        }
        if (!signal.aborted) {
          this.drop(batch);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  /** Settles texts that will not be answered (or have been). */
  private drop(texts: string[]): void {
    for (const text of texts) {
      this.inFlight.delete(text);
      this.waiters.get(text)?.settle();
      this.waiters.delete(text);
    }
  }

  private keep(text: string, answer: SegmentedText): void {
    this.cache.set(text, answer);
    this.cachedChars += text.length;
    for (const [old] of this.cache) {
      if (this.cachedChars <= MAX_CACHED_CHARS || old === text) {
        break;
      }
      this.cache.delete(old);
      this.cachedChars -= old.length;
    }
  }
}
