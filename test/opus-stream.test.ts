// The Ogg Opus form of the speech stream: how a client asks for it, the muxer's pages, what the
// server sends, and that libopus's own decoder gets the audio back. That a browser decodes it is
// e2e/speech.spec.ts's test. The tests that encode need libopus and libsoxr (bun scripts/build_libopus.ts,
// build_soxr.ts) and are skipped without them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { acceptWeight } from "../src/accept";
import { type App, startApp } from "../src/app";
import { OggOpusMuxer, type OpusPacket } from "../src/ogg-opus";
import { OpusDecoder, opusDir, opusLibraryPath } from "../src/opus-ffi";
import { opusLoader, opusResponse } from "../src/opus-stream";
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

const audioDir = join(import.meta.dir, "..", "vendor", "audio.cpp");
const installed = existsSync(opusLibraryPath(opusDir(audioDir))) && existsSync(join(audioDir, "..", "soxr", "VERSION"));
const identity = (samples: Float32Array) => samples;

interface Page {
  flags: number;
  granule: number;
  serial: number;
  sequence: number;
  /** The packets that end in this page (a page here never ends inside one). */
  packets: Uint8Array[];
  crcOk: boolean;
}

/** Ogg's CRC-32 written the slow way, apart from the muxer's table. */
function crc(bytes: Uint8Array): number {
  let c = 0;
  for (const byte of bytes) {
    c ^= byte << 24;
    for (let i = 0; i < 8; i++) {
      c = (c & 0x80_00_00_00 ? (c << 1) ^ 0x04_c1_1d_b7 : c << 1) >>> 0;
    }
  }
  return c >>> 0;
}

function pages(bytes: Uint8Array): Page[] {
  const out: Page[] = [];
  for (let at = 0; at < bytes.length;) {
    expect(new TextDecoder().decode(bytes.subarray(at, at + 4))).toBe("OggS");
    const view = new DataView(bytes.buffer, bytes.byteOffset + at);
    const count = view.getUint8(26);
    const lacing = bytes.subarray(at + 27, at + 27 + count);
    const length = 27 + count + lacing.reduce((n, l) => n + l, 0);
    const whole = bytes.slice(at, at + length);
    const stored = new DataView(whole.buffer).getUint32(22, true);
    new DataView(whole.buffer).setUint32(22, 0, true);
    const packets: Uint8Array[] = [];
    let from = at + 27 + count;
    let size = 0;
    for (const l of lacing) {
      size += l;
      if (l < 255) {
        packets.push(bytes.slice(from, from + size));
        from += size;
        size = 0;
      }
    }
    out.push({
      flags: view.getUint8(5),
      granule: Number(view.getBigUint64(6, true)),
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      packets,
      crcOk: crc(whole) === stored,
    });
    at += length;
  }
  return out;
}

async function bodyChunks(res: Response): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const reader = res.body!.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    chunks.push(r.value as Uint8Array);
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

function tone(seconds: number, sampleRate: number, channels = 1): Pcm {
  const length = Math.round(seconds * sampleRate);
  const samples = new Float32Array(length * channels);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    for (let c = 0; c < channels; c++) {
      samples[i * channels + c] = 0.4 * Math.sin(2 * Math.PI * (200 + 50 * t) * t) * (c === 0 ? 1 : 0.5);
    }
  }
  return { samples, sampleRate, channels };
}

describe("acceptWeight", () => {
  test.each([
    ["audio/ogg", 1],
    ["audio/ogg, audio/wav;q=0.5", 1],
    ["audio/wav, Audio/OGG ; q=0.2", 0.2],
    ["audio/ogg;codecs=opus", 1],
    ["audio/ogg;q=0", 0],
    ["audio/wav", 0],
    ["*/*", 0],
    ["audio/*", 0],
    ["audio/oggx", 0],
    ["", 0],
    [null, 0],
  ])("%j gives %p", (accept, expected) => {
    expect(acceptWeight(accept, "audio/ogg")).toBe(expected);
  });
});

