// Ogg Opus uploads: the demuxer (public/ogg-opus.ts) on our muxer's files and on hand-made pages,
// decoding with libopus (src/opus-file.ts), and `POST /voices` and `POST /transcriptions` taking
// `audio/ogg`. That a browser's AudioEncoder output is taken is e2e/speech.spec.ts's test. The tests
// that encode or decode need libopus and libsoxr (bun scripts/build_libopus.ts, build_soxr.ts) and are
// skipped without them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { concat, demuxOggOpus, OggOpusMuxer, type OpusPacket, opusPacketSamples } from "../public/ogg-opus";
import type { Health, Voice, VoiceList } from "../src/api";
import { type App, startApp } from "../src/app";
import { opusDir, OpusEncoder, opusLibraryPath } from "../src/opus-ffi";
import { readOggOpus, readOggOpusInfo, readRecording } from "../src/opus-file";
import { readWav } from "../src/wav";
import {
  bodyOf,
  config,
  errorOf,
  launcher,
  mockSpeech,
  resetMockSpeech,
  silentWav,
  speechLauncher,
  waitReady,
} from "./helpers/mock-engine";

const audioDir = join(import.meta.dir, "..", "vendor", "audio.cpp");
const installed = existsSync(opusLibraryPath(opusDir(audioDir))) && existsSync(join(audioDir, "..", "soxr", "VERSION"));

/** A CELT packet of 20 ms (TOC configuration 31, one frame), `size` bytes long. */
const celt = (size = 40): Uint8Array => new Uint8Array(size).fill(7).fill(31 << 3, 0, 1);

/** Our muxer's file of `packets` with `preSkip`, the last cut to `end` samples in all (pre-skip included). */
function muxed(packets: Uint8Array[], preSkip = 312, end?: number, channels: 1 | 2 = 1): Uint8Array {
  const mux = new OggOpusMuxer({ channels, sampleRate: 48_000, preSkip, serial: 1, maxPageDuration: 4800 });
  const total = packets.reduce((n, p) => n + opusPacketSamples(p), 0);
  const parts = [mux.header()];
  packets.forEach((data, i) => {
    const duration = opusPacketSamples(data);
    const padding = i === packets.length - 1 ? total - (end ?? total) : 0;
    parts.push(mux.addPacket({ data, duration, validDuration: duration - padding }));
  });
  parts.push(mux.finish());
  return concat(parts);
}

/** Ogg's CRC-32 the slow way, apart from the module's table. */
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

interface PageOptions {
  flags?: number;
  granule?: bigint;
  serial?: number;
  sequence: number;
}

