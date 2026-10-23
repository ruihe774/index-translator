// Waiting lines: each engine thread has one, and a request holds a place in it while it uses the thread.

import { ApiError, cancelled } from "./http";
import { QueueFullError, SlotQueue, type Ticket } from "./queue";

/** A queue and the words for it in a `queue_full` message. */
export interface Line {
  readonly name: string;
  readonly queue: SlotQueue;
  readonly maxWaiting: number;
}

export function makeLine(name: string, maxWaiting: number): Line {
  return { name, queue: new SlotQueue(maxWaiting), maxWaiting };
}

export function enterLine(line: Line, onPosition?: (position: number) => void): Ticket {
  try {
    return line.queue.enter(onPosition);
  } catch (e) {
    if (e instanceof QueueFullError) {
      throw new ApiError(
        429,
        "queue_full",
        `too many ${line.name} are waiting; try again later`,
        { max_queue: line.maxWaiting },
        { "retry-after": "10" },
      );
    }
    throw e;
  }
}

/** What `withTicket` gives `fn`. */
export interface Held {
  ticket: Ticket;
  /**
   * Keeps the place after the request is over, or after it is aborted: the caller leaves it itself.
   * For work that cannot be stopped at once, so the next must not start beside it.
   */
  keep(): void;
}

/** Waits for the slot; a ticket that left while waiting means the client went away. */
export async function granted(ticket: Ticket, signal: AbortSignal): Promise<void> {
  if (!(await ticket.ready) || signal.aborted) {
    throw cancelled();
  }
}

/**
 * Runs `fn` holding a place in `line`: leaves it when `fn` ends or `signal` aborts, and reports an
 * abort as `cancelled` whatever `fn` threw (an aborted engine call throws a raw AbortError).
 * `fn` runs once it holds the slot, unless `waitForSlot` is false: then it waits itself (`granted`).
 */
export async function withTicket<T>(
  line: Line,
  signal: AbortSignal,
  fn: (held: Held) => Promise<T>,
  waitForSlot = true,
): Promise<T> {
  const ticket = enterLine(line);
  let kept = false;
  const onAbort = () => {
    if (!kept) {
      ticket.leave();
    }
  };
  signal.addEventListener("abort", onAbort);
  try {
    if (waitForSlot) {
      await granted(ticket, signal);
    }
    return await fn({ ticket, keep: () => void (kept = true) });
  } catch (e) {
    throw signal.aborted ? cancelled() : e;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!kept) {
      ticket.leave();
    }
  }
}
