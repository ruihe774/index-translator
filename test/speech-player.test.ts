import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type PlayerState, SpeechPlayer, type SpeechSettings, UPDATE_SETTLE_MS } from "../public/speech";
import type { Segment } from "../public/speech-text";

// ---- fakes -----------------------------------------------------------------------------------

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connect() {}
  start(at: number) {
    this.startedAt = at;
  }
  stop() {
    this.stopped = true;
  }
  /** The piece reaches its end. */
  end() {
    this.onended?.();
  }
}

class FakeAudioContext {
  static last: FakeAudioContext;
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  calls: string[] = [];
  state = "running";
  listeners: (() => void)[] = [];
  addEventListener(_type: string, l: () => void) {
    this.listeners.push(l);
  }
  /** The system changes the context's state (iOS: "interrupted"). */
  setState(state: string) {
    this.state = state;
    for (const l of this.listeners) l();
  }
  constructor() {
    FakeAudioContext.last = this;
  }
  resume() {
    this.calls.push("resume");
    return Promise.resolve();
  }
  suspend() {
    this.calls.push("suspend");
    return Promise.resolve();
  }
  decodeAudioData(wav: ArrayBuffer) {
    return Promise.resolve({ wav, duration: 1 });
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data: Float32Array[] = [];
    return {
      channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      data,
      copyToChannel(source: Float32Array, c: number) {
        data[c] = source;
      },
    };
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

interface Request {
  text: string;
  settings: SpeechSettings;
  signal: AbortSignal;
  resolve(): void;
  reject(e: unknown): void;
}

/** A synthesize function whose answers the test gives by hand, or at once with `auto`. */
function makeSynth(auto = false) {
  const requests: Request[] = [];
  const synthesize = (text: string, settings: SpeechSettings, signal: AbortSignal) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const req: Request = {
        text,
        settings,
        signal,
        resolve: () => resolve(new TextEncoder().encode(text).buffer),
        reject,
      };
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      requests.push(req);
      if (auto) req.resolve();
    });
  return { requests, synthesize };
}

const seg = (text: string, line: number, pause = 0): Segment => ({ text, line, pause });
/** Blocks (by line): A = a1 a2, B = b1, C = c1. */
const SEGMENTS = [seg("a1", 0), seg("a2", 0), seg("b1", 2), seg("c1", 4)];
const SETTINGS: SpeechSettings = { lang: "en", voice: "v1", speed: 1 };

const flush = async () => {
  for (let i = 0; i < 5; i++) await Bun.sleep(0);
};
const sleep = (ms: number) => Bun.sleep(ms);

function setup(auto = false) {
  const synth = makeSynth(auto);
  const states: PlayerState[] = [];
  const segments: (Segment | null | undefined)[] = [];
  const errors: unknown[] = [];
  const player = new SpeechPlayer(synth.synthesize, {
    onState: (s) => states.push(s),
    onSegment: (s) => segments.push(s),
    onError: (e) => errors.push(e),
  });
  return { player, states, segments, errors, ...synth, ctx: () => FakeAudioContext.last };
}

const realContext = (globalThis as { AudioContext?: unknown }).AudioContext;
beforeEach(() => {
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
});
afterEach(() => {
  (globalThis as { AudioContext?: unknown }).AudioContext = realContext;
});

// ---- tests -----------------------------------------------------------------------------------

describe("audio that arrives decoded (QOA)", () => {
  test("is put into a buffer of its own, one array per channel, and played like a decoded WAV", async () => {
    const synthesize = () =>
      Promise.resolve({
        sampleRate: 22050,
        channels: 2,
        samples: Int16Array.of(0x4000, -0x8000, 0, 0x7fff),
      });
    const player = new SpeechPlayer(synthesize, {
      onState() {},
      onSegment() {},
      onError: (e) => {
        throw new Error(String(e));
      },
    });
    player.start([seg("a1", 0)], SETTINGS);
    await flush();
    expect(player.state).toBe("playing");
    const buffer = FakeAudioContext.last.sources[0]!.buffer as ReturnType<FakeAudioContext["createBuffer"]>;
    expect(buffer).toMatchObject({ channels: 2, length: 2, sampleRate: 22050 });
    expect(buffer.data.map((c) => [...c])).toEqual([
      [0.5, 0],
      [-1, 0x7fff / 0x8000],
    ]);
  });
});

