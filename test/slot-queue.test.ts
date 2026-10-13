import { describe, expect, test } from "bun:test";

import { QueueFullError, SlotQueue } from "../src/queue";

/** Lets every pending promise callback run (a macrotask, so all microtasks drain first). */
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("SlotQueue admission", () => {
  test("with no waiting room the first request runs and the second is refused", () => {
    const q = new SlotQueue(0);
    const calls: number[] = [];
    const a = q.enter((p) => calls.push(p));
    expect(q.running).toBe(true);
    expect(q.depth).toBe(0);
    expect(calls).toEqual([]);

    expect(() => q.enter()).toThrow(QueueFullError);
    expect(q.running).toBe(true);
    expect(q.depth).toBe(0);

    a.leave();
    expect(q.running).toBe(false);
  });

  test("enter after the active ticket leaves is granted", async () => {
    const q = new SlotQueue(0);
    const a = q.enter();
    a.leave();
    const b = q.enter();
    expect(await b.ready).toBe(true);
    expect(q.running).toBe(true);
    b.leave();
    expect(q.running).toBe(false);
  });

  test("leaving the active ticket with no waiters frees the slot", () => {
    const q = new SlotQueue(2);
    const a = q.enter();
    a.leave();
    expect(q.running).toBe(false);
    expect(q.depth).toBe(0);
    expect(() => q.enter()).not.toThrow();
  });

  test("a ticket granted immediately is ready as true on the same microtask tick", async () => {
    const q = new SlotQueue(1);
    const t = q.enter();
    let granted: boolean | undefined;
    void t.ready.then((v) => (granted = v));
    await Promise.resolve();
    expect(granted).toBe(true);
    t.leave();
  });

  test("QueueFullError has a fixed message and is an Error", () => {
    const err = new QueueFullError();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("translation queue is full");

    const q = new SlotQueue(0);
    q.enter();
    try {
      q.enter();
      throw new Error("expected enter to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QueueFullError);
      expect((error as Error).message).toBe("translation queue is full");
    }
  });
});

describe("SlotQueue leave", () => {
  test("a double leave of a waiting ticket is a no-op", async () => {
    const q = new SlotQueue(3);
    const a = q.enter();
    const b = q.enter();
    const c = q.enter();
    const d = q.enter();
    b.leave();
    b.leave();
    expect(q.depth).toBe(2);
    expect(await b.ready).toBe(false);

    a.leave();
    expect(await c.ready).toBe(true);
    expect(q.depth).toBe(1);
    c.leave();
    expect(await d.ready).toBe(true);
    d.leave();
    expect(q.running).toBe(false);
  });

  test("a double leave of the active ticket does not grant the next one twice", async () => {
    const q = new SlotQueue(2);
    const a = q.enter();
    const b = q.enter();
    const c = q.enter();
    a.leave();
    a.leave();
    expect(await b.ready).toBe(true);
    expect(q.depth).toBe(1);

    let cGranted = false;
    void c.ready.then((v) => (cGranted = v));
    await flush();
    expect(cGranted).toBe(false);

    b.leave();
    expect(await c.ready).toBe(true);
    c.leave();
    expect(q.running).toBe(false);
  });

  test("a waiting ticket that leaves is not granted and does not block those behind it", async () => {
    const q = new SlotQueue(3);
    const a = q.enter();
    const b = q.enter();
    const c = q.enter();
    const d = q.enter();

    b.leave();
    expect(await b.ready).toBe(false);

    a.leave();
    expect(await c.ready).toBe(true);
    c.leave();
    expect(await d.ready).toBe(true);
    d.leave();
    expect(q.running).toBe(false);
    expect(q.depth).toBe(0);
  });
});

describe("SlotQueue ordering", () => {
  test("20 requests run one at a time in FIFO order", async () => {
    const q = new SlotQueue(19);
    const tickets = Array.from({ length: 20 }, () => q.enter());
    expect(q.depth).toBe(19);
    expect(() => q.enter()).toThrow(QueueFullError);

    const log: string[] = [];
    await Promise.all(
      tickets.map(async (t, i) => {
        expect(await t.ready).toBe(true);
        expect(q.running).toBe(true);
        log.push(`start ${i}`);
        await flush();
        log.push(`end ${i}`);
        t.leave();
      }),
    );

    const expected = Array.from({ length: 20 }, (_, i) => [`start ${i}`, `end ${i}`]).flat();
    expect(log).toEqual(expected);
    expect(q.running).toBe(false);
    expect(q.depth).toBe(0);
  });
});

describe("SlotQueue onPosition", () => {
  test("the initial position is the number of requests ahead, including the running one", () => {
    const q = new SlotQueue(5);
    const pos = { a: [] as number[], b: [] as number[], c: [] as number[], d: [] as number[] };
    q.enter((p) => pos.a.push(p));
    q.enter((p) => pos.b.push(p));
    q.enter((p) => pos.c.push(p));
    q.enter((p) => pos.d.push(p));
    expect(pos).toEqual({ a: [], b: [1], c: [2], d: [3] });
  });

  test("positions update when someone ahead leaves, whether waiting or active", () => {
    const q = new SlotQueue(5);
    const pos = { a: [] as number[], b: [] as number[], c: [] as number[], d: [] as number[] };
    const a = q.enter((p) => pos.a.push(p));
    const b = q.enter((p) => pos.b.push(p));
    q.enter((p) => pos.c.push(p));
    q.enter((p) => pos.d.push(p));

    b.leave();
    expect(pos).toEqual({ a: [], b: [1], c: [2, 1], d: [3, 2] });

    a.leave(); // the active ticket leaves: c is granted and d moves up to 1
    expect(pos).toEqual({ a: [], b: [1], c: [2, 1], d: [3, 2, 1] });
  });

  test("a ticket that has left or been granted gets no further callbacks", () => {
    const q = new SlotQueue(5);
    const pos = { b: [] as number[], c: [] as number[], d: [] as number[] };
    const a = q.enter();
    const b = q.enter((p) => pos.b.push(p));
    const c = q.enter((p) => pos.c.push(p));
    q.enter((p) => pos.d.push(p));

    b.leave();
    a.leave(); // c is granted; d moves up to 1
    expect(pos).toEqual({ b: [1], c: [2, 1], d: [3, 2, 1] });

    c.leave(); // granted ticket leaves: d is granted, no callbacks for c or b
    expect(pos).toEqual({ b: [1], c: [2, 1], d: [3, 2, 1] });
    expect(q.depth).toBe(0);
  });
});

describe("SlotQueue state getters", () => {
  test("depth and running follow the lifecycle", () => {
    const q = new SlotQueue(2);
    expect(q.running).toBe(false);
    expect(q.depth).toBe(0);

    const a = q.enter();
    expect(q.running).toBe(true);
    expect(q.depth).toBe(0);

    const b = q.enter();
    const c = q.enter();
    expect(q.depth).toBe(2);

    b.leave();
    expect(q.depth).toBe(1);

    a.leave();
    expect(q.running).toBe(true);
    expect(q.depth).toBe(0);

    c.leave();
    expect(q.running).toBe(false);
    expect(q.depth).toBe(0);
  });
});

describe("SlotQueue observer errors", () => {
  test("a throwing onPosition does not leave a ghost ticket holding the slot", () => {
    // enter() queues the entry before calling onPosition, so it must take the entry back out on a throw.
    const q = new SlotQueue(2);
    const a = q.enter();
    expect(() =>
      q.enter(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    a.leave();
    expect(q.running).toBe(false);
  });
});
