// One run of the page's long jobs (a translation, a page fetch, a transcription): what Stop acts on. The state holds
// the current one (`state.running`), so the Stop button needs one permanent listener.

import { API, ApiFailure, failureOf } from "./api.ts";
import { type Done, modelLabel } from "./messages.ts";
import { notifyWhenDone } from "./push.ts";
import { onPageWake, pageVisible, resumableEvents, TRANSLATION_ID_HEADER } from "./resume.ts";
import type { ModelId } from "./select-model.ts";

export class Run {
  readonly controller = new AbortController();
  /** Set once the server has accepted a resumable translation (or a transcription): what reconnecting reads. */
  jobId: string | null = null;
  /** What Stop deletes: a resumable translation or a transcription, once the server has accepted it. */
  cancelUrl: string | null = null;
  stopped = false;
  /**
   * Set for a job whose server may take a while to stop (a transcription finishes the step it is in):
   * the first Stop only tells the server and calls this, and the events are read on until the job's
   * `cancelled`; a second Stop gives up waiting.
   */
  onStopping: (() => void) | null = null;
  private cancelSent = false;

  /** The user pressed Stop. */
  stop() {
    const waiting = this.onStopping !== null && this.cancelUrl !== null && !this.stopped;
    this.stopped = true;
    if (waiting) {
      this.onStopping?.();
    } else {
      this.controller.abort();
    }
    this.cancel();
  }

  /** The next request of the run (a subtitle file goes in several): Stop then deletes that one's job. */
  nextJob() {
    this.jobId = null;
    this.cancelUrl = null;
    this.cancelSent = false;
  }

  /**
   * Tells the server to stop the job, without touching the page: on Stop, and when the page is closed for good,
   * after which nothing could show what the job produces (or the notification it would send).
   */
  cancel() {
    // The server keeps a resumable translation or a transcription running without a reader, so it is told to stop.
    if (this.cancelUrl && !this.cancelSent) {
      this.cancelSent = true;
      void fetch(this.cancelUrl, { method: "DELETE", keepalive: true }).catch(() => {
        // best effort: the server also ends a translation nobody reads after its grace period
      });
    }
  }
}

export interface StreamHooks {
  /** What the one status line should say now. */
  status(text: string): void;
  /** Called with each piece of the translation; it puts the piece in the state (`appendTranslation`, or rebuilt). */
  text(piece: string): void;
}

/**
 * Starts the translation (`body` is the JSON of the request) and follows its events, reconnecting
 * after a dropped connection, until it is done. Throws when it fails or the run is stopped.
 */
export async function streamTranslation(run: Run, body: string, model: ModelId, hooks: StreamHooks): Promise<Done> {
  const translating = (id: string) => `Translating with ${modelLabel(id)}…`;
  const { signal } = run.controller;
  const events = resumableEvents({
    signal,
    visible: pageVisible,
    wake: onPageWake,
    onReconnecting: () => hooks.status("Connection lost. Reconnecting…"),
    onReconnected: () => hooks.status(translating(model)),
    connect: async (lastId, connection) => {
      const res = run.jobId
        ? await fetch(`${API}/translations/${run.jobId}/events`, {
            headers: { "last-event-id": String(lastId) },
            signal: connection,
          })
        : await fetch(`${API}/translate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: connection,
          });
      if (!res.ok || !res.body) {
        throw await failureOf(res);
      }
      run.jobId ??= res.headers.get(TRANSLATION_ID_HEADER);
      if (run.jobId && !run.cancelUrl) {
        run.cancelUrl = `${API}/translations/${run.jobId}`;
        void notifyWhenDone(run.cancelUrl);
      }
      return res;
    },
  });

  let done: Done | null = null;
  for await (const { event, data } of events) {
    if (event === "queued") {
      hooks.status(`Waiting in the queue, position ${data.position}…`);
    } else if (event === "start") {
      hooks.status(translating(data.model));
    } else if (event === "delta") {
      hooks.text(data.text);
    } else if (event === "done") {
      done = data;
    } else if (event === "error") {
      throw new ApiFailure(data, 0);
    }
  }
  if (!done) {
    throw new Error("the connection closed before the translation finished");
  }
  return done;
}