describe("interruption by the system", () => {
  test("an interrupted context shows as paused, and Resume resumes it", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    expect(t.player.state).toBe("playing");
    t.ctx().setState("interrupted");
    expect(t.player.state).toBe("paused");
    t.ctx().setState("running"); // the system restarts it alone: it stays silent
    expect(t.player.state).toBe("paused");
    expect(t.ctx().calls.at(-1)).toBe("suspend");
    t.player.resume();
    expect(t.ctx().calls.at(-1)).toBe("resume");
    expect(t.player.state).toBe("playing");
  });
});

describe("starting and the state", () => {
  test("loading until the first audio arrives, then playing; starting resumes the context", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    expect(t.player.state).toBe("loading");
    expect(t.ctx().calls).toContain("resume");
    await flush();
    expect(t.requests.map((r) => r.text)).toEqual(["a1"]);
    expect(t.requests[0]!.settings).toEqual(SETTINGS);
    t.requests[0]!.resolve();
    await flush();
    expect(t.player.state).toBe("playing");
    expect(t.states).toEqual(["loading", "playing"]);
    expect(t.segments).toEqual([SEGMENTS[0]]);
    // The next piece is fetched while this one plays.
    expect(t.requests.map((r) => r.text)).toEqual(["a1", "a2"]);
  });

  test("an empty list starts nothing", () => {
    const t = setup();
    t.player.start([], SETTINGS);
    expect(t.player.state).toBe("idle");
    expect(t.player.position()).toBeNull();
    expect(t.requests).toEqual([]);
  });

  test("stop clears the segment and goes idle; a second stop is silent", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.player.stop();
    expect(t.player.state).toBe("idle");
    expect(t.segments.at(-1)).toBeNull();
    const n = t.segments.length;
    t.player.stop();
    expect(t.segments.length).toBe(n);
    expect(t.ctx().sources[0]!.stopped).toBe(true);
  });

  test("reading to the end stops by itself", async () => {
    const t = setup(true);
    t.player.start([seg("only", 0)], SETTINGS);
    await flush();
    t.ctx().sources[0]!.end();
    await flush();
    expect(t.player.state).toBe("idle");
    expect(t.segments.at(-1)).toBeNull();
  });
});

describe("the play state between pieces", () => {
  test("a finished piece no longer counts as playing while the next audio is fetched", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.requests[0]!.resolve();
    await flush();
    expect(t.player.state).toBe("playing");
    // a2 has not arrived when a1 ends: the player is waiting, not playing.
    t.ctx().sources[0]!.end();
    expect(t.player.state).toBe("loading");
    expect(t.states.at(-1)).toBe("loading");
    t.requests[1]!.resolve();
    await flush();
    expect(t.player.state).toBe("playing");
    expect(t.segments.at(-1)).toBe(SEGMENTS[1]);
  });

  test("a piece that was fetched ahead goes on without a visible loading state", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    const before = t.states.length;
    t.ctx().sources[0]!.end();
    await flush();
    expect(t.player.state).toBe("playing");
    expect(t.states.length).toBe(before);
    expect(t.ctx().sources.length).toBe(3); // a1, a2 (now playing) and a3 already lined up behind it
  });

  test("the silence between pieces is scheduled on the audio clock", async () => {
    const t = setup(true);
    t.player.start([seg("a", 0, 250), seg("b", 1)], SETTINGS);
    await flush();
    t.ctx().currentTime = 4;
    t.ctx().sources[0]!.end();
    await flush();
    // The next piece was already lined up behind the first (which started at 0 and lasts 1 s).
    expect(t.ctx().sources[1]!.startedAt).toBeCloseTo(1.25, 5);
  });

  test("a prefetched piece is scheduled behind the current one before it ends", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    const [a1, a2] = t.ctx().sources;
    expect(a1!.startedAt).toBe(0);
    expect(a2!.startedAt).toBeCloseTo(1, 5); // no event needed: 0 + 1 s, no pause
    // It becomes the current piece only once the first has ended.
    expect(t.segments).toEqual([SEGMENTS[0]]);
    a1!.end();
    await flush();
    expect(t.segments).toEqual([SEGMENTS[0], SEGMENTS[1]]);
    expect(t.ctx().sources[1]).toBe(a2); // not created again
    expect(t.ctx().sources[2]!.startedAt).toBeCloseTo(2, 5);
  });

  test("audio that arrives after the piece ended is played by the ended handler, once", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.requests[0]!.resolve();
    await flush();
    t.ctx().sources[0]!.end();
    t.requests[1]!.resolve();
    await flush();
    expect(t.ctx().sources.length).toBe(2);
    expect(t.segments.at(-1)).toBe(SEGMENTS[1]);
  });

  test("a cancel stops the piece that was scheduled ahead", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    const ahead = t.ctx().sources[1]!;
    t.player.stop();
    expect(ahead.stopped).toBe(true);
    expect(ahead.onended).toBeNull();
  });

  test("the source of a finished piece is not stopped later by a cancel", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    const first = t.ctx().sources[0]!;
    first.end();
    await flush();
    t.player.stop();
    expect(first.stopped).toBe(false);
    expect(t.ctx().sources[1]!.stopped).toBe(true);
  });
});

