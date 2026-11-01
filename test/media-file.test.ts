import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  type Capabilities,
  type Limits,
  MediaError,
  OGG_TYPE,
  preferredTrack,
  prepareRecording,
  probeMedia,
  type Recording,
  sniff,
  WAV_TYPE,
} from "../public/media-file";
import { concat, demuxOggOpus } from "../public/ogg-opus";
import { validateRecording } from "../src/speech";
import { readWav } from "../src/wav";
import { ebmlHeader, element, float, ID, opusHead, opusPacket, simpleBlock, track, uint } from "./helpers/ebml";

const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "media", name));
/**
 * The fixtures in memory: Bun drops the slice of a file (also of a Blob made from one) that is a part of a new
 * Blob, which the WAV cut makes; browsers do not.
 */
const loaded = new Map<string, Blob>();
for (const name of [
  "tone.wav",
  "tone.ogg",
  "tone.webm",
  "tracks.mkv",
  "surround.mkv",
  "compressed.mkv",
  "late.mkv",
  "very-late.mkv",
  "codecs.mkv",
  "gap.mka",
]) {
  loaded.set(name, new Blob([await fixture(name).bytes()]));
}
const media = (name: string) => loaded.get(name)!;

const LIMITS: Limits = {
  maxSeconds: 1800,
  maxBytes: 160 * 2 ** 20,
  minRate: 16_000,
  maxRate: 48_000,
};

const bytes = async (r: Recording) => new Uint8Array(await r.body.arrayBuffer());

/** A browser that decodes every codec but AC-3, as Playwright's Chromium does. */
const CHROMIUM: Capabilities = { ogg: true, decodes: (c: { codec: string }) => Promise.resolve(c.codec !== "ac-3") };
/** A server without libopus. */
const NO_OPUS: Capabilities = { ...CHROMIUM, ogg: false };
/** Bun: no WebCodecs. */
const NO_WEBCODECS: Capabilities = { ogg: true, decodes: () => Promise.resolve(false) };

/** A WAV file of `channels` channels of a tone at `rate`, 16-bit. */
function wavFile(rate: number, channels: number, seconds: number): Blob {
  const frames = rate * seconds;
  const head = new Uint8Array(44);
  const view = new DataView(head.buffer);
  const ascii = (at: number, text: string) => head.set(new TextEncoder().encode(text), at);
  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames * channels * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, frames * channels * 2, true);
  const samples = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    samples[i * channels] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate));
  }
  return new Blob([head, new Uint8Array(samples.buffer)]);
}

/** What the server says of the body: its length in seconds, or it throws as the request would fail. */
async function accepted(r: Recording): Promise<number> {
  return validateRecording(await bytes(r), r.type);
}

async function prepare(name: string, track = 0, limits = LIMITS) {
  const file = media(name);
  return prepareRecording(file, await probeMedia(file, limits), track, limits);
}

test("sniff tells the containers apart by their first bytes", async () => {
  for (const [name, container] of [
    ["tone.wav", "wav"],
    ["tone.ogg", "ogg"],
    ["tone.webm", "matroska"],
    ["tracks.mkv", "matroska"],
  ] as const) {
    expect(sniff(await fixture(name).slice(0, 12).bytes())).toBe(container);
  }
  expect(sniff(new TextEncoder().encode("1\n00:00:01,000"))).toBeNull();
});

