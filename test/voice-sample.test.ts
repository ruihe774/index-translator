/* eslint-disable @typescript-eslint/await-thenable */
// Microphone recording and WAV encoding for voice samples (public/voice-sample.ts), with fakes.

import { describe, expect, test } from "bun:test";

import { encodeWav, type MicMediaRecorder, MicRecorder, type MicStream } from "../public/mic-recorder";
import { readWav } from "../src/wav";

class FakeTrack {
  stopped = 0;
  stop() {
    this.stopped++;
  }
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

interface Rig {
  streams: FakeStream[];
  recorders: FakeRecorder[];
  /** Resolves or rejects the pending getUserMedia calls, oldest first. */
  gum: { resolve: () => void; reject: (e: unknown) => void }[];
  mode: { construct?: Error; start?: Error; stop?: Error; silentStop?: boolean; stopEmits?: "stop" | "error" };
  mic: MicRecorder;
}

class FakeRecorder {
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly stream: FakeStream,
    private rig: { mode: Rig["mode"] },
  ) {
    if (rig.mode.construct) {
      throw rig.mode.construct;
    }
  }
  start() {
    if (this.rig.mode.start) {
      throw this.rig.mode.start;
    }
    this.state = "recording";
  }
  stop() {
    if (this.rig.mode.stop) {
      throw this.rig.mode.stop;
    }
    this.state = "inactive";
    if (this.rig.mode.silentStop) {
      return;
    }
    queueMicrotask(() => {
      if (this.rig.mode.stopEmits === "error") {
        return this.onerror?.();
      }
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
      this.onstop?.();
    });
  }
}

function rig(limitMs = 60_000): Rig {
  const r = { streams: [], recorders: [], gum: [], mode: {} } as unknown as Rig;
  r.mic = new MicRecorder({
    limitMs,
    mediaDevices: {
      getUserMedia: () =>
        new Promise<MicStream>((resolve, reject) => {
          const stream = new FakeStream();
          r.streams.push(stream);
          r.gum.push({ resolve: () => resolve(stream), reject });
        }),
    },
    MediaRecorder: class extends FakeRecorder {
      constructor(stream: MicStream) {
        super(stream as FakeStream, r);
        r.recorders.push(this);
      }
    } as unknown as new (stream: MicStream) => MicMediaRecorder,
  });
  return r;
}

const stopped = (s: FakeStream) => s.tracks.every((t) => t.stopped > 0);
const tick = () => Bun.sleep(0);