describe("stale work after a cancel", () => {
  test("audio that arrives after stop is dropped and nothing plays", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    const first = t.requests[0]!;
    t.player.stop();
    expect(first.signal.aborted).toBe(true);
    first.resolve(); // too late: its promise was already rejected by the abort
    await flush();
    expect(t.ctx().sources).toEqual([]);
    expect(t.player.state).toBe("idle");
    expect(t.errors).toEqual([]);
  });

  test("the end of a cancelled piece does not start the next one", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    const first = t.ctx().sources[0]!;
    const asked = t.requests.length;
    t.player.stop();
    first.end();
    await flush();
    expect(t.requests.length).toBe(asked);
    expect(t.player.state).toBe("idle");
  });

  test("a restart while the old audio is still being made plays only the new reading", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    const old = t.requests[0]!;
    t.player.start([seg("new", 0)], SETTINGS);
    await flush();
    expect(old.signal.aborted).toBe(true);
    t.requests[1]!.resolve();
    await flush();
    expect(t.ctx().sources.length).toBe(1);
    expect(t.segments.filter(Boolean).map((s) => s!.text)).toEqual(["new"]);
  });

  test("a failure of an abandoned request is not reported", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.player.stop();
    await flush();
    expect(t.errors).toEqual([]);
  });
});