/** One Ogg page holding `body`, cut by `lacing` (which must add up to its length). */
function page(body: Uint8Array, lacing: number[], o: PageOptions): Uint8Array {
  const out = new Uint8Array(27 + lacing.length + body.length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("OggS"));
  out[5] = o.flags ?? 0;
  view.setBigUint64(6, o.granule ?? 0n, true);
  view.setUint32(14, o.serial ?? 1, true);
  view.setUint32(18, o.sequence, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  out.set(body, 27 + lacing.length);
  view.setUint32(22, crc(out), true);
  return out;
}

/** The two header pages of our muxer, with `head` changed by `edit`. */
function headers(edit: (head: Uint8Array) => void = () => {}): Uint8Array[] {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1;
  head[9] = 1;
  new DataView(head.buffer).setUint16(10, 312, true);
  edit(head);
  const tags = new Uint8Array(16);
  tags.set(new TextEncoder().encode("OpusTags"));
  return [page(head, [19], { flags: 0x02, sequence: 0 }), page(tags, [16], { sequence: 1 })];
}

describe("opusPacketSamples", () => {
  test.each([
    ["CELT 2.5 ms", [16 << 3], 120],
    ["CELT 20 ms", [31 << 3], 960],
    ["SILK 60 ms", [3 << 3], 2880],
    ["hybrid 10 ms, two frames", [(12 << 3) | 1], 960],
    ["CELT 20 ms, code 3 with six frames", [(31 << 3) | 3, 6], 5760],
  ])("%s", (_what, bytes, samples) => {
    expect(opusPacketSamples(new Uint8Array(bytes))).toBe(samples);
  });

  test.each([
    ["empty", [], "empty"],
    ["code 3 with no count", [(31 << 3) | 3], "damaged"],
    ["code 3 with zero frames", [(31 << 3) | 3, 0], "damaged"],
    ["longer than 120 ms", [(31 << 3) | 3, 7], "damaged"],
  ])("refuses a packet %s", (_what, bytes, message) => {
    expect(() => opusPacketSamples(new Uint8Array(bytes))).toThrow(message);
  });
});

describe("demuxOggOpus", () => {
  test("reads our muxer's file back: header, packets, and the length the last granule gives", () => {
    const packets = Array.from({ length: 25 }, (_, i) => celt(30 + i));
    // 25 packets of 960 = 24,000 samples; the audio ends 500 into the last one.
    const end = 24 * 960 + 500;
    const ogg = demuxOggOpus(muxed(packets, 312, end));
    expect(ogg.head).toStrictEqual({ channels: 1, preSkip: 312, inputSampleRate: 48_000, outputGain: 0 });
    expect(ogg.packets).toStrictEqual(packets);
    expect(ogg.frames).toBe(end - 312);
  });

  test("joins a packet that spans pages", () => {
    const long = celt(600);
    const short = celt(20);
    const file = concat([
      ...headers(),
      // 510 of the 600 bytes: two full segments, no packet ends here.
      page(long.subarray(0, 510), [255, 255], { sequence: 2, granule: 0xff_ff_ff_ff_ff_ff_ff_ffn }),
      page(concat([long.subarray(510), short]), [90, 20], { flags: 0x01 | 0x04, sequence: 3, granule: 1920n }),
    ]);
    const ogg = demuxOggOpus(file);
    expect(ogg.packets).toStrictEqual([long, short]);
    expect(ogg.frames).toBe(1920 - 312);
  });

  test("takes stereo", () => {
    expect(demuxOggOpus(muxed([celt(), celt()], 312, undefined, 2)).head.channels).toBe(2);
  });

  const good = () => muxed([celt(), celt(), celt()]);

  test.each([
    ["is empty", () => new Uint8Array(0), "the file is empty"],
    ["is a WAV file", () => new Uint8Array(silentWav(0.1)), "not an Ogg file"],
    ["is cut off inside a page", () => good().subarray(0, good().length - 5), "cut off"],
    [
      "has a damaged byte",
      () => {
        const bytes = good();
        const at = bytes.length - 3;
        bytes[at]! ^= 1;
        return bytes;
      },
      "checksum",
    ],
    [
      "misses a page",
      () => concat([...headers(), page(celt(), [40], { sequence: 3, flags: 0x04, granule: 960n })]),
      "missing or out of order",
    ],
    [
      "holds two streams",
      () => concat([...headers(), page(celt(), [40], { sequence: 2, serial: 2, granule: 960n })]),
      "more than one stream",
    ],
    ["is chained", () => concat([good(), good()]), "more than one stream"],
    [
      "is not Opus",
      () =>
        concat([
          page(new TextEncoder().encode("\u0001vorbis-------------------"), [26], { flags: 0x02, sequence: 0 }),
          page(new Uint8Array(8), [8], { sequence: 1 }),
        ]),
      "does not hold Opus",
    ],
    ["has more channels than stereo", () => concat(headers((h) => void (h[18] = 1))), "mapping family 1"],
    ["has a new major version", () => concat(headers((h) => void (h[8] = 0x10))), "version 16"],
    [
      "ends past its packets",
      () => concat([...headers(), page(celt(), [40], { sequence: 2, flags: 0x04, granule: 961n })]),
      "granule positions",
    ],
    ["has no audio", () => concat(headers()), "no audio"],
    [
      "ends inside a packet",
      () => concat([...headers(), page(celt(255), [255], { sequence: 2, granule: 0xff_ff_ff_ff_ff_ff_ff_ffn })]),
      "cut off",
    ],
    [
      "continues a packet that never began",
      () => concat([...headers(), page(celt(), [40], { sequence: 2, flags: 0x01, granule: 960n })]),
      "a packet is cut off",
    ],
  ])("refuses a file that %s", (_what, file, message) => {
    expect(() => demuxOggOpus(file())).toThrow(message);
  });
});

/** Interleaved test audio at 48 kHz: a sweep, the second channel at half the level. */
function tone(seconds: number, channels: 1 | 2): Float32Array {
  const frames = Math.round(seconds * 48_000);
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    const t = i / 48_000;
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] = 0.4 * Math.sin(2 * Math.PI * (200 + 50 * t) * t) * (c === 0 ? 1 : 0.5);
    }
  }
  return out;
}