describe("MicRecorder", () => {
  test("records, then stop returns the bytes and releases the microphone", async () => {
    const r = rig();
    const started = r.mic.start(() => {});
    expect(r.mic.starting).toBe(true);
    expect(r.mic.recording).toBe(false);
    r.gum[0]!.resolve();
    await started;
    expect(r.mic.starting).toBe(false);
    expect(r.mic.recording).toBe(true);
    const bytes = await r.mic.stop();
    expect(new Uint8Array(bytes)).toStrictEqual(new Uint8Array([1, 2, 3]));
    expect(stopped(r.streams[0]!)).toBe(true);
    expect(r.mic.recording).toBe(false);
    expect(r.mic.stopping).toBe(false);
  });

  test("a second start during the permission prompt is refused and opens no second stream", async () => {
    const r = rig();
    const first = r.mic.start(() => {});
    await expect(r.mic.start(() => {})).rejects.toThrow("Already recording.");
    expect(r.gum).toHaveLength(1);
    r.gum[0]!.resolve();
    await first;
    await expect(r.mic.start(() => {})).rejects.toThrow("Already recording.");
    expect(r.streams).toHaveLength(1);
    await r.mic.stop();
  });

  test("a denied prompt is reported and the recorder can start again", async () => {
    const r = rig();
    const started = r.mic.start(() => {});
    r.gum[0]!.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    await expect(started).rejects.toThrow(/denied/);
    expect(r.mic.starting).toBe(false);
    const again = r.mic.start(() => {});
    r.gum[1]!.resolve();
    await again;
    expect(r.mic.recording).toBe(true);
    await r.mic.stop();
  });

  test("a missing microphone is reported", async () => {
    const r = rig();
    const started = r.mic.start(() => {});
    r.gum[0]!.reject(Object.assign(new Error("x"), { name: "NotFoundError" }));
    await expect(started).rejects.toThrow("No microphone was found.");
  });

  test("without getUserMedia or MediaRecorder it says so and opens nothing", async () => {
    const mic = new MicRecorder({ mediaDevices: {} });
    await expect(mic.start(() => {})).rejects.toThrow(/cannot record/);
    expect(mic.starting).toBe(false);
  });

  for (const [what, mode] of [
    ["the MediaRecorder constructor throws", { construct: new Error("unsupported") }],
    ["MediaRecorder.start throws", { start: new Error("InvalidStateError") }],
  ] as const) {
    test(`the tracks are stopped when ${what}`, async () => {
      const r = rig();
      r.mode = { ...mode };
      const started = r.mic.start(() => {});
      r.gum[0]!.resolve();
      await expect(started).rejects.toThrow();
      expect(stopped(r.streams[0]!)).toBe(true);
      expect(r.mic.recording).toBe(false);
      expect(r.mic.starting).toBe(false);
    });
  }

  test("stop without a recording rejects", async () => {
    await expect(rig().mic.stop()).rejects.toThrow("Not recording.");
  });

  test("stop settles and releases the tracks when MediaRecorder.stop throws", async () => {
    const r = rig();
    const started = r.mic.start(() => {});
    r.gum[0]!.resolve();
    await started;
    r.mode.stop = new Error("InvalidStateError");
    await expect(r.mic.stop()).rejects.toThrow("InvalidStateError");
    expect(stopped(r.streams[0]!)).toBe(true);
    expect(r.mic.stopping).toBe(false);
  });

  test("stop rejects, and releases the tracks, when the recorder reports an error", async () => {
    const r = rig();
    const started = r.mic.start(() => {});
    r.gum[0]!.resolve();
    await started;
    r.mode.stopEmits = "error";
    await expect(r.mic.stop()).rejects.toThrow("The recording failed.");
    expect(stopped(r.streams[0]!)).toBe(true);
  });

  test("stop does not hang when the browser already ended the recording", async () => {
    const r = rig();
    const started = r.mic.start(() => {});
    r.gum[0]!.resolve();
    await started;
    r.recorders[0]!.state = "inactive"; // e.g. the microphone was unplugged
    expect(r.mic.recording).toBe(false);
    await r.mic.stop();
    expect(stopped(r.streams[0]!)).toBe(true);
  });

  test("calling stop twice shares one result", async () => {
    const r = rig();
    const started = r.mic.start(() => {});
    r.gum[0]!.resolve();
    await started;
    const a = r.mic.stop();
    expect(r.mic.stopping).toBe(true);
    expect(r.mic.stop()).toBe(a);
    await a;
    await expect(r.mic.stop()).rejects.toThrow("Not recording.");
  });

  test("the length limit fires once, and stop cancels it", async () => {
    const r = rig(10);
    let limits = 0;
    const started = r.mic.start(() => limits++);
    r.gum[0]!.resolve();
    await started;
    await Bun.sleep(40);
    expect(limits).toBe(1);
    await r.mic.stop();

    const r2 = rig(10);
    let limits2 = 0;
    const s2 = r2.mic.start(() => limits2++);
    r2.gum[0]!.resolve();
    await s2;
    await r2.mic.stop();
    await Bun.sleep(40);
    expect(limits2).toBe(0);
    await tick();
  });
});

describe("encodeWav", () => {
  test("round-trips through readWav", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const pcm = readWav(new Uint8Array(encodeWav(samples, 24_000)));
    expect(pcm.sampleRate).toBe(24_000);
    expect(pcm.channels).toBe(1);
    expect(pcm.samples).toHaveLength(samples.length);
    samples.forEach((v, i) => {
      expect(Math.abs(pcm.samples[i]! - v)).toBeLessThan(1 / 16_000);
    });
  });

  test("clips out-of-range samples; a header without samples is rejected by the reader", () => {
    const pcm = readWav(new Uint8Array(encodeWav(new Float32Array([2, -2]), 16_000)));
    expect(pcm.samples[0]).toBeCloseTo(1, 3);
    expect(pcm.samples[1]).toBe(-1);
    expect(() => readWav(new Uint8Array(encodeWav(new Float32Array(0), 16_000)))).toThrow("no audio");
  });
});