describe("probeMedia", () => {
  test("lists the audio tracks with what the dialog says of them", async () => {
    const probe = await probeMedia(media("tracks.mkv"), LIMITS, NO_WEBCODECS);
    expect(probe.container).toBe("matroska");
    expect(probe.cutAt).toBeUndefined();
    expect(probe.tracks).toStrictEqual([
      {
        number: 2,
        language: "English",
        name: "Commentary",
        codec: "Opus",
        channels: 2,
        isDefault: false,
        problem: null,
      },
      {
        number: 3,
        language: "Japanese",
        name: undefined,
        codec: "Opus",
        channels: 1,
        isDefault: true,
        problem: null,
      },
      {
        number: 4,
        language: "French",
        name: undefined,
        codec: "AAC",
        channels: undefined,
        isDefault: true,
        problem: "This browser cannot decode AAC audio.",
      },
    ]);
    expect(preferredTrack(probe.tracks)?.number).toBe(3);
    // Where the browser decodes it, AAC is re-encoded.
    const decoding = await probeMedia(media("tracks.mkv"), LIMITS, CHROMIUM);
    expect(decoding.tracks.map((t) => t.problem)).toStrictEqual([null, null, null]);
  });

  test("5.1 Opus is decoded where the browser can; a compressed track never", async () => {
    const [surround] = (await probeMedia(media("surround.mkv"), LIMITS, NO_WEBCODECS)).tracks;
    expect(surround!.problem).toBe("This browser cannot decode Opus audio.");
    expect((await probeMedia(media("surround.mkv"), LIMITS, CHROMIUM)).tracks[0]!.problem).toBeNull();
    const [compressed] = (await probeMedia(media("compressed.mkv"), LIMITS, CHROMIUM)).tracks;
    expect(compressed!.problem).toBe("It is compressed inside the file, which is not supported.");
    expect(preferredTrack([surround!, compressed!])).toBeUndefined();
  });

  test("other codecs: what the browser does not decode is refused, PCM needs no decoder", async () => {
    const probe = await probeMedia(media("codecs.mkv"), LIMITS, CHROMIUM);
    expect(probe.tracks.map((t) => [t.name, t.codec, t.problem])).toStrictEqual([
      ["Vorbis", "Vorbis", null],
      ["FLAC", "FLAC", null],
      ["MP3", "MP3", null],
      ["PCM", "PCM", null],
      ["AC-3", "AC-3", "This browser cannot decode AC-3 audio."],
    ]);
    const bare = await probeMedia(media("codecs.mkv"), LIMITS, NO_WEBCODECS);
    expect(bare.tracks.map((t) => t.problem === null)).toStrictEqual([false, false, false, true, false]);
    expect(preferredTrack(bare.tracks)?.name).toBe("PCM");
  });

  test("without libopus on the server, Opus is decoded, so the browser must decode it", async () => {
    for (const name of ["tone.ogg", "tracks.mkv"]) {
      const [first] = (await probeMedia(media(name), LIMITS, { ...NO_OPUS, decodes: () => Promise.resolve(false) }))
        .tracks;
      expect(first!.problem).toBe("This browser cannot decode Opus audio.");
      expect((await probeMedia(media(name), LIMITS, NO_OPUS)).tracks[0]!.problem).toBeNull();
    }
  });

  test("says where a long file is cut", async () => {
    const short = { ...LIMITS, maxSeconds: 1 };
    expect((await probeMedia(media("tone.webm"), short)).cutAt).toBe(1);
    expect((await probeMedia(media("tone.ogg"), short)).cutAt).toBe(1);
    expect((await probeMedia(media("tone.wav"), short)).cutAt).toBe(1);
    expect((await probeMedia(media("tone.wav"), LIMITS)).duration).toBe(2);
  });

  test("a WAV file of a rate or channel count the server does not take is re-encoded, not refused", async () => {
    const [wav] = (await probeMedia(media("tone.wav"), { ...LIMITS, minRate: 22_050 })).tracks;
    expect(wav!.problem).toBeNull();
    expect((await probeMedia(wavFile(16_000, 6, 1), LIMITS)).tracks[0]!.problem).toBeNull();
    expect((await probeMedia(wavFile(16_000, 9, 1), LIMITS)).tracks[0]!.problem).toBe(
      "It has 9 channels: at most 8 can be mixed down.",
    );
  });

  test("files that cannot be transcribed at all", async () => {
    const videoOnly = new Blob([
      concat([
        ebmlHeader(),
        element(ID.Segment, element(ID.Tracks, track({ number: 1, type: 1, codec: "V_VP8" }))),
      ]) as Uint8Array<ArrayBuffer>,
    ]);
    await expect(probeMedia(videoOnly, LIMITS)).rejects.toThrow(new MediaError("It has no audio track."));
    await expect(probeMedia(new Blob(["just some text"]), LIMITS)).rejects.toThrow(
      new MediaError("It is not a WAV, Ogg, WebM or MKV file."),
    );
  });
});

