// Streamed work (translations, transcriptions) as jobs that are independent of the response reading
// them. Every event is kept, numbered, so a resumable job can be read again from any point after the
// connection drops (iOS cuts it when the page leaves the screen). Each kind of job says how long one
// runs on with nobody reading it, if it is ever cancelled for that, and how long a finished one is
// kept; a job whose client did not ask for `resumable` is cancelled as soon as its connection closes.
// A resumable job may carry a push subscription (`PUT /<noun>s/{id}/push`): when it ends with nobody
// reading it, the browser is sent a notification (src/push.ts).

import type { DeltaEvent, PushMessage, TranscriptSegment, TranslateEvents } from "./api";
import { ApiError, methodNotAllowed, toApiError, unavailable } from "./http";
import { parseBody } from "./parse";
import { parseSubscription, Preview, type PushSender, type Subscription } from "./push";
import type { Ticket } from "./queue";
import type { RunEvent } from "./translate";

const KEEPALIVE_MS = 15_000;

/** What sets one kind of job apart. */
export interface JobKind {
  /** In paths, messages and the id header: `translation` is `/translations/{id}` and `x-translation-id`. */
  noun: PushMessage["job"];
  /** How long a running job goes on with nobody reading it; undefined: until it ends. */
  graceMs: number | undefined;
  /** How long a finished job can still be read. */
  keepMs: number;
  /** Finished jobs kept at most; the oldest go first. */
  maxKept: number;
  /** `DELETE` also forgets a finished job (otherwise it only cancels a running one). */
  deleteForgets: boolean;
  /** The part of the result an event carries, for the notification's preview. */
  textOf(event: string, data: unknown): string | undefined;
}

/** A translation runs on for 2 minutes without a reader (a phone in the background) and is kept 10 minutes. */
export const TRANSLATION_JOBS: JobKind = {
  noun: "translation",
  graceMs: 120_000,
  keepMs: 10 * 60_000,
  maxKept: 16,
  deleteForgets: false,
  textOf: (event, data) => (event === "delta" ? (data as DeltaEvent).text : undefined),
};

/**
 * A transcription takes minutes, which its user may spend with the phone locked: it is never cancelled
 * for want of a reader, and is kept 30 minutes.
 */
export const TRANSCRIPTION_JOBS: JobKind = {
  noun: "transcription",
  graceMs: undefined,
  keepMs: 30 * 60_000,
  maxKept: 16,
  deleteForgets: true,
  // Segments carry no whitespace at either end.
  textOf: (event, data) => (event === "segment" ? `${(data as TranscriptSegment).text}\n` : undefined),
};

/** The events of a kind of job, by name; every kind has `queued` and `error` (with at least `cancelled` among its codes). */
interface EventMap {
  queued: { position: number };
  error: { code: string; message: string };
}

/** Emits one event of a job. */
export type Emit<E extends EventMap> = <K extends keyof E & string>(event: K, data: E[K]) => void;

interface Job {
  id: string;
  resumable: boolean;
  frames: string[];
  finished: boolean;
  abort: AbortController;
  reader?: (frame: string) => void;
  closeReader?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  /** `DELETE` asked to forget it once it has ended. */
  forget?: boolean;
  /** Where to send a notification if it ends with nobody reading it. */
  push?: Subscription;
  /** The result's ends for that notification; kept from the start, as the subscription may come late. */
  preview?: Preview;
}

