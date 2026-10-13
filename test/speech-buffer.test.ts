import { describe, expect, test } from "bun:test";
import { AHEAD_SECONDS, blockStarts, KEEP_SECONDS, NEAR_SECONDS, SpeechBuffer } from "../public/speech-buffer";
import type { Segment } from "../public/speech-text";

interface Request {
  text: string;
  signal: AbortSignal;
  resolve(): void;
  reject(e: unknown): void;
}

/**
 * A buffer whose requests the test answers by hand. Every piece is `seconds` long; all texts have
 * the same length, so pieces not made yet are taken to be as long as the ones heard.
 */
function setup(lines: number[], seconds = 10) {
  const segments: Segment[] = lines.map((line, i) => ({ text: `p${String(i).padStart(3, "0")}`, line, pause: 0 }));
  const requests: Request[] = [];
  const synthesize = (text: string, _settings: unknown, signal: AbortSignal) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      requests.push({ text, signal, resolve: () => resolve(new ArrayBuffer(4)), reject });
    });
  const buffer = new SpeechBuffer(synthesize, () => Promise.resolve({ duration: seconds } as AudioBuffer));
  buffer.open(segments, { lang: "en", voice: "v", speed: 1 });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
  };
  /** The requests nobody aborted and nobody answered: at most one, if the buffer keeps its word. */
  const live = () => requests.filter((r) => !r.signal.aborted && !answered.has(r));
  const answered = new Set<Request>();
  /** Answers the request in flight, and the ones that follow, until `count` are done or none is left. */
  const answer = async (count = 1) => {
    for (let n = 0; n < count; n++) {
      const [r] = live();
      if (!r) return;
      answered.add(r);
      r.resolve();
      await flush();
    }
  };
  const index = (r: Request) => Number(r.text.slice(1));
  return { buffer, segments, requests, live, answer, flush, index, asked: () => requests.map(index) };
}

/** `count` pieces, each a block of its own. */
const blocks = (count: number) => Array.from({ length: count }, (_, i) => i);

describe("blockStarts", () => {
  test("a block is a run of pieces with the same line", () => {
    const seg = (line: number): Segment => ({ text: "x", line, pause: 0 });
    expect(blockStarts([seg(0), seg(0), seg(2), seg(4), seg(4)])).toEqual([0, 2, 3]);
    expect(blockStarts([])).toEqual([]);
  });
});

describe("keeping the engine busy", () => {
  test("nothing is asked for until the reader is somewhere", () => {
    const t = setup(blocks(5));
    expect(t.requests).toEqual([]);
  });

  test("one request at a time, the next the moment one arrives, with nobody playing", async () => {
    const t = setup(blocks(30));
    t.buffer.aim(0);
    expect(t.asked()).toEqual([0]);
    await t.answer();
    expect(t.live().length).toBe(1);
    expect(t.requests.length).toBe(2);
    await t.answer(40);
    // It stops by itself once the stretch ahead of the reader is there.
    expect(t.live()).toEqual([]);
    expect(t.requests.every((r) => !r.signal.aborted)).toBe(true);
    expect(t.requests.length).toBe(Math.ceil(AHEAD_SECONDS / 10));
  });

  test("a long piece after a short one is asked for when the short one arrives, not when it is played", async () => {
    const t = setup(blocks(3));
    t.buffer.aim(0);
    await t.answer();
    expect(t.buffer.has(0)).toBe(true);
    expect(t.live().map(t.index)).toEqual([1]);
  });

  test("it goes on when the reader moves into the audio that is there", async () => {
    const t = setup(blocks(30));
    t.buffer.aim(0);
    await t.answer(40);
    const before = t.requests.length;
    t.buffer.aim(1);
    expect(t.requests.length).toBe(before + 1);
    expect(t.index(t.requests.at(-1)!)).toBe(before);
  });
});

describe("the order", () => {
  test("the reader's piece, a safe stretch after it, where the jumps lead, then further ahead", async () => {
    // Blocks: 0-1, 2-4, 5, 6, ...
    const t = setup([0, 0, 2, 2, 2, ...Array.from({ length: 20 }, (_, i) => 5 + i)]);
    t.buffer.aim(3);
    await t.answer(40);
    const near = Math.ceil(NEAR_SECONDS / 10);
    expect(near).toBe(2);
    expect(t.asked().slice(0, 6)).toEqual([
      3, // where the reader is
      4, // NEAR_SECONDS from there
      5, // Next: the next block
      2, // Previous: the start of this block
      0, // Previous again: the block before
      6, // and on
    ]);
  });

  test("audio already made is not asked for again after a jump back", async () => {
    const t = setup(blocks(30));
    t.buffer.aim(0);
    await t.answer(4);
    const before = t.requests.length;
    t.buffer.aim(2);
    t.buffer.aim(0);
    await t.flush();
    expect(t.requests.length).toBe(before);
    expect(await t.buffer.take(0)).toEqual({ duration: 10 } as AudioBuffer);
  });
});