describe("jumping", () => {
  test("a jump to a block whose audio is there plays it at once: no loading, no request", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    // Everything was made ahead while a1 played.
    expect(t.requests.map((r) => r.text)).toEqual(["a1", "a2", "b1", "c1"]);
    const states = t.states.length;
    expect(t.player.jump(1)).toBe(true);
    expect(t.segments.at(-1)).toBe(SEGMENTS[2]);
    expect(t.player.position()).toEqual({ block: 2, blocks: 3 });
    await flush();
    expect(t.player.state).toBe("playing");
    expect(t.states.length).toBe(states);
    expect(t.requests.length).toBe(4);
    // And back: the audio already played was kept.
    expect(t.player.jump(-1)).toBe(true);
    await flush();
    expect(t.player.state).toBe("playing");
    expect(t.segments.at(-1)).toBe(SEGMENTS[0]);
    expect(t.requests.length).toBe(4);
  });

  test("a jump to a block that is not there shows it, stops the request in flight and asks for it", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.requests[0]!.resolve();
    await flush();
    const a2 = t.requests[1]!;
    expect(a2.text).toBe("a2");
    expect(t.player.jump(1)).toBe(true);
    expect(t.segments.at(-1)).toBe(SEGMENTS[2]);
    expect(t.player.state).toBe("loading");
    // a2 is not on the way from b1: its inference is of no use any more.
    expect(a2.signal.aborted).toBe(true);
    expect(t.requests.at(-1)!.text).toBe("b1");
    t.requests.at(-1)!.resolve();
    await flush();
    expect(t.player.state).toBe("playing");
    expect(t.segments.at(-1)).toBe(SEGMENTS[2]);
  });

  test("jumps in a row leave one request, for the block arrived at", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.requests[0]!.resolve();
    await flush();
    t.player.jump(1);
    t.player.jump(1);
    t.player.jump(-1);
    await flush();
    const live = t.requests.filter((r) => !r.signal.aborted).map((r) => r.text);
    expect(live).toEqual(["a1", "b1"]);
    expect(t.errors).toEqual([]);
  });

  test("a jump with nowhere to go returns false and changes nothing", async () => {
    const t = setup(true);
    t.player.start([seg("a", 0)], SETTINGS);
    await flush();
    expect(t.player.jump(1)).toBe(false);
    expect(t.player.jump(-1)).toBe(false);
    expect(t.player.canJump(1)).toBe(false);
    const idle = setup();
    expect(idle.player.jump(1)).toBe(false);
  });

  test("a jump while paused resumes the reading", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.player.pause();
    expect(t.player.state).toBe("paused");
    t.player.jump(1);
    await flush();
    expect(t.player.state).toBe("playing");
    expect(t.ctx().calls.filter((c) => c === "resume").length).toBe(2);
  });

  test("stop after a jump stops the request made for it", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.player.jump(1);
    const asked = t.requests.length;
    t.player.stop();
    await flush();
    expect(t.requests.every((r) => r.signal.aborted)).toBe(true);
    expect(t.requests.length).toBe(asked);
    expect(t.player.state).toBe("idle");
    expect(t.errors).toEqual([]);
  });
});

describe("blockStart, position and canJump", () => {
  test("Previous first returns to the start of the block being read", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.ctx().sources[0]!.end(); // now at a2, the second piece of block A
    await flush();
    expect(t.player.position()).toEqual({ block: 1, blocks: 3 });
    expect(t.player.canJump(-1)).toBe(true); // back to a1
    t.player.jump(-1);
    expect(t.segments.at(-1)).toBe(SEGMENTS[0]);
    expect(t.player.canJump(-1)).toBe(false); // at the start of the first block
    expect(t.player.canJump(1)).toBe(true);
  });

  test("Next goes to the first piece of the next block and stops at the last", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.player.jump(1);
    expect(t.segments.at(-1)).toBe(SEGMENTS[2]);
    t.player.jump(1);
    expect(t.segments.at(-1)).toBe(SEGMENTS[3]);
    expect(t.player.position()).toEqual({ block: 3, blocks: 3 });
    expect(t.player.canJump(1)).toBe(false);
    expect(t.player.jump(1)).toBe(false);
  });

  test("position is null and nothing can be jumped when idle", () => {
    const t = setup();
    expect(t.player.position()).toBeNull();
    expect(t.player.canJump(1)).toBe(false);
    expect(t.player.canJump(-1)).toBe(false);
  });
});