/** `push` is undefined when Web Push is off (`PUSH`). */
export function createJobs<E extends EventMap>(kind: JobKind, push?: PushSender) {
  const jobs = new Map<string, Job>();

  function dropJob(job: Job) {
    clearTimeout(job.timer);
    jobs.delete(job.id);
  }

  /** Called when nobody reads the job (any more): cancel it now, or after the grace period, if ever. */
  function orphan(job: Job) {
    job.reader = undefined;
    job.closeReader = undefined;
    if (job.finished) {
      return;
    }
    if (!job.resumable) {
      return job.abort.abort();
    }
    clearTimeout(job.timer);
    if (kind.graceMs !== undefined) {
      job.timer = setTimeout(() => job.abort.abort(), kind.graceMs);
    }
  }

  function finishJob(job: Job, outcome: PushMessage["outcome"] | "cancelled", error?: string) {
    job.finished = true;
    clearTimeout(job.timer);
    // Nobody to tell of a cancel: the user stopped it, or nobody came back within the grace period.
    if (push && job.push && !job.reader && outcome !== "cancelled") {
      const text = outcome === "error" ? error : job.preview?.text();
      const message: PushMessage = { job: kind.noun, id: job.id, outcome, ...(text && { text }) };
      void push.send(job.push, JSON.stringify(message), kind.keepMs / 1000);
    }
    job.closeReader?.();
    if (!job.resumable || job.forget) {
      return dropJob(job);
    }
    job.timer = setTimeout(() => dropJob(job), kind.keepMs);
    // Bounded: the oldest finished jobs go first (a Map keeps insertion order).
    const finished = [...jobs.values()].filter((j) => j.finished);
    for (const old of finished.slice(0, Math.max(0, finished.length - kind.maxKept))) {
      dropJob(old);
    }
  }

  /** Reads `job` from the frame after `after` on: what was kept, then what follows. */
  function readJob(job: Job, after: number, signal: AbortSignal): Response {
    const encoder = new TextEncoder();
    let cancelRead = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const write = (text: string) => {
          try {
            c.enqueue(encoder.encode(text));
          } catch {
            cancelRead();
          }
        };
        for (let i = after; i < job.frames.length; i++) {
          write(job.frames[i]!);
        }
        if (job.finished) {
          c.close();
          return;
        }
        const keepalive = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);
        const reader = (frame: string) => write(frame);
        let ended = false;
        const end = () => {
          if (ended) {
            return;
          }
          ended = true;
          clearInterval(keepalive);
          signal.removeEventListener("abort", cancelRead);
        };
        cancelRead = () => {
          if (ended) {
            return;
          }
          end();
          if (job.reader === reader) {
            orphan(job);
          }
        };
        // A newer reader replaces this one: the old connection is a dead socket the server has not noticed yet.
        job.closeReader?.();
        clearTimeout(job.timer);
        job.reader = reader;
        job.closeReader = () => {
          end();
          try {
            c.close();
          } catch {}
        };
        signal.addEventListener("abort", cancelRead);
      },
      cancel: () => cancelRead(),
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        ...(job.resumable && { [`x-${kind.noun}-id`]: job.id }),
      },
    });
  }

  /**
   * Starts a job that streams what `run` emits and answers with its first read. `enter` takes a
   * place in the line (before the response starts, so a full line surfaces as a plain 429) and is
   * given what to do when the position changes. `run` ends when the job is done; what it throws is
   * the job's `error` event.
   */
  function startJob(
    resumable: boolean,
    enter: (onPosition: (position: number) => void) => Ticket,
    run: (ticket: Ticket, signal: AbortSignal, emit: Emit<E>) => Promise<void>,
    signal: AbortSignal,
  ): Response {
    const job: Job = {
      id: crypto.randomUUID(),
      resumable,
      frames: [],
      finished: false,
      abort: new AbortController(),
      preview: push && new Preview(),
    };
    const emit: Emit<E> = (event, data) => {
      if (job.preview) {
        const text = kind.textOf(event, data);
        if (text) {
          job.preview.add(text);
        }
      }
      const frame = `id: ${job.frames.length + 1}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      job.frames.push(frame);
      job.reader?.(frame);
    };

    const ticket = enter((position) => emit("queued", { position }));
    jobs.set(job.id, job);
    job.abort.signal.addEventListener("abort", () => ticket.leave());

    void (async () => {
      let outcome: PushMessage["outcome"] | "cancelled" = "done";
      let message: string | undefined;
      try {
        await run(ticket, job.abort.signal, emit);
      } catch (e) {
        outcome = job.abort.signal.aborted ? "cancelled" : "error";
        if (job.abort.signal.aborted) {
          // A reader of a resumable job (now or later) learns why the stream stops; for any other job nobody is left.
          if (job.resumable) {
            emit("error", { code: "cancelled", message: `the ${kind.noun} was cancelled` });
          }
        } else {
          const error = toApiError(e);
          ({ message } = error);
          // Only what the stream can fail with (prepare, the engine) gets here; the codes are the event's.
          emit("error", { code: error.code, message: error.message, details: error.details } as E["error"]);
        }
      } finally {
        ticket.leave();
        finishJob(job, outcome, message);
      }
    })();

    return readJob(job, 0, signal);
  }

  const path = new RegExp(`^/${kind.noun}s/([0-9a-f-]{36})(/events|/push)?$`);

  /** `PUT /<noun>s/{id}/push`: the subscription to notify if the job ends unread; the last one sent wins. */
  async function subscribe(job: Job, req: Request): Promise<Response> {
    if (!push) {
      throw unavailable("push_unavailable", "push notifications are off; start the server with PUSH=1");
    }
    job.push = parseSubscription(await parseBody(req));
    return new Response(null, { status: 204 });
  }

  /**
   * `/<noun>s/{id}` (DELETE cancels, or forgets), `/<noun>s/{id}/events` (GET reads again) and
   * `/<noun>s/{id}/push` (PUT subscribes).
   */
  function route(rest: string, req: Request, url: URL): Response | Promise<Response> | undefined {
    const m = path.exec(rest);
    if (!m) {
      return undefined;
    }
    const job = jobs.get(m[1]!);
    if (!job?.resumable) {
      throw new ApiError(404, "not_found", `no such ${kind.noun} (it may have expired)`);
    }
    if (m[2] === "/push") {
      return req.method === "PUT" ? subscribe(job, req) : methodNotAllowed("PUT");
    }
    if (m[2]) {
      if (req.method !== "GET") {
        return methodNotAllowed("GET");
      }
      const last = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0);
      return readJob(job, Number.isInteger(last) && last > 0 ? last : 0, req.signal);
    }
    if (req.method !== "DELETE") {
      return methodNotAllowed("DELETE");
    }
    if (kind.deleteForgets) {
      // A running job is forgotten when it has ended, so a reader still gets its `cancelled` event.
      if (job.finished) {
        dropJob(job);
      }
      job.forget = true;
    }
    job.abort.abort();
    return new Response(null, { status: 204 });
  }

  return { startJob, route };
}

/** A translation's run events as the events of `POST /translate`. */
export async function emitTranslation(events: AsyncIterable<RunEvent>, emit: Emit<TranslateEvents>): Promise<void> {
  for await (const ev of events) {
    if (ev.type === "start") {
      emit("start", {
        model: ev.model,
        prompt_tokens: ev.promptTokens,
        max_output_tokens: ev.maxOutputTokens,
        queue_ms: ev.queueMs,
      });
    } else if (ev.type === "delta") {
      emit("delta", { text: ev.text });
    } else {
      emit("done", { finish_reason: ev.finish_reason, usage: ev.usage, timings: ev.timings });
    }
  }
}
