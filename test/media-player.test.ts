import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { probeMatroska } from "../public/matroska";
import { type Capabilities, type Limits, type MediaProbe, probeMedia } from "../public/media-file";
import {
  cueAt,
  type Edit,
  HIDDEN_TYPE,
  hideOtherAudio,
  patchedFile,
  playbackOf,
  playbackType,
  VOID_ID,
} from "../public/media-player";
import { ebmlHeader, element, ID, opusHead, uint } from "./helpers/ebml";

const fixture = async (name: string) =>
  new Blob([await Bun.file(join(import.meta.dir, "fixtures", "media", name)).bytes()], {
    type: "video/x-matroska",
  });

const LIMITS: Limits = { maxSeconds: 1800, maxBytes: 160 * 2 ** 20, minRate: 16_000, maxRate: 48_000 };
const NO_WEBCODECS: Capabilities = { ogg: true, decodes: () => Promise.resolve(false) };
const CRC = 0xbf;

/** A media element that plays everything but AC-3, as Chromium does. */
const chromium = (type: string) => !type.includes("ac-3");

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/** The audio tracks a player would see in the file. */
async function audioTracks(file: Blob): Promise<number[]> {
  const { tracks } = await probeMatroska(file.stream());
  return tracks.filter((t) => t.type === "audio").map((t) => t.number);
}

describe("hideOtherAudio", () => {
  test("leaves only the chosen track as audio in a file from mkvmerge", async () => {
    const file = await fixture("tracks.mkv");
    const probe = await probeMedia(file, LIMITS, NO_WEBCODECS);
    expect(probe.matroska!.video).toBe(true);
    expect(probe.matroska!.audio.map((a) => a.number)).toStrictEqual([2, 3, 4]);
    for (const chosen of [2, 3, 4]) {
      const edits = hideOtherAudio(probe, chosen, () => true)!;
      const patched = patchedFile(file, edits, file.type);
      expect(patched.size).toBe(file.size);
      await expect(audioTracks(patched)).resolves.toStrictEqual([chosen]);
      // Nothing but the edited bytes changed.
      const [before, after] = [await bytesOf(file), await bytesOf(patched)];
      const changed = [...before.keys()].filter((i) => before[i] !== after[i]);
      expect(changed).toStrictEqual(edits.map((e) => e.at).sort((a, b) => a - b));
    }
  });

  test("turns the CRC-32 elements over the track list into Void elements", async () => {
    const crc = () => element(CRC, new Uint8Array([1, 2, 3, 4]));
    const entry = (number: number) =>
      element(
        ID.TrackEntry,
        crc(),
        uint(ID.TrackNumber, number),
        uint(ID.TrackType, 2),
        element(ID.CodecID, new TextEncoder().encode("A_OPUS")),
        element(ID.CodecPrivate, opusHead(1)),
      );
    const file = new Blob([
      ebmlHeader("matroska"),
      element(
        ID.Segment,
        element(ID.Info, uint(ID.TimecodeScale, 1_000_000)),
        element(ID.Tracks, crc(), entry(1), entry(2)),
      ),
    ]);
    const probe = await probeMedia(file, LIMITS, NO_WEBCODECS);
    expect(probe.matroska!.checksums).toHaveLength(3);
    const edits = hideOtherAudio(probe, 2, () => true)!;
    expect(edits.filter((e) => e.byte === VOID_ID)).toHaveLength(3);
    const patched = await bytesOf(patchedFile(file, edits, ""));
    for (const at of probe.matroska!.checksums) {
      expect(patched[at]).toBe(VOID_ID);
    }
    await expect(audioTracks(new Blob([patched]))).resolves.toStrictEqual([2]);
  });

  test("no edits with one audio track", async () => {
    const probe = await probeMedia(await fixture("tone.webm"), LIMITS, NO_WEBCODECS);
    expect(hideOtherAudio(probe, probe.tracks[0]!.number, () => true)).toStrictEqual([]);
  });

  test("a track that cannot be hidden matters only when it would play first", () => {
    const probe: MediaProbe = {
      container: "matroska",
      duration: 1,
      tracks: [],
      cutAt: undefined,
      matroska: {
        video: false,
        audio: [
          { number: 1, typeAt: undefined },
          { number: 2, typeAt: 40 },
        ],
        checksums: [],
      },
    };
    expect(hideOtherAudio(probe, 2, () => true)).toBeNull();
    expect(hideOtherAudio(probe, 2, (n) => n !== 1)).toStrictEqual([]);
    expect(hideOtherAudio(probe, 1, () => true)).toStrictEqual([{ at: 40, byte: HIDDEN_TYPE }]);
  });
});

test("patchedFile writes the bytes in any order", async () => {
  const file = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5])]);
  const edits: Edit[] = [
    { at: 5, byte: 9 },
    { at: 0, byte: 7 },
    { at: 2, byte: HIDDEN_TYPE },
  ];
  expect([...(await bytesOf(patchedFile(file, edits, "")))]).toStrictEqual([7, 1, HIDDEN_TYPE, 3, 4, 9]);
});

describe("playbackOf", () => {
  test("a track this browser plays is played from the file, the others hidden", async () => {
    const file = await fixture("tracks.mkv");
    const probe = await probeMedia(file, LIMITS, NO_WEBCODECS);
    const playback = playbackOf(file, probe, 4, chromium);
    expect(playback.kind).toBe("file");
    if (playback.kind === "file") {
      expect(playback.video).toBe(true);
      await expect(audioTracks(playback.body)).resolves.toStrictEqual([4]);
    }
  });

  test("a track this browser cannot play goes to the recording", async () => {
    const file = await fixture("codecs.mkv");
    const probe = await probeMedia(file, LIMITS, NO_WEBCODECS);
    const ac3 = probe.tracks.find((t) => t.codec === "AC-3")!;
    expect(playbackOf(file, probe, ac3.number, chromium)).toStrictEqual({ kind: "recording" });
    const flac = probe.tracks.find((t) => t.codec === "FLAC")!;
    const playback = playbackOf(file, probe, flac.number, chromium);
    expect(playback.kind === "file" && !playback.video).toBe(true);
  });

  test("WAV and Ogg files play as they are", async () => {
    for (const name of ["tone.wav", "tone.ogg"]) {
      const file = new Blob([await Bun.file(join(import.meta.dir, "fixtures", "media", name)).bytes()]);
      const probe = await probeMedia(file, LIMITS, NO_WEBCODECS);
      expect(playbackOf(file, probe, 0, chromium)).toStrictEqual({ kind: "file", body: file, video: false });
      expect(playbackOf(file, probe, 0, () => false)).toStrictEqual({ kind: "recording" });
    }
  });

  test("the types asked about", () => {
    expect(playbackType("matroska", "AAC")).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(playbackType("matroska", "TrueHD")).toBeNull();
    expect(playbackType("ogg", "Opus")).toBe('audio/ogg; codecs="opus"');
  });
});

test("cueAt", () => {
  const cues = [
    { start: 0, end: 2000, line: 0 },
    { start: 1500, end: 3000, line: 4 },
    { start: 5000, end: 6000, line: 8 },
  ];
  expect(cueAt(cues, 0)).toBe(0);
  expect(cueAt(cues, 1600)).toBe(4);
  expect(cueAt(cues, 2500)).toBe(4);
  expect(cueAt(cues, 3000)).toBeNull();
  expect(cueAt(cues, 5999)).toBe(8);
  expect(cueAt([], 10)).toBeNull();
});
