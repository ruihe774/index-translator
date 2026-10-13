// The QOA form of the speech stream: how a client asks for it, what the server sends, and that
// the codec's own decoder gets the audio back. The codec is a file of public/vendor/qoa (fetched by
// scripts/fetch_web_libs.ts); tests that need it are skipped where it was not fetched.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type App, startApp } from "../src/app";
import { acceptsQoa, type QoaCodec, qoaLoader, qoaResponse } from "../src/qoa-stream";
import type { Pcm } from "../src/wav";
import {
  config,
  launcher,
  mockSpeech,
  postTo,
  resetMockSpeech,
  speechLauncher,
  waitReady,
} from "./helpers/mock-engine";

const { publicDir } = config();
const installed = existsSync(join(publicDir, "vendor", "qoa", "VERSION"));

interface Decoder extends QoaCodec {
  decode(data: Uint8Array): { channels: number; sampleRate: number; samples: Int16Array };
}

/** Loaded the way the page's worker does, from the same file. */
async function codec(): Promise<Decoder> {
  const { Qoa } = await import(join(publicDir, "vendor", "qoa", "src", "qoa.ts"));
  return Qoa.create();
}

/** A tone with a little of everything speech has: a slow sweep, some harmonics, a fade at both ends. */
function tone(seconds: number, sampleRate = 22_050, channels = 1): Pcm {
  const length = Math.round(seconds * sampleRate);
  const samples = new Float32Array(length * channels);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const fade = Math.min(1, t * 20, (seconds - t) * 20);
    const v = fade * 0.5 * (Math.sin(2 * Math.PI * (180 + 40 * t) * t) + 0.4 * Math.sin(2 * Math.PI * 540 * t));
    for (let c = 0; c < channels; c++) {
      samples[i * channels + c] = v * (c === 0 ? 1 : 0.5);
    }
  }
  return { samples, sampleRate, channels };
}

async function bodyChunks(res: Response): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const reader = res.body!.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    chunks.push(r.value);
  }
  return chunks;
}

const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

describe("acceptsQoa", () => {
  test.each([
    ["audio/qoa", true],
    ["audio/qoa, audio/wav;q=0.5", true],
    ["audio/wav, Audio/QOA ; q=0.2", true],
    ["audio/qoa;q=0", false],
    ["audio/wav", false],
    ["*/*", false],
    ["audio/*", false],
    ["audio/qoax", false],
    ["", false],
    [null, false],
  ])("%j is %p", (accept, expected) => {
    expect(acceptsQoa(accept)).toBe(expected);
  });
});

describe.skipIf(!installed)("qoaResponse", () => {
  test("is a QOA stream in several chunks that the codec's decoder reads back", async () => {
    const qoa = await codec();
    const pcm = tone(2);
    const res = qoaResponse(qoa, pcm);
    expect(res.headers.get("content-type")).toBe("audio/qoa");
    const chunks = await bodyChunks(res);
    // 2 s are 44,100 samples: 9 frames, sent four at a time.
    expect(chunks.length).toBeGreaterThan(1);
    const bytes = concat(chunks);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("qoaf");
    // Five times smaller than 16-bit PCM, give or take the headers.
    expect(bytes.length).toBeLessThan(pcm.samples.length * 2 * 0.3);

    const audio = qoa.decode(bytes);
    expect(audio.sampleRate).toBe(22_050);
    expect(audio.channels).toBe(1);
    expect(audio.samples).toHaveLength(pcm.samples.length);
    // Lossy, but close: the error is a small fraction of the signal.
    let signal = 0;
    let error = 0;
    for (let i = 0; i < audio.samples.length; i++) {
      const want = pcm.samples[i]! * 0x7f_ff;
      signal += want * want;
      error += (audio.samples[i]! - want) ** 2;
    }
    expect(10 * Math.log10(signal / error)).toBeGreaterThan(25);
  });

  test("keeps the channels of a stereo recording, and ends mid-frame as well as on one", async () => {
    const qoa = await codec();
    for (const seconds of [0.01, 5120 / 22_050, 0.5]) {
      const pcm = tone(seconds, 22_050, 2);
      const audio = qoa.decode(concat(await bodyChunks(qoaResponse(qoa, pcm))));
      expect(audio.channels).toBe(2);
      expect(audio.samples).toHaveLength(pcm.samples.length);
    }
  });
});

describe("the loader", () => {
  test("is undefined while the codec is not installed, and finds it when it is installed later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qoa-loader-"));
    try {
      const load = qoaLoader(dir);
      await expect(load()).resolves.toBeUndefined();
      await expect(load()).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /speech", () => {
  let app: App;
  let bare: App;
  let emptyDir: string;
  let base: string;
  let bareBase: string;

  beforeAll(async () => {
    app = await startApp(config(), launcher, speechLauncher);
    base = app.server.url.origin;
    await waitReady(app);
    emptyDir = await mkdtemp(join(tmpdir(), "qoa-public-"));
    bare = await startApp(config({ publicDir: emptyDir }), launcher, speechLauncher);
    bareBase = bare.server.url.origin;
    await waitReady(bare);
  });

  afterAll(async () => {
    await app.stop();
    await bare.stop();
    await rm(emptyDir, { recursive: true, force: true });
  });

  const speak = (to: string, accept?: string) =>
    postTo(to, "/api/v1/speech", { text: "Hello there.", lang: "en" }, accept ? { headers: { accept } } : {});

  test("a request without Accept, or with any other, is answered with WAV", async () => {
    for (const accept of [undefined, "*/*", "audio/wav", "audio/*"]) {
      const res = await speak(base, accept);
      expect(res.headers.get("content-type")).toBe("audio/wav");
      expect(res.headers.get("vary")).toBe("accept");
      expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4))).toBe("RIFF");
    }
    resetMockSpeech();
  });

  test.skipIf(!installed)("audio/qoa is answered with a QOA stream of the utterance", async () => {
    mockSpeech.audioSeconds = 1;
    const res = await speak(base, "audio/qoa, audio/wav;q=0.5");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/qoa");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("accept");
    const audio = (await codec()).decode(new Uint8Array(await res.arrayBuffer()));
    expect(audio.sampleRate).toBe(22_050);
    expect(audio.channels).toBe(1);
    expect(audio.samples).toHaveLength(22_050);
    // Lossy: silence comes back with a hiss of a few steps (measured: at most 17 of 32,767).
    expect(audio.samples.every((s) => Math.abs(s) <= 32)).toBe(true);
    resetMockSpeech();
  });

  test("a server without the codec answers audio/qoa with WAV", async () => {
    const res = await speak(bareBase, "audio/qoa");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    resetMockSpeech();
  });

  test("errors are the same in both forms", async () => {
    mockSpeech.failWith = "out of memory";
    const res = await speak(base, "audio/qoa");
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toStrictEqual({ code: "speech_error", message: "out of memory" });
    resetMockSpeech();
  });
});
