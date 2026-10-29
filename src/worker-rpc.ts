// The plumbing the engine threads share. Each engine (libllama, libaudiocpp, ONNX Runtime) runs in a
// worker thread that answers one reply per request, matched by a request number:
//
// - a `Protocol` says, per request type, what it carries and which reply answers it;
// - `WorkerClient` is the server-thread side: typed `call`, streaming `stream`, `send`, `terminate`;
//   an error reply becomes a rejection, and a thread that dies fails every request waiting on it;
// - `serve` is the worker-thread side: one handler per request type;
// - `LazyModel` is a model that the first request loads and idleness frees again;
// - `abortable` runs a request that a client's `AbortSignal` stops through a flag in shared memory.

/** What a request type carries, the reply that answers it and, for streams, the replies before that one. */
export type Protocol<P> = {
  [K in keyof P]: { request: object; reply: { type: string }; stream?: { type: string } };
};

/** A request that carries nothing but its type. */
export type NoBody = object;

/** The reply to any request the worker could not answer. `image`: the input itself is at fault (llama). */
export interface ErrorReply {
  type: "error";
  message: string;
  image?: boolean;
}

/** The messages the server thread posts to the worker. */
export type Requests<P extends Protocol<P>> = {
  [K in keyof P & string]: { type: K; req: number } & P[K]["request"];
}[keyof P & string];

type BodyArgs<B> = keyof B extends never ? [body?: B] : [body: B];

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Live {
  worker: Worker;
  /** Settles with the reason if this thread dies. */
  lost: Promise<string>;
}

export interface WorkerClientOptions {
  /** Starts the thread; called again by the first request after the last one was lost. */
  start: () => Worker;
  /** The thread as messages name it: "the speech thread failed: ...". */
  label: string;
  /** The rejection an error reply becomes. */
  fail: (reply: ErrorReply) => Error;
  /** Called once when a thread dies, before the requests waiting on it are failed. */
  onLost?: (reason: string) => void;
}

/** The server-thread side of a worker. The thread is started by the first request. */
export class WorkerClient<P extends Protocol<P>> {
  private live: Live | undefined;
  private readonly waiting = new Map<number, (reply: { type: string }) => void>();
  private lastReq = 0;

  constructor(private readonly options: WorkerClientOptions) {}

  /** Whether a thread is running. */
  get started(): boolean {
    return this.live !== undefined;
  }

  private begin(): Live {
    const worker = this.options.start();
    let die!: (reason: string) => void;
    const live: Live = { worker, lost: new Promise<string>((resolve) => void (die = resolve)) };
    worker.onmessage = (event: MessageEvent<{ req: number; type: string }>) =>
      this.waiting.get(event.data.req)?.(event.data);
    const gone = (reason: string) => {
      if (this.live !== live) {
        return;
      }
      this.live = undefined;
      this.options.onLost?.(reason);
      die(reason);
      const failure: ErrorReply = { type: "error", message: reason };
      for (const deliver of this.waiting.values()) {
        deliver(failure);
      }
    };
    worker.onerror = (event) => gone(`the ${this.options.label} failed: ${event.message}`);
    worker.addEventListener("close", () => gone(`the ${this.options.label} exited`));
    this.live = live;
    return live;
  }

  /** Settles with the reason when the thread that is running now (it is started if need be) dies. */
  whenLost(): Promise<string> {
    return (this.live ?? this.begin()).lost;
  }

  private post(type: string, body: object, deliver?: (reply: { type: string }) => void): number {
    const { worker } = this.live ?? this.begin();
    const req = ++this.lastReq;
    if (deliver) {
      this.waiting.set(req, deliver);
    }
    worker.postMessage({ ...body, type, req });
    return req;
  }

  /** One request, one reply: the one its protocol entry names. An error reply rejects. */
  call<K extends keyof P & string>(type: K, ...args: BodyArgs<P[K]["request"]>): Promise<P[K]["reply"]> {
    return new Promise((resolve, reject) => {
      const req = this.post(type, args[0] ?? {}, (reply) => {
        this.waiting.delete(req);
        if (reply.type === "error") {
          reject(this.options.fail(reply as ErrorReply));
        } else {
          resolve(reply);
        }
      });
    });
  }

