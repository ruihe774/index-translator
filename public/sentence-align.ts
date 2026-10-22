// Which sentences of a translation translate which of its source (`POST /align`, LaBSE), asked for one
// block pair at a time: the one under the pointer. The sentence mark (`sentence-hover.ts`) then marks the
// counterpart too.
//
// A pair is asked for only when the pointer rests on its block, so requests go one at a time and only
// the latest one waits: moving on to another block replaces what has not been sent. Answers are kept
// per pair of sentence lists for the page's life (up to `MAX_CACHED`), and a failure of any kind stops
// asking for a while (`BACKOFF_MS`), as `segment.ts` does.

import type { AlignedPair, Alignment, AlignRequest, AlignUnit, Health } from "../src/api.ts";
import { API, ApiFailure } from "./api.ts";
import type { ApiErrorBody } from "./errors.ts";

/** Most sentences on each side: the server's limit. */
export const MAX_SENTENCES = 256;
/** Block pairs whose answers are kept. */
export const MAX_CACHED = 500;
/** After a failure nothing is asked for this long. */
export const BACKOFF_MS = 10_000;

export type PostAlign = (source: string[], target: string[], signal: AbortSignal) => Promise<AlignedPair[]>;

/** One request to the server. */
export async function postAlign(
  source: string[],
  target: string[],
  signal: AbortSignal,
  unit: AlignUnit = "sentences",
): Promise<AlignedPair[]> {
  const body: AlignRequest = { unit, source, target };
  const res = await fetch(`${API}/align`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
    throw new ApiFailure(payload?.error ?? {}, res.status);
  }
  return ((await res.json()) as Alignment).pairs;
}

const keyOf = (source: string[], target: string[]) => JSON.stringify([source, target]);

/** The pair that holds sentence `index` of `side`, or undefined. */
export function pairOf(pairs: AlignedPair[], side: "source" | "target", index: number): AlignedPair | undefined {
  return pairs.find((p) => p[side].includes(index));
}

export class SentenceAligner {
  private enabled = false;
  private maxChars = 0;
  private readonly cache = new Map<string, AlignedPair[]>();
  /** The pair to send next, and who wants to hear when it is answered. */
  private next: { source: string[]; target: string[]; key: string; done: () => void } | null = null;
  private inFlight: string | null = null;
  private controller = new AbortController();
  private backoffUntil = 0;

  constructor(
    private readonly post: PostAlign = postAlign,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes what `GET /health` says about alignment: nothing is asked for unless it is not `unavailable`. */
  configure(align: Health["align"]): void {
    this.enabled = align !== undefined && align.status !== "unavailable";
    this.maxChars = align?.max_chars ?? 0;
    if (!this.enabled) {
      this.abort();
    }
  }

  get available(): boolean {
    return this.enabled;
  }

  /** The answer for these sentence lists, once there is one. */
  get(source: string[], target: string[]): AlignedPair[] | undefined {
    return this.cache.get(keyOf(source, target));
  }

  /**
   * Asks for these lists unless they are answered, on their way, or too large to ask for; `done` is called
   * when the answer is in. It replaces whatever was waiting to be sent. Returns at once.
   */
  request(source: string[], target: string[], done: () => void): void {
    const key = keyOf(source, target);
    if (
      !this.enabled ||
      this.now() < this.backoffUntil ||
      this.cache.has(key) ||
      this.inFlight === key ||
      source.length === 0 ||
      target.length === 0 ||
      source.length > MAX_SENTENCES ||
      target.length > MAX_SENTENCES ||
      [...source, ...target].reduce((n, t) => n + t.length, 0) > this.maxChars
    ) {
      return;
    }
    this.next = { source, target, key, done };
    void this.pump();
  }

  /** Drops what is waiting and stops what is in flight. */
  abort(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.next = null;
  }

  private async pump(): Promise<void> {
    if (this.inFlight !== null) {
      return;
    }
    while (this.next) {
      const { source, target, key, done } = this.next;
      this.next = null;
      const { signal } = this.controller;
      this.inFlight = key;
      try {
        const pairs = await this.post(source, target, signal);
        if (!signal.aborted) {
          this.keep(key, pairs);
          done();
        }
      } catch {
        // Any failure, 429, 502, 503 or the network alike: the mark goes on without counterparts.
        if (!signal.aborted) {
          this.backoffUntil = this.now() + BACKOFF_MS;
          this.next = null;
        }
      } finally {
        this.inFlight = null;
      }
    }
  }

  private keep(key: string, pairs: AlignedPair[]): void {
    this.cache.set(key, pairs);
    for (const [old] of this.cache) {
      if (this.cache.size <= MAX_CACHED) {
        break;
      }
      this.cache.delete(old);
    }
  }
}