/** `samples` (48 kHz, interleaved) as Ogg Opus by libopus and our muxer, the way src/opus-stream.ts writes it. */
function encodeOgg(samples: Float32Array, channels: 1 | 2): Uint8Array {
  const encoder = new OpusEncoder(opusDir(audioDir), {
    sampleRate: 48_000,
    channels,
    bitrate: 96_000,
    complexity: 6,
    bandwidth: 1105, // fullband
  });
  try {
    const { lookahead } = encoder;
    const frames = samples.length / channels;
    const count = Math.ceil((frames + lookahead) / 960);
    const mux = new OggOpusMuxer({ channels, sampleRate: 48_000, preSkip: lookahead });
    const parts = [mux.header()];
    for (let i = 0; i < count; i++) {
      const input = new Float32Array(960 * channels);
      input.set(samples.subarray(i * 960 * channels, (i + 1) * 960 * channels));
      const padding = i === count - 1 ? count * 960 - (frames + lookahead) : 0;
      const packet: OpusPacket = { data: encoder.encode(input), duration: 960, validDuration: 960 - padding };
      parts.push(mux.addPacket(packet));
    }
    parts.push(mux.finish());
    return concat(parts);
  } finally {
    encoder.destroy();
  }
}

/** Signal to error ratio in dB of `got` against `want`. */
function snr(want: Float32Array, got: Float32Array): number {
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < want.length; i++) {
    signal += want[i]! ** 2;
    noise += (want[i]! - got[i]!) ** 2;
  }
  return 10 * Math.log10(signal / noise);
}

describe.skipIf(!installed)("decoding with libopus", () => {
  test.each([1, 2] as const)("%i channel(s) come back in length and in time", (channels) => {
    const original = tone(1.234, channels);
    const file = encodeOgg(original, channels);
    expect(readOggOpusInfo(file)).toStrictEqual({ sampleRate: 48_000, channels, frames: original.length / channels });
    const pcm = readOggOpus(file, opusDir(audioDir));
    expect(pcm.sampleRate).toBe(48_000);
    expect(pcm.channels).toBe(channels);
    expect(pcm.samples).toHaveLength(original.length);
    // A pre-skip dropped wrongly would shift the sweep and wreck this; Opus at 96 kbps keeps it well above 20 dB.
    expect(snr(original, pcm.samples)).toBeGreaterThan(20);
  });

  test("the header's output gain is applied", () => {
    const original = tone(0.5, 1);
    const file = encodeOgg(original, 1);
    const plain = readOggOpus(file, opusDir(audioDir)).samples;
    // -6.02 dB (Q7.8) in OpusHead, then the first page's checksum written again.
    const louder = file.slice();
    const view = new DataView(louder.buffer);
    view.setInt16(28 + 16, Math.round(-6.0206 * 256), true);
    view.setUint32(22, 0, true);
    view.setUint32(22, crc(louder.subarray(0, 28 + 19)), true);
    const quieter = readOggOpus(louder, opusDir(audioDir)).samples;
    expect(quieter[1000]! / plain[1000]!).toBeCloseTo(0.5, 2);
  });

  test("readRecording tells WAV and Ogg apart by their first bytes", () => {
    const wav = new Uint8Array(silentWav(0.2, 16_000));
    expect(readRecording(wav, audioDir).sampleRate).toBe(16_000);
    expect(readRecording(encodeOgg(tone(0.2, 1), 1), audioDir).sampleRate).toBe(48_000);
  });
});