describe("stale requests", () => {
  test("a request for a piece the reader has left behind is aborted, and the wanted one asked for", async () => {
    const t = setup(blocks(60));
    t.buffer.aim(0);
    await t.answer(3);
    const flight = t.live()[0]!;
    t.buffer.aim(40);
    expect(flight.signal.aborted).toBe(true);
    expect(t.live().map(t.index)).toEqual([40]);
  });

  test("a request that is still wanted gives way when the reader waits for another piece", async () => {
    const t = setup(blocks(60));
    t.buffer.aim(5);
    await t.answer(2); // 5 and 6 are there: the safe stretch, and where Next leads
    const flight = t.live()[0]!;
    expect(t.index(flight)).toBe(4); // where Previous leads
    t.buffer.aim(7);
    // 4 is no jump target from 7 any more.
    expect(flight.signal.aborted).toBe(true);
    expect(t.live().map(t.index)).toEqual([7]);
    // 8 is wanted from 6 as well as from 7, but the reader at 6 has its audio: it stays.
    await t.answer();
    const eight = t.live()[0]!;
    expect(t.index(eight)).toBe(8);
    t.buffer.aim(6);
    expect(eight.signal.aborted).toBe(false);
    // The reader at 3 has none, and 8 is not it.
    t.buffer.aim(3);
    expect(eight.signal.aborted).toBe(true);
    expect(t.live().map(t.index)).toEqual([3]);
  });

  test("the request for the piece the reader waits for is never aborted by aiming at it again", () => {
    const t = setup(blocks(10));
    t.buffer.aim(2);
    t.buffer.aim(2);
    t.buffer.aim(2);
    expect(t.requests.length).toBe(1);
    expect(t.requests[0]!.signal.aborted).toBe(false);
  });

  test("an answer that comes after the abort is dropped", async () => {
    const t = setup(blocks(60));
    t.buffer.aim(0);
    const first = t.requests[0]!;
    t.buffer.aim(40);
    first.resolve();
    await t.flush();
    expect(t.buffer.has(0)).toBe(false);
  });

  test("open with new settings aborts the request and forgets the audio", async () => {
    const t = setup(blocks(10));
    t.buffer.aim(0);
    await t.answer();
    const flight = t.live()[0]!;
    t.buffer.open(t.segments, { lang: "en", voice: "other", speed: 1 });
    expect(flight.signal.aborted).toBe(true);
    expect(t.buffer.has(0)).toBe(false);
    expect(t.live()).toEqual([]);
  });
});

describe("take", () => {
  test("resolves when the piece arrives, and at once when it is there", async () => {
    const t = setup(blocks(3));
    t.buffer.aim(0);
    const taken = t.buffer.take(0);
    await t.answer();
    expect((await taken).duration).toBe(10);
    expect((await t.buffer.take(0)).duration).toBe(10);
  });

  test("a failed piece is refused when it is taken, and nothing beyond it is made", async () => {
    const t = setup(blocks(10));
    t.buffer.aim(0);
    await t.answer();
    const boom = new Error("boom");
    t.live()[0]!.reject(boom);
    await t.flush();
    await expect(t.buffer.take(1)).rejects.toBe(boom);
    // Nothing beyond the failed piece can be reached by reading on, so nothing there is made.
    expect(t.requests.length).toBe(2);
  });

  test("when the piece the reader waits for fails, nothing more is asked for", async () => {
    const t = setup(blocks(10));
    t.buffer.aim(0);
    const taken = t.buffer.take(0);
    const boom = new Error("boom");
    t.requests[0]!.reject(boom);
    await expect(taken).rejects.toBe(boom);
    await t.flush();
    expect(t.requests.length).toBe(1);
  });

  test("close refuses the pieces waited for and aborts the request", async () => {
    const t = setup(blocks(3));
    t.buffer.aim(0);
    const taken = t.buffer.take(0);
    t.buffer.close();
    await expect(taken).rejects.toThrow("stopped");
    expect(t.requests[0]!.signal.aborted).toBe(true);
    t.buffer.aim(0);
    expect(t.requests.length).toBe(1);
  });
});

describe("what is kept", () => {
  test("beyond KEEP_SECONDS the pieces farthest behind the reader go, the jump targets stay", async () => {
    const seconds = 50;
    const t = setup(blocks(40), seconds);
    // Reading on, block by block.
    for (let i = 0; i < 12; i++) {
      t.buffer.aim(i);
      await t.answer(10);
    }
    const held = t.segments.map((_, i) => i).filter((i) => t.buffer.has(i));
    expect(held.length * seconds).toBeLessThanOrEqual(KEEP_SECONDS);
    expect(held).not.toContain(0);
    // Previous from 11 leads to 10; reading on needs 11 and 12; Next leads to 12.
    expect(held).toEqual(expect.arrayContaining([10, 11, 12]));
  });
});