describe("the muxer", () => {
  const packet = (size: number, validDuration = 960): OpusPacket => ({
    data: new Uint8Array(size).fill(size & 0xff),
    duration: 960,
    validDuration,
  });

  test("writes OpusHead and OpusTags, then pages that end where their audio ends", () => {
    const mux = new OggOpusMuxer({ channels: 1, sampleRate: 22_050, preSkip: 312, serial: 7, maxPageDuration: 2880 });
    const bytes = [mux.header()];
    for (let i = 0; i < 7; i++) {
      bytes.push(mux.addPacket(packet(40 + i, i === 6 ? 500 : 960)));
    }
    bytes.push(mux.finish(), mux.finish());
    const all = pages(concat(bytes));

    expect(all.every((p) => p.crcOk && p.serial === 7)).toBe(true);
    expect(all.map((p) => p.sequence)).toStrictEqual(all.map((_, i) => i));
    expect(all.map((p) => p.flags)).toStrictEqual([0x02, 0, 0, 0, 0x04]);
    const head = all[0]!.packets[0]!;
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe("OpusHead");
    expect(new DataView(head.buffer).getUint16(10, true)).toBe(312);
    expect(new DataView(head.buffer).getUint32(12, true)).toBe(22_050);
    expect(new TextDecoder().decode(all[1]!.packets[0]!.subarray(0, 8))).toBe("OpusTags");
    // Three packets to a page; the granule is the end of the page's last packet, less what the
    // last packet was padded by.
    expect(all.slice(2).map((p) => p.packets.length)).toStrictEqual([3, 3, 1]);
    expect(all.slice(2).map((p) => p.granule)).toStrictEqual([2880, 5760, 6260]);
  });

  test("splits a long packet over segments and closes a page before 255 of them", () => {
    const mux = new OggOpusMuxer({ channels: 1, sampleRate: 16_000, preSkip: 0, maxPageDuration: 1e9 });
    const sizes = [600, 254, 255, 256, 1000, 100, 100, 100];
    const bytes = [mux.header()];
    for (let i = 0; i < 200; i++) {
      bytes.push(mux.addPacket(packet(sizes[i % sizes.length]!)));
    }
    bytes.push(mux.finish());
    const all = pages(concat(bytes)).slice(2);
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((p) => p.crcOk)).toBe(true);
    expect(all.flatMap((p) => p.packets.map((d) => d.length))).toStrictEqual(
      Array.from({ length: 200 }, (_, i) => sizes[i % sizes.length]!),
    );
  });

  test("refuses packets before the header and after the end", () => {
    const mux = new OggOpusMuxer({ channels: 1, sampleRate: 16_000, preSkip: 0 });
    expect(() => mux.addPacket(packet(10))).toThrow("header");
    mux.header();
    expect(() => mux.header()).toThrow("already");
    mux.finish();
    expect(() => mux.addPacket(packet(10))).toThrow("finished");
  });
});