describe.skipIf(!installed)("uploads in Ogg Opus", () => {
  let app: App;
  let bare: App;
  let base: string;

  beforeAll(async () => {
    app = await startApp(config({ audioDir }), launcher, speechLauncher);
    base = `http://127.0.0.1:${app.server.port}`;
    // The test config's audio directory has no libopus beside it.
    bare = await startApp(config(), launcher, speechLauncher);
    await waitReady(app);
  });

  afterAll(async () => {
    resetMockSpeech();
    await app.stop();
    await bare.stop();
  });

  const post = (path: string, body: Uint8Array, type = "audio/ogg", at = base) =>
    fetch(`${at}/api/v1${path}`, { method: "POST", headers: { "content-type": type }, body });

  test("both endpoints list Ogg Opus where libopus is, and only WAV elsewhere", async () => {
    const health = async (at: string) =>
      (await bodyOf<Health>(await fetch(`${at}/api/v1/health`))).transcribe?.upload_types;
    const voices = async (at: string) => (await bodyOf<VoiceList>(await fetch(`${at}/api/v1/voices`))).upload_types;
    await expect(voices(base)).resolves.toStrictEqual(["audio/wav", "audio/ogg"]);
    await expect(health(base)).resolves.toStrictEqual(["audio/wav", "audio/ogg"]);
    const bareBase = `http://127.0.0.1:${bare.server.port}`;
    await expect(voices(bareBase)).resolves.toStrictEqual(["audio/wav"]);
    await expect(health(bareBase)).resolves.toStrictEqual(["audio/wav"]);
    const refused = await post("/voices", encodeOgg(tone(1.5, 1), 1), "audio/ogg", bareBase);
    expect(refused.status).toBe(415);
    expect((await errorOf(refused)).message).toBe("request body must be audio/wav");
  });

  test("a voice sample is decoded and resampled to the separator's 44.1 kHz WAV", async () => {
    const before = mockSpeech.voices.length;
    const res = await post("/voices?name=Opus", encodeOgg(tone(1.5, 2), 2));
    expect(res.status).toBe(201);
    expect((await bodyOf<Voice>(res)).name).toBe("Opus");
    expect(mockSpeech.voices).toHaveLength(before + 1);
  });

  test("the WAV a voice sample becomes keeps its length and channels", async () => {
    const { opusSampleToWav } = await import("../src/speech");
    const { soxrResampler } = await import("../src/resample");
    const resample = soxrResampler(join(audioDir, "..", "soxr"));
    const pcm = readWav(new Uint8Array(opusSampleToWav(encodeOgg(tone(1.5, 2), 2), audioDir, resample)));
    expect(pcm).toMatchObject({ sampleRate: 44_100, channels: 2 });
    expect(pcm.samples).toHaveLength(1.5 * 44_100 * 2);
  });

  test.each([
    ["too long, before it is decoded", () => encodeOgg(tone(15.5, 1), 1), "too long (15.5 s"],
    ["too short", () => encodeOgg(tone(0.5, 1), 1), "too short"],
    ["damaged", () => encodeOgg(tone(1.5, 1), 1).fill(0, 200, 210), "cannot be used: the Ogg file is damaged"],
    ["a WAV file", () => new Uint8Array(silentWav(1.5, 44_100)), "cannot be used: not an Ogg file"],
  ])("a voice sample that is %s is a 400", async (_what, body, message) => {
    const res = await post("/voices", body());
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: "invalid_request", details: { field: "body" } });
    expect(error.message).toContain(message);
  });

  test("an Ogg file sent as audio/wav is not taken for one", async () => {
    const res = await post("/voices", encodeOgg(tone(1.5, 1), 1), "audio/wav");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain("not a WAV file");
  });

  test("a recording to transcribe starts with its duration from the last granule", async () => {
    const res = await post("/transcriptions", encodeOgg(tone(2.5, 1), 1));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: start\ndata: {"duration":2.5}');
    expect(text).toContain("event: done");
  });

  test("a damaged recording to transcribe is refused before it is queued", async () => {
    const before = mockSpeech.transcriptions.length;
    const file = encodeOgg(tone(2.5, 1), 1);
    const res = await post("/transcriptions", file.subarray(0, -10));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain("the Ogg file is cut off");
    expect(mockSpeech.transcriptions).toHaveLength(before);
  });
});