  /**
   * A request with several replies (its protocol entry's `stream`, then its `reply` or an error), all
   * handed to `onReply` until `close()`. `req` names it to a later `send`.
   */
  stream<K extends keyof P & string>(
    type: K,
    body: P[K]["request"],
    onReply: (reply: P[K]["reply"] | NonNullable<P[K]["stream"]> | ErrorReply) => void,
  ): { req: number; close: () => void } {
    const req = this.post(type, body, onReply);
    return { req, close: () => void this.waiting.delete(req) };
  }

  /** A request nobody answers. */
  send<K extends keyof P & string>(type: K, ...args: BodyArgs<P[K]["request"]>): void {
    this.post(type, args[0] ?? {});
  }

  /** Ends the thread. Nothing may be waiting on it. */
  terminate(): void {
    const { live } = this;
    this.live = undefined;
    live?.worker.terminate();
  }
}

/** What a handler is given: its request, and a way to post a reply before its last one. */
type Handler<P extends Protocol<P>, K extends keyof P & string> = (
  msg: { type: K; req: number } & P[K]["request"],
  post: (reply: P[K] extends { stream: infer S } ? S : never) => void,
) => P[K]["reply"] | undefined | Promise<P[K]["reply"] | undefined>;

export type Handlers<P extends Protocol<P>> = { [K in keyof P & string]: Handler<P, K> };

/**
 * The worker-thread side: answers each request with what its handler returns (nothing is posted for
 * `undefined`) and a thrown error with an error reply. A handler that answers at once is finished
 * before the next message is read; one that returns a promise is awaited without blocking the next.
 * ArrayBuffers in a reply are transferred. `errorFields` adds to the error reply (llama: `image`).
 */
export function serve<P extends Protocol<P>>(
  handlers: Handlers<P>,
  errorFields: (e: unknown) => Partial<ErrorReply> = () => ({}),
): void {
  const scope = globalThis as unknown as Worker;
  const send = (req: number, body: object) =>
    scope.postMessage(
      { ...body, req },
      Object.values(body).filter((v): v is ArrayBuffer => v instanceof ArrayBuffer),
    );
  scope.onmessage = (event: MessageEvent<Requests<P>>) => {
    const msg = event.data;
    const settle = (reply: object | undefined) => reply && send(msg.req, reply);
    const fail = (e: unknown) => send(msg.req, { type: "error", message: messageOf(e), ...errorFields(e) });
    try {
      const handler = handlers[msg.type] as (m: unknown, post: (r: object) => void) => unknown;
      const reply = handler(msg, (r) => send(msg.req, r));
      if (reply instanceof Promise) {
        reply.then(settle, fail);
      } else {
        settle(reply as object | undefined);
      }
    } catch (e) {
      fail(e);
    }
  };
}

export interface LazyModelOptions {
  /** The log prefix: `[speech]`. */
  tag: string;
  /** What is loaded, in messages: "the speech model" is `speech model`. */
  model: string;
  /** Why the model cannot run at all, checked each time so an install does not need a restart. */
  missing: () => string | undefined;
  /** Seconds without a request after which the model is freed; 0 keeps it. */
  idleUnload: number;
  /** Loads it on the worker; answers what the log says besides how long it took. */
  load: () => Promise<string>;
  /** Frees it on the worker. */
  unload: () => Promise<unknown>;
  /** The error a failed load is thrown as. */
  error: (message: string) => Error;
}

export type LazyState = "unavailable" | "stopped" | "starting" | "ready" | "error";

/** One model's life on its worker: loaded by the first request that needs it, freed when idle. */
export class LazyModel {
  private isLoaded = false;
  private loading: Promise<void> | null = null;
  private failure: string | undefined;
  /** Requests handed out by `hold` and not released. */
  private pending = 0;
  private idle: Timer | undefined;

  constructor(private readonly options: LazyModelOptions) {}

  get loaded(): boolean {
    return this.isLoaded;
  }

  get state(): LazyState {
    if (this.options.missing()) {
      return "unavailable";
    }
    if (this.isLoaded) {
      return "ready";
    }
    if (this.loading) {
      return "starting";
    }
    return this.failure ? "error" : "stopped";
  }