describe.skipIf(!installed)("opusResponse", () => {
  const load = opusLoader(audioDir, identity);

  test("is an Ogg Opus stream in several chunks, as long as the audio plus the encoder's delay", async () => {
    const codec = (await load())!;
    const pcm = tone(2.5, 48_000);
    const res = opusResponse(codec, pcm);
    expect(res.headers.get("content-type")).toBe("audio/ogg; codecs=opus");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("accept");
    const chunks = await bodyChunks(res);
    expect(chunks.length).toBeGreaterThan(2);
    const bytes = concat(chunks);
    // About 64 kbit/s: less than a tenth of 16-bit PCM at 48 kHz.
    expect(bytes.length).toBeLessThan(pcm.samples.length * 2 * 0.15);

    const all = pages(bytes);
    expect(all.every((p) => p.crcOk)).toBe(true);
    expect(all[0]!.flags).toBe(0x02);
    expect(all.at(-1)!.flags).toBe(0x04);
    const head = all[0]!.packets[0]!;
    expect(head[9]).toBe(1);
    const preSkip = new DataView(head.buffer).getUint16(10, true);
    expect(preSkip).toBeGreaterThan(0);
    expect(preSkip % 3).toBe(0);
    // The decoder drops preSkip: 2.5 s at 48 kHz remain.
    expect(all.at(-1)!.granule - preSkip).toBe(2.5 * 48_000);
    // Every packet is a 20 ms super-wideband CELT frame: TOC config 27, code 0.
    for (const p of all.slice(2)) {
      for (const data of p.packets) {
        expect(data[0]! >> 3).toBe(27);
        expect(data[0]! & 3).toBe(0);
      }
    }
  });

  test("decodes back to the audio, sample for sample in time", async () => {
    const codec = (await load())!;
    const pcm = tone(2.5, 48_000);
    const all = pages(concat(await bodyChunks(opusResponse(codec, pcm))));
    const preSkip = new DataView(all[0]!.packets[0]!.buffer).getUint16(10, true);
    const decoder = new OpusDecoder(opusDir(audioDir), 48_000, 1);
    const decoded = all.slice(2).flatMap((p) => p.packets.flatMap((d) => [...decoder.decode(d)]));
    decoder.destroy();
    // What the granule says is kept: the pre-skip dropped, the last packet's padding cut.
    const kept = decoded.slice(preSkip, all.at(-1)!.granule);
    expect(kept).toHaveLength(pcm.samples.length);
    let signal = 0;
    let noise = 0;
    for (let i = 0; i < kept.length; i++) {
      signal += pcm.samples[i]! ** 2;
      noise += (kept[i]! - pcm.samples[i]!) ** 2;
    }
    // In step it measured about 40 dB; one sample early or late, 29 or 26.
    expect(10 * Math.log10(signal / noise)).toBeGreaterThan(35);
  });

  test("two streams at once do not share an encoder", async () => {
    const codec = (await load())!;
    const pcm = tone(1, 48_000);
    const alone = concat(await bodyChunks(opusResponse(codec, pcm)));
    const a = opusResponse(codec, pcm);
    const b = opusResponse(codec, tone(1, 48_000));
    const ra = a.body!.getReader();
    const rb = b.body!.getReader();
    const parts: Uint8Array[] = [];
    for (let r = await ra.read(), s = await rb.read(); !r.done || !s.done; r = await ra.read(), s = await rb.read()) {
      if (r.value) {
        parts.push(r.value as Uint8Array);
      }
    }
    // Only the random serial differs, so the packets are what to compare.
    const packets = (bytes: Uint8Array) => pages(bytes).flatMap((p) => p.packets.map((d) => [...d].join(",")));
    expect(packets(concat(parts))).toStrictEqual(packets(alone));
  });

  test("mixes channels down and resamples with the resampler it is given", async () => {
    const codec = (await load())!;
    let seen: { length: number; channels: number; from: number; to: number } | undefined;
    const resample = (samples: Float32Array, channels: number, from: number, to: number) => {
      seen = { length: samples.length, channels, from, to };
      return new Float32Array(Math.floor((samples.length * to) / from));
    };
    const res = opusResponse({ ...codec, resample }, tone(0.5, 22_050, 2));
    const all = pages(concat(await bodyChunks(res)));
    expect(seen).toStrictEqual({ length: 11_025, channels: 1, from: 22_050, to: 48_000 });
    const preSkip = new DataView(all[0]!.packets[0]!.buffer).getUint16(10, true);
    expect(all.at(-1)!.granule - preSkip).toBe(Math.floor((11_025 * 48_000) / 22_050));
  });

  test("is undefined while the encoder is not installed", async () => {
    await expect(opusLoader("/nonexistent/audio.cpp", identity)()).resolves.toBeUndefined();
  });
});

describe("POST /speech", () => {
  let app: App;
  let base: string;
  let bare: App;
  let bareBase: string;

  beforeAll(async () => {
    app = await startApp(config({ audioDir }), launcher, speechLauncher);
    base = app.server.url.origin;
    await waitReady(app);
    bare = await startApp(config(), launcher, speechLauncher);
    bareBase = bare.server.url.origin;
    await waitReady(bare);
  });

  afterAll(async () => {
    await app.stop();
    await bare.stop();
  });

  const speak = (to: string, accept: string) =>
    postTo(to, "/api/v1/speech", { text: "Hello there.", lang: "en" }, { headers: { accept } });

  test.skipIf(!installed)("audio/ogg is answered with Ogg Opus whenever it is named", async () => {
    mockSpeech.audioSeconds = 1;
    for (const accept of ["audio/ogg", "audio/ogg, audio/wav;q=0.5", "audio/wav, audio/ogg;q=0.5"]) {
      const res = await speak(base, accept);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/ogg; codecs=opus");
      const all = pages(new Uint8Array(await res.arrayBuffer()));
      expect(all.at(-1)!.flags).toBe(0x04);
      // 22.05 kHz to 48 kHz: one second, give or take the resampler's edge.
      const preSkip = new DataView(all[0]!.packets[0]!.buffer).getUint16(10, true);
      expect(Math.abs(all.at(-1)!.granule - preSkip - 48_000)).toBeLessThan(200);
    }
    resetMockSpeech();
  });

  test.skipIf(!installed)("WAV when Opus is named at 0 or not at all", async () => {
    // audio/qoa is what older pages asked for; it is no longer sent, and the spec allows WAV in its place.
    for (const accept of ["audio/ogg;q=0, audio/wav", "audio/wav", "*/*", "audio/qoa, audio/wav;q=0.5"]) {
      const res = await speak(base, accept);
      expect(res.headers.get("content-type")).toBe("audio/wav");
    }
    resetMockSpeech();
  });

  test("a server without the encoder answers audio/ogg with WAV", async () => {
    const res = await speak(bareBase, "audio/ogg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    resetMockSpeech();
  });
});
