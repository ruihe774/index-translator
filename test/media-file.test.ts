import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
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
import { ebmlHeader, element, ID, opusHead, opusPacket, simpleBlock, track, uint } from "./helpers/ebml";

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
    const probe = await probeMedia(media("tracks.mkv"), LIMITS);
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
        problem: "AAC audio is not supported yet: only Opus tracks can be transcribed.",
      },
    ]);
    expect(preferredTrack(probe.tracks)?.number).toBe(3);
  });

  test("5.1 Opus and a compressed track are listed but cannot be sent", async () => {
    const [surround] = (await probeMedia(media("surround.mkv"), LIMITS)).tracks;
    expect(surround!.problem).toBe("It has 6 channels: only mono and stereo tracks can be transcribed.");
    const [compressed] = (await probeMedia(media("compressed.mkv"), LIMITS)).tracks;
    expect(compressed!.problem).toBe("It is compressed inside the file, which is not supported.");
    expect(preferredTrack([surround!, compressed!])).toBeUndefined();
  });

  test("says where a long file is cut", async () => {
    const short = { ...LIMITS, maxSeconds: 1 };
    expect((await probeMedia(media("tone.webm"), short)).cutAt).toBe(1);
    expect((await probeMedia(media("tone.ogg"), short)).cutAt).toBe(1);
    expect((await probeMedia(media("tone.wav"), short)).cutAt).toBe(1);
    expect((await probeMedia(media("tone.wav"), LIMITS)).duration).toBe(2);
  });

  test("a WAV file the server does not take", async () => {
    const [wav] = (await probeMedia(media("tone.wav"), { ...LIMITS, minRate: 22_050 })).tracks;
    expect(wav!.problem).toBe("Its sample rate is 16 kHz: only 22.05 kHz to 48 kHz can be transcribed.");
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

  test("a WAV file is cut to the server's byte limit", async () => {
    // 16 kHz mono 16-bit: 32,000 bytes a second.
    const wav = await prepare("tone.wav", 0, {
      ...LIMITS,
      maxBytes: 32_000 + 44 + 16,
    });
    expect(wav).toMatchObject({ seconds: 1, cut: true });
    await expect(bytes(wav)).resolves.toHaveLength(32_000 + 44);
  });

  test("an Opus track of an MKV file is remuxed, padding and all", async () => {
    const r = await prepare("tracks.mkv", 3);
    expect(r).toMatchObject({ type: OGG_TYPE, cut: false, offset: 0 });
    // 3 s at 48 kHz: the pre-skip and the last packet's padding are left out.
    const ogg = demuxOggOpus(await bytes(r));
    expect(ogg.frames).toBe(144_000);
    expect(ogg.head).toMatchObject({ channels: 1, preSkip: 312 });
    await expect(accepted(r)).resolves.toBe(3);
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
    await expect(prepare("tracks.mkv", 4)).rejects.toThrow(
      new MediaError("AAC audio is not supported yet: only Opus tracks can be transcribed."),
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