describe("update (voice or speed)", () => {
  test("changes are debounced: several in a row ask for the piece once, with the last settings", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.requests[0]!.resolve();
    await flush();
    const asked = t.requests.length;
    const inFlight = t.requests.at(-1)!;
    t.player.update({ speed: 0.75 });
    t.player.update({ speed: 1.25 });
    t.player.update({ speed: 1.5 });
    // Audio with the old speed is of no use: its request is stopped at once.
    expect(inFlight.signal.aborted).toBe(true);
    expect(t.player.state).toBe("loading");
    await sleep(UPDATE_SETTLE_MS / 2);
    expect(t.requests.length).toBe(asked);
    await sleep(UPDATE_SETTLE_MS);
    const fresh = t.requests.slice(asked).filter((r) => r.text === "a1");
    expect(fresh.length).toBe(1);
    expect(fresh[0]!.settings).toEqual({ ...SETTINGS, speed: 1.5 });
  });

  test("a voice change keeps the current piece", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.ctx().sources[0]!.end();
    await flush();
    const asked = t.requests.length;
    t.player.update({ voice: "v2" });
    await sleep(UPDATE_SETTLE_MS + 100);
    expect(t.requests[asked]!.text).toBe("a2");
    expect(t.requests[asked]!.settings.voice).toBe("v2");
  });

  test("while idle it only remembers the settings for the next start", async () => {
    const t = setup(true);
    t.player.update({ voice: "v9" });
    await sleep(UPDATE_SETTLE_MS + 50);
    expect(t.requests).toEqual([]);
    t.player.start(SEGMENTS, { ...SETTINGS, voice: "v1" });
    await flush();
    expect(t.requests[0]!.settings.voice).toBe("v1"); // start brings its own
  });

  test("while paused the piece is made again but nothing plays until Resume", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.player.pause();
    t.player.update({ speed: 1.5 });
    expect(t.player.state).toBe("paused");
    await sleep(UPDATE_SETTLE_MS + 100);
    expect(t.player.state).toBe("paused");
    expect(t.requests.some((r) => r.settings.speed === 1.5)).toBe(true);
    expect(t.ctx().calls.at(-1)).toBe("suspend");
    t.player.resume();
    expect(t.ctx().calls.at(-1)).toBe("resume");
    expect(t.player.state).not.toBe("paused");
  });

  test("stop during the settle time drops the update", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    const asked = t.requests.length;
    t.player.update({ speed: 2 });
    t.player.stop();
    await sleep(UPDATE_SETTLE_MS + 100);
    expect(t.requests.length).toBe(asked);
  });
});

describe("pause and resume", () => {
  test("pause and resume suspend and resume the clock and report the state", async () => {
    const t = setup(true);
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.player.pause();
    expect(t.player.state).toBe("paused");
    expect(t.ctx().calls.at(-1)).toBe("suspend");
    t.player.pause(); // again: nothing new
    expect(t.states.filter((s) => s === "paused").length).toBe(1);
    t.player.resume();
    expect(t.player.state).toBe("playing");
    t.player.resume();
    expect(t.states.at(-1)).toBe("playing");
  });

  test("pause and resume do nothing when idle", () => {
    const t = setup();
    t.player.pause();
    t.player.resume();
    expect(t.states).toEqual([]);
  });
});

describe("errors", () => {
  test("a failing request stops the player and reports the error once", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    const boom = new Error("boom");
    t.requests[0]!.reject(boom);
    await flush();
    expect(t.errors).toEqual([boom]);
    expect(t.player.state).toBe("idle");
    expect(t.segments.at(-1)).toBeNull();
  });

  test("a failure of the prefetched piece is reported when its turn comes", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.requests[0]!.resolve();
    await flush();
    const boom = new Error("second");
    t.requests[1]!.reject(boom);
    await flush();
    expect(t.errors).toEqual([]); // still playing the first
    expect(t.player.state).toBe("playing");
    t.ctx().sources[0]!.end();
    await flush();
    expect(t.errors).toEqual([boom]);
    expect(t.player.state).toBe("idle");
  });

  test("a piece that cannot be decoded is an error too", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.ctx().decodeAudioData = () => Promise.reject(new Error("bad audio"));
    t.requests[0]!.resolve();
    await flush();
    expect((t.errors[0] as Error).message).toBe("bad audio");
    expect(t.player.state).toBe("idle");
  });

  test("it can start again after an error", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.requests[0]!.reject(new Error("x"));
    await flush();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    t.requests[1]!.resolve();
    await flush();
    expect(t.player.state).toBe("playing");
  });
});

describe("stop during loading", () => {
  test("aborts the request, goes idle and ignores the late answer", async () => {
    const t = setup();
    t.player.start(SEGMENTS, SETTINGS);
    await flush();
    expect(t.player.state).toBe("loading");
    t.player.stop();
    expect(t.requests[0]!.signal.aborted).toBe(true);
    expect(t.player.state).toBe("idle");
    await flush();
    expect(t.ctx().sources).toEqual([]);
    expect(t.errors).toEqual([]);
  });
});
