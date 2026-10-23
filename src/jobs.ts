// Streamed translations as jobs that are independent of the response reading them. Every event is
// kept, numbered, so a resumable job can be read again from any point after the connection drops
// (iOS cuts it when the page leaves the screen). A job nobody reads for RESUME_GRACE_MS is
// cancelled; a job whose client did not ask for `resumable` is cancelled as soon as its connection
// closes.

import type { ErrorEvent, TranslateEvents } from "./api";
import { ApiError, methodNotAllowed, toApiError } from "./http";
import type { Ticket } from "./queue";
import type { RunEvent } from "./translate";

const KEEPALIVE_MS = 15_000;
/** How long a resumable translation keeps running with nobody reading it (a phone in the background). */
const RESUME_GRACE_MS = 120_000;
/** How long a finished resumable translation can still be fetched. */
const RESUME_KEEP_MS = 10 * 60_000;
const MAX_KEPT_JOBS = 16;

interface Job {
  id: string;
  resumable: boolean;
  frames: string[];
  finished: boolean;
  abort: AbortController;
  reader?: (frame: string) => void;
  closeReader?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createJobs() {
  const jobs = new Map<string, Job>();

  function dropJob(job: Job) {
    clearTimeout(job.timer);
    jobs.delete(job.id);
  }

  /** Called when nobody reads the job (any more): cancel it now, or after the grace period. */
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
    job.timer = setTimeout(() => job.abort.abort(), RESUME_GRACE_MS);
  }

  function finishJob(job: Job) {
    job.finished = true;
    clearTimeout(job.timer);
    job.closeReader?.();
    if (!job.resumable) {
      return dropJob(job);
    }
    job.timer = setTimeout(() => dropJob(job), RESUME_KEEP_MS);
    // Bounded: the oldest finished jobs go first (a Map keeps insertion order).
    const finished = [...jobs.values()].filter((j) => j.finished);
    for (const old of finished.slice(0, Math.max(0, finished.length - MAX_KEPT_JOBS))) {
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
        ...(job.resumable && { "x-translation-id": job.id }),
      },
    });
  }

  /**
   * Starts a job that streams what `run` yields and answers with its first read. `enter` takes a
   * place in the line (before the response starts, so a full line surfaces as a plain 429) and is
   * given what to do when the position changes.
   */
  function startJob(
    resumable: boolean,
    enter: (onPosition: (position: number) => void) => Ticket,
    run: (ticket: Ticket, signal: AbortSignal) => AsyncIterable<RunEvent>,
    signal: AbortSignal,
  ): Response {
    const job: Job = {
      id: crypto.randomUUID(),
      resumable,
      frames: [],
      finished: false,
      abort: new AbortController(),
    };
    const emit = <E extends keyof TranslateEvents>(event: E, data: TranslateEvents[E]) => {
      const frame = `id: ${job.frames.length + 1}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      job.frames.push(frame);
      job.reader?.(frame);
    };

    const ticket = enter((position) => emit("queued", { position }));
    jobs.set(job.id, job);
    job.abort.signal.addEventListener("abort", () => ticket.leave());

    void (async () => {
      try {
        for await (const ev of run(ticket, job.abort.signal)) {
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
      } catch (e) {
        if (job.abort.signal.aborted) {
          // A reader of a resumable job (now or later) learns why the stream stops; for any other job nobody is left.
          if (job.resumable) {
            emit("error", { code: "cancelled", message: "the translation was cancelled" });
          }
        } else {
          const error = toApiError(e);
          // Only what the stream can fail with (prepare, the engine) gets here; the codes are the event's.
          emit("error", { code: error.code as ErrorEvent["code"], message: error.message, details: error.details });
        }
      } finally {
        ticket.leave();
        finishJob(job);
      }
    })();

    return readJob(job, 0, signal);
  }

  /** `/translations/{id}` (DELETE cancels) and `/translations/{id}/events` (GET reads again). */
  function translationRoute(rest: string, req: Request, url: URL): Response | undefined {
    const m = /^\/translations\/([0-9a-f-]{36})(\/events)?$/.exec(rest);
    if (!m) {
      return undefined;
    }
    const job = jobs.get(m[1]!);
    if (!job?.resumable) {
      throw new ApiError(404, "not_found", "no such translation (it may have expired)");
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
    job.abort.abort();
    return new Response(null, { status: 204 });
  }

  return { startJob, translationRoute };
}