  get error(): string | undefined {
    return this.options.missing() ?? (this.isLoaded || this.loading ? undefined : this.failure);
  }

  /** Loads the model if it is not loaded, or waits for the load that is under way. Rejects as `options.error`. */
  ready(): Promise<void> {
    if (this.isLoaded) {
      return Promise.resolve();
    }
    this.loading ??= this.load().finally(() => void (this.loading = null));
    return this.loading;
  }

  /** Waits for a load in progress, whatever its outcome. */
  async settled(): Promise<void> {
    await this.loading?.catch(() => {});
  }

  private async load(): Promise<void> {
    const { tag, model } = this.options;
    const started = performance.now();
    let detail: string;
    try {
      detail = await this.options.load();
    } catch (e) {
      this.failure = `the ${model} could not be loaded: ${messageOf(e)}`;
      console.error(`[${tag}] ${this.failure}`);
      throw this.options.error(this.failure);
    }
    this.isLoaded = true;
    this.failure = undefined;
    console.error(`[${tag}] ${model} ready (${Math.round(performance.now() - started)} ms${detail})`);
  }

  /** Marks a request as using the model, so it is not freed under it; the result ends that. */
  hold(): () => void {
    clearTimeout(this.idle);
    this.pending++;
    return () => {
      this.pending--;
      this.unloadWhenIdle();
    };
  }

  /** Frees the model once nothing has been asked of it for the idle time. A failure is recorded and logged. */
  private unloadWhenIdle(): void {
    clearTimeout(this.idle);
    const { tag, model, idleUnload } = this.options;
    if (this.pending > 0 || !this.isLoaded || idleUnload <= 0) {
      return;
    }
    this.idle = setTimeout(() => {
      if (this.pending > 0 || !this.isLoaded) {
        return;
      }
      // A request that arrives from here on loads the model again; the worker frees it first.
      this.isLoaded = false;
      this.options.unload().then(
        () => console.error(`[${tag}] ${model} unloaded after being idle`),
        (e) => {
          this.failure = `the ${model} could not be unloaded: ${messageOf(e)}`;
          console.error(`[${tag}] ${this.failure}`);
        },
      );
    }, idleUnload * 1000);
    this.idle.unref();
  }

  /** The worker freed the model (or is about to) for another use; the next request loads it again. */
  unloaded(): void {
    clearTimeout(this.idle);
    this.isLoaded = false;
  }

  /** The thread holding the model died. */
  workerLost(reason: string): void {
    this.isLoaded = false;
    this.failure = reason;
  }
}

/** The flag of an `abortable` request, read from the shared memory its message carries. */
export const abortFlag = (buffer: SharedArrayBuffer): Int32Array => new Int32Array(buffer);

/** Whether the client has set the flag (`abortable` stores 1). */
export const isAborted = (flag: Int32Array): boolean => Atomics.load(flag, 0) !== 0;

/**
 * Starts a worker thread that runs `file` (next to this module). Not referenced: the server decides when the
 * process ends, not an idle engine thread.
 */
export const startWorker = (file: string): Worker => new Worker(new URL(file, import.meta.url).href, { ref: false });

/**
 * Runs `run` for a request that `signal` can stop. `run` is given the flag, one Int32 in shared memory
 * that the worker (inside its library, reading no messages) checks, and `started`, which it calls when
 * the request is handed to the worker. An abort sets the flag and rejects with the signal's reason at
 * once; `run` is left to finish, since the worker's answer says when it has stopped. `onGiveUp` is
 * called when the abort comes before `started`: the request will never be sent.
 */
export function abortable<T>(
  signal: AbortSignal,
  run: (abort: SharedArrayBuffer, started: () => void) => Promise<T>,
  onGiveUp?: () => void,
): Promise<T> {
  if (signal.aborted) {
    onGiveUp?.();
    return Promise.reject(signal.reason as Error);
  }
  const flag = new Int32Array(new SharedArrayBuffer(4));
  let sent = false;
  const work = run(flag.buffer, () => void (sent = true));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      Atomics.store(flag, 0, 1);
      if (!sent) {
        onGiveUp?.();
      }
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