describe("prepareRecording", () => {
  test("WAV and Ogg Opus within the limits are sent as they are", async () => {
    const wav = await prepare("tone.wav");
    expect(wav).toMatchObject({
      type: WAV_TYPE,
      seconds: 2,
      cut: false,
      offset: 0,
    });
    expect(wav.body).toBe(media("tone.wav"));
    const ogg = await prepare("tone.ogg");
    expect(ogg).toMatchObject({ type: OGG_TYPE, cut: false, offset: 0 });
    expect(ogg.body).toBe(media("tone.ogg"));
  });

  test("WAV and Ogg Opus are cut at the server's limit", async () => {
    const short = { ...LIMITS, maxSeconds: 1 };
    const wav = await prepare("tone.wav", 0, short);
    expect(wav).toMatchObject({ type: WAV_TYPE, seconds: 1, cut: true });
    await expect(accepted(wav)).resolves.toBe(1);
    const ogg = await prepare("tone.ogg", 0, short);
    expect(ogg).toMatchObject({ type: OGG_TYPE, seconds: 1, cut: true });
    await expect(accepted(ogg)).resolves.toBe(1);
  });

  test("a WAV file the byte limit would cut is re-encoded (here, without WebCodecs, as a mono 44.1 kHz WAV)", async () => {
    // 48 kHz stereo 16-bit is 192,000 bytes a second; mono 44.1 kHz is 88,200.
    const limits = { ...LIMITS, maxBytes: 200_000 };
    const file = wavFile(48_000, 2, 3);
    expect((await probeMedia(file, limits)).cutAt).toBeUndefined();
    const r = await prepareRecording(file, await probeMedia(file, limits), 0, limits);
    expect(r).toMatchObject({ type: WAV_TYPE, cut: true, offset: 0 });
    expect(r.body.size).toBeLessThanOrEqual(200_000);
    const wav = readWav(await bytes(r));
    expect([wav.sampleRate, wav.channels]).toStrictEqual([44_100, 1]);
    expect(r.seconds).toBeCloseTo((200_000 - 44) / 88_200, 3);
    await expect(accepted(r)).resolves.toBeCloseTo(r.seconds, 3);
  });

  test("a WAV file of another rate or more channels is resampled and mixed down", async () => {
    const limits = { ...LIMITS, minRate: 22_050 };
    const r = await prepare("tone.wav", 0, limits);
    expect(r).toMatchObject({ type: WAV_TYPE, cut: false });
    expect(r.seconds).toBe(2);
    const wav = readWav(await bytes(r));
    expect([wav.sampleRate, wav.channels, wav.samples.length]).toStrictEqual([44_100, 1, 88_200]);
    const six = wavFile(16_000, 6, 1);
    const mixed = await prepareRecording(six, await probeMedia(six, LIMITS), 0, LIMITS);
    expect(readWav(await bytes(mixed)).samples).toHaveLength(44_100);
  });

  test("a PCM track of an MKV file is re-encoded", async () => {
    const file = media("codecs.mkv");
    const r = await prepareRecording(file, await probeMedia(file, LIMITS, CHROMIUM), 4, LIMITS);
    expect(r).toMatchObject({ type: WAV_TYPE, cut: false, offset: 0 });
    expect(r.seconds).toBeCloseTo(2, 2);
    await expect(accepted(r)).resolves.toBeCloseTo(2, 2);
  });

  test("a gap between PCM blocks is filled, and a late start becomes the offset", async () => {
    // 16 kHz mono 16-bit, 0.1 s blocks: at 0, 0.1 and then 0.5 s.
    const block = new Uint8Array(3200).fill(0x10);
    const pcmTrack = (n: number) =>
      track({
        number: n,
        codec: "A_PCM/INT/LIT",
        extra: [element(ID.Audio, float(ID.SamplingFrequency, 16_000), uint(ID.Channels, 1), uint(ID.BitDepth, 16))],
      });
    const file = (start: number) =>
      new Blob([
        concat([
          ebmlHeader("matroska"),
          element(
            ID.Segment,
            element(ID.Tracks, pcmTrack(1)),
            element(
              ID.Cluster,
              uint(ID.Timecode, start),
              simpleBlock(1, 0, [block]),
              simpleBlock(1, 100, [block]),
              simpleBlock(1, 500, [block]),
            ),
          ),
        ]) as Uint8Array<ArrayBuffer>,
      ]);
    const near = file(0);
    const r = await prepareRecording(near, await probeMedia(near, LIMITS), 1, LIMITS);
    expect(r.seconds).toBeCloseTo(0.6, 5);
    const wav = readWav(await bytes(r));
    expect(Math.abs(wav.samples[Math.round(0.15 * 44_100)]!)).toBeGreaterThan(0.01);
    expect(wav.samples[Math.round(0.35 * 44_100)]).toBe(0);
    expect(Math.abs(wav.samples[Math.round(0.55 * 44_100)]!)).toBeGreaterThan(0.01);
    const far = file(30_000);
    const late = await prepareRecording(far, await probeMedia(far, LIMITS), 1, LIMITS);
    expect(late.offset).toBe(30);
    expect(late.seconds).toBeCloseTo(0.6, 5);
    // No video, no keyframes.
    expect(r.video).toBeUndefined();
  });

  test("a re-encoded track's video keyframes are noted, in the file's times", async () => {
    const block = new Uint8Array(3200).fill(0x10);
    const picture = (relative: number, key: boolean) =>
      simpleBlock(2, relative, [new Uint8Array(500)], "none", key ? 0x80 : 0);
    const file = new Blob([
      concat([
        ebmlHeader("matroska"),
        element(
          ID.Segment,
          element(
            ID.Tracks,
            track({
              number: 1,
              codec: "A_PCM/INT/LIT",
              extra: [
                element(ID.Audio, float(ID.SamplingFrequency, 16_000), uint(ID.Channels, 1), uint(ID.BitDepth, 16)),
              ],
            }),
            track({ number: 2, type: 1, codec: "V_TEST", defaultDurationNs: 41_708_333 }),
          ),
          element(
            ID.Cluster,
            uint(ID.Timecode, 30_000),
            picture(0, true),
            simpleBlock(1, 0, [block]),
            picture(42, false),
            simpleBlock(1, 100, [block]),
            picture(83, true),
          ),
        ),
      ]) as Uint8Array<ArrayBuffer>,
    ]);
    const r = await prepareRecording(file, await probeMedia(file, LIMITS), 1, LIMITS);
    // The recording starts at 30 s (see `offset`); the keyframes are the file's times all the same.
    expect(r.offset).toBe(30);
    expect(r.video).toStrictEqual({ keyframes: [30, 30.083], frameSeconds: 0.041708333 });
  });

  test("an Opus track of an MKV file is remuxed, padding and all", async () => {
    const r = await prepare("tracks.mkv", 3);
    expect(r).toMatchObject({ type: OGG_TYPE, cut: false, offset: 0 });
    // 3 s at 48 kHz: the pre-skip and the last packet's padding are left out.
    const ogg = demuxOggOpus(await bytes(r));
    expect(ogg.frames).toBe(144_000);
    expect(ogg.head).toMatchObject({ channels: 1, preSkip: 312 });
    await expect(accepted(r)).resolves.toBe(3);
    // The video's keyframes are noted on the way (x264 made one, at the start; 5 frames a second).
    expect(r.video).toStrictEqual({ keyframes: [0], frameSeconds: 0.2 });
    // The stereo commentary.
    const en = await prepare("tracks.mkv", 2);
    expect(demuxOggOpus(await bytes(en)).head.channels).toBe(2);
    await expect(accepted(en)).resolves.toBe(3);
  });

  test("a WebM as MediaRecorder writes it", async () => {
    const r = await prepare("tone.webm", 2);
    expect(r.offset).toBe(0);
    await expect(accepted(r)).resolves.toBeCloseTo(3, 1);
  });

  test("audio that starts late is filled with silence from 0", async () => {
    const r = await prepare("late.mkv", 1);
    expect(r.offset).toBe(0);
    const ogg = demuxOggOpus(await bytes(r));
    expect(ogg.frames).toBe(144_000 + 72_000);
    expect(ogg.packets.slice(0, 75).every((p) => p.length === 3 && p[0] === 0xf8)).toBe(true);
    expect(ogg.packets[75]!.length).toBeGreaterThan(3);
  });

  test("audio that starts much later is not filled: the offset says where it starts", async () => {
    const r = await prepare("very-late.mkv", 1);
    expect(r.offset).toBeCloseTo(20, 2);
    expect(demuxOggOpus(await bytes(r)).frames).toBe(144_000);
  });

  test("a gap in the middle is filled; a lace's frames are not taken for gaps", async () => {
    const mono = opusPacket();
    const file = concat([
      ebmlHeader(),
      element(
        ID.Segment,
        element(
          ID.Tracks,
          track({
            number: 1,
            codecPrivate: opusHead(1),
            codecDelayNs: 6_500_000,
          }),
        ),
        element(
          ID.Cluster,
          uint(ID.Timecode, 0),
          // Two 20 ms packets in one lace, then one at 40 ms, then a jump to 160 ms: 100 ms missing.
          simpleBlock(1, 0, [mono, mono], "xiph"),
          simpleBlock(1, 40, [mono]),
          simpleBlock(1, 160, [mono]),
        ),
      ),
    ]);
    const blob = new Blob([file as Uint8Array<ArrayBuffer>]);
    const r = await prepareRecording(blob, await probeMedia(blob, LIMITS), 1, LIMITS);
    const ogg = demuxOggOpus(await bytes(r));
    expect(ogg.packets.map((p) => (p.length === 3 ? "silence" : "audio"))).toStrictEqual([
      "audio",
      "audio",
      "audio",
      "silence",
      "silence",
      "silence",
      "silence",
      "silence",
      "audio",
    ]);
  });

  test("an MKV track is cut at the server's limit", async () => {
    const r = await prepare("tracks.mkv", 3, { ...LIMITS, maxSeconds: 1 });
    expect(r).toMatchObject({ seconds: 1, cut: true });
    expect(demuxOggOpus(await bytes(r)).frames).toBe(48_000);
    await expect(accepted(r)).resolves.toBe(1);
  });

  test("a track that cannot be sent, and a stop", async () => {
    await expect(prepare("codecs.mkv", 99)).rejects.toThrow(new MediaError("The track is not in the file."));
    await expect(prepare("compressed.mkv", 1)).rejects.toThrow(
      new MediaError("It is compressed inside the file, which is not supported."),
    );
    const file = media("tracks.mkv");
    const probe = await probeMedia(file, LIMITS);
    const stop = new AbortController();
    stop.abort(new Error("stopped"));
    await expect(prepareRecording(file, probe, 3, LIMITS, { signal: stop.signal })).rejects.toThrow("stopped");
  });

  test("progress runs to the whole file", async () => {
    const file = media("tracks.mkv");
    const seen: number[] = [];
    await prepareRecording(file, await probeMedia(file, LIMITS), 3, LIMITS, {
      onProgress: (f) => void seen.push(f),
    });
    expect(seen.at(-1)).toBe(1);
    expect(seen).toStrictEqual(seen.toSorted((a, b) => a - b));
  });
});
