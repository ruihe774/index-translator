// The page's side of a worker's request and reply: the requests still waiting for their answer,
// the id each is sent under, and what happens to all of them when the worker is gone.
// Each caller wires its own worker's messages to `take` and its errors to `fail`.

export interface Pending<T> {
  resolve(reply: T): void;
  reject(error: unknown): void;
}

export interface WorkerClient<T> {
  /** The error every later request fails with, once `fail` ran. */
  readonly dead: Error | undefined;
  /** Registers a request and runs `send` with its id (at once); `take` settles it. Fails when dead. */
  request(send: (id: number) => void): Promise<T>;
  /** The request waiting under `id`, which is no longer waiting. */
  take(id: number): Pending<T> | undefined;
  /** Rejects every waiting request and every later one with `error`. */
  fail(error: Error): void;
}

export function workerClient<T>(): WorkerClient<T> {
  const waiting = new Map<number, Pending<T>>();
  let next = 0;
  let dead: Error | undefined;
  return {
    get dead() {
      return dead;
    },
    request(send) {
      if (dead) {
        return Promise.reject(dead);
      }
      const id = next++;
      return new Promise<T>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        send(id);
      });
    },
    take(id) {
      const pending = waiting.get(id);
      waiting.delete(id);
      return pending;
    },
    fail(error) {
      dead = error;
      for (const pending of waiting.values()) {
        pending.reject(error);
      }
      waiting.clear();
    },
  };
}
