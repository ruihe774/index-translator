import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { demux, type DemuxEvent, MatroskaTruncatedError, probeMatroska } from "../public/matroska";
import { concat } from "../public/ogg-opus";
import {
  blockPayload,
  chunked,
  ebmlHeader,
  element,
  float,
  ID,
  int16,
  openElement,
  opusHead,
  simpleBlock,
  text,
  track,
  uint,
} from "./helpers/ebml";

const media = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "media", name));

type Packet = Extract<DemuxEvent, { type: "packet" }>;

async function collect(src: ReadableStream<Uint8Array>, tracks?: ReadonlySet<number>) {
  const events: DemuxEvent[] = [];
  for await (const e of demux(src, { tracks })) {
    events.push(e);
  }
  const packets = events.filter((e): e is Packet => e.type === "packet");
  return { events, packets };
}

const frame = (byte: number, n: number) => new Uint8Array(n).fill(byte);

describe("files from ffmpeg and mkvmerge", () => {
  test("tracks, languages, names, default flags and duration", async () => {
    const { tracks, duration } = await probeMatroska(media("tracks.mkv").stream());
    expect(duration).toBeCloseTo(3.03, 2);
    expect(tracks.map((t) => [t.number, t.type, t.codecId, t.language, t.name, t.isDefault])).toStrictEqual([
      [1, "video", "V_MPEG4/ISO/AVC", "und", undefined, true],
      [2, "audio", "A_OPUS", "en", "Commentary", false],
      [3, "audio", "A_OPUS", "ja", undefined, true],
      [4, "audio", "A_AAC", "fr", undefined, true],
    ]);
    expect(tracks[1]!.codecDelayNs).toBe(6_500_000);
    expect(new TextDecoder().decode(tracks[1]!.codecPrivate!.subarray(0, 8))).toBe("OpusHead");
  });

  test("only the tracks asked for are read", async () => {
    const { packets } = await collect(media("tracks.mkv").stream(), new Set([3]));
    expect(packets).toHaveLength(151);
    expect(packets.every((p) => p.track === 3)).toBe(true);
    // The first packet starts the pre-skip early; the last one carries the padding to drop.
    expect(packets[0]!.timestamp).toBe(-6500);
    expect(packets.at(-1)!.discardPaddingNs).toBe(13_500_000);
  });

  test("a WebM as MediaRecorder writes it", async () => {
    const { tracks } = await probeMatroska(media("tone.webm").stream());
    expect(tracks.map((t) => [t.codecId, t.channels])).toStrictEqual([
      ["V_VP8", undefined],
      ["A_OPUS", 1],
    ]);
  });

  test("a compressed track is marked", async () => {
    const { tracks } = await probeMatroska(media("compressed.mkv").stream());
    expect(tracks[0]!.encoded).toBe(true);
    expect((await probeMatroska(media("late.mkv").stream())).tracks[0]!.encoded).toBe(false);
  });

  test("the same events whatever the chunk size", async () => {
    const bytes = await media("tone.webm").bytes();
    const whole = await collect(chunked(bytes, bytes.length));
    const small = await collect(chunked(bytes, 7));
    expect(small.events).toStrictEqual(whole.events);
  });
});

describe("written by hand", () => {
  const info = (...children: Uint8Array[]) => element(ID.Info, ...children);
  const opusTrack = track({
    number: 1,
    codecPrivate: opusHead(1),
    codecDelayNs: 6_500_000,
    channels: 1,
  });

  test("Xiph, EBML and fixed lacing, timed by DefaultDuration", async () => {
    const frames = [frame(1, 300), frame(2, 5), frame(3, 40)];
    const file = concat([
      ebmlHeader(),
      element(
        ID.Segment,
        element(ID.Tracks, track({ number: 1, codec: "A_TEST", defaultDurationNs: 20_000_000 })),
        element(
          ID.Cluster,
          uint(ID.Timecode, 1000),
          simpleBlock(1, 0, frames, "xiph"),
          simpleBlock(1, 60, frames, "ebml"),
          simpleBlock(1, 120, [frame(4, 6), frame(5, 6)], "fixed"),
        ),
      ),
    ]);
    const { packets } = await collect(chunked(file, 64));
    expect(packets.map((p) => [p.timestamp / 1000, p.frame, p.data.length, p.data[0]])).toStrictEqual([
      [1000, 0, 300, 1],
      [1020, 1, 5, 2],
      [1040, 2, 40, 3],
      [1060, 0, 300, 1],
      [1080, 1, 5, 2],
      [1100, 2, 40, 3],
      [1120, 0, 6, 4],
      [1140, 1, 6, 5],
    ]);
  });

  test("without a frame duration, the frames of a lace share the block's time", async () => {
    const file = concat([
      ebmlHeader(),
      element(
        ID.Segment,
        element(ID.Tracks, opusTrack),
        element(ID.Cluster, uint(ID.Timecode, 0), simpleBlock(1, 0, [frame(1, 4), frame(2, 4)], "xiph")),
      ),
    ]);
    const { packets } = await collect(chunked(file, 1000));
    expect(packets.map((p) => [p.timestamp, p.frame, p.duration])).toStrictEqual([
      [-6500, 0, undefined],
      [-6500, 1, undefined],
    ]);
  });

  test("a BlockGroup's duration and DiscardPadding", async () => {
    const group = element(
      ID.BlockGroup,
      int16(ID.DiscardPadding, 2500),
      uint(ID.BlockDuration, 20),
      element(ID.Block, blockPayload(1, 0, [frame(9, 3)])),
    );
    const file = concat([
      ebmlHeader(),
      element(ID.Segment, element(ID.Tracks, opusTrack), element(ID.Cluster, uint(ID.Timecode, 40), group)),
    ]);
    const { packets } = await collect(chunked(file, 1000));
    expect(packets).toStrictEqual([
      {
        type: "packet",
        track: 1,
        timestamp: 33_500,
        duration: 20_000,
        frame: 0,
        discardPaddingNs: 2500,
        keyframe: true,
        data: frame(9, 3),
      },
    ]);
  });

  test("a negative DiscardPadding is read as signed", async () => {
    const group = element(
      ID.BlockGroup,
      element(ID.Block, blockPayload(1, 0, [frame(9, 3)])),
      int16(ID.DiscardPadding, -1),
    );
    const file = concat([
      ebmlHeader(),
      element(ID.Segment, element(ID.Tracks, opusTrack), element(ID.Cluster, uint(ID.Timecode, 0), group)),
    ]);
    const { packets } = await collect(chunked(file, 1000));
    expect(packets[0]!.discardPaddingNs).toBe(-1);
  });

  test("live streams: Segment and Clusters of unknown size", async () => {
    const file = concat([
      ebmlHeader(),
      openElement(
        ID.Segment,
        element(ID.Tracks, opusTrack),
        openElement(ID.Cluster, uint(ID.Timecode, 0), simpleBlock(1, 0, [frame(1, 3)])),
        openElement(ID.Cluster, uint(ID.Timecode, 20), simpleBlock(1, 0, [frame(2, 3)])),
      ),
    ]);
    const { packets } = await collect(chunked(file, 5));
    expect(packets.map((p) => p.timestamp)).toStrictEqual([-6500, 13_500]);
  });

  test("Duration is scaled by a TimecodeScale written after it", async () => {
    const file = concat([
      ebmlHeader(),
      element(
        ID.Segment,
        info(float(ID.Duration, 2500), uint(ID.TimecodeScale, 100_000)),
        element(ID.Tracks, opusTrack),
        element(ID.Cluster, uint(ID.Timecode, 10), simpleBlock(1, 0, [frame(1, 3)])),
      ),
    ]);
    const { events, packets } = await collect(chunked(file, 1000));
    expect(events[0]).toMatchObject({
      type: "tracks",
      duration: 0.25,
      timecodeScale: 100_000,
    });
    expect(packets[0]!.timestamp).toBe(1000 - 6500);
  });

  test("LanguageBCP47 wins over Language in either order; ContentEncodings marks the track", async () => {
    const file = concat([
      ebmlHeader(),
      element(
        ID.Segment,
        element(
          ID.Tracks,
          track({
            number: 1,
            extra: [text(ID.LanguageBCP47, "zh-Hant"), text(ID.Language, "chi")],
          }),
          track({
            number: 2,
            extra: [text(ID.Language, "ger"), text(ID.LanguageBCP47, "de")],
          }),
          track({
            number: 3,
            extra: [element(ID.ContentEncodings, element(ID.ContentEncoding))],
          }),
        ),
      ),
    ]);
    const { tracks } = await probeMatroska(chunked(file, 1000));
    expect(tracks.map((t) => [t.language, t.encoded])).toStrictEqual([
      ["zh-Hant", false],
      ["de", false],
      ["eng", true],
    ]);
  });

  test("other tracks' blocks are skipped, whole", async () => {
    const big = frame(7, 100_000);
    const file = concat([
      ebmlHeader(),
      element(
        ID.Segment,
        element(ID.Tracks, track({ number: 1, type: 1, codec: "V_TEST" }), opusTrack),
        element(ID.Cluster, uint(ID.Timecode, 0), simpleBlock(1, 0, [big]), simpleBlock(1, 0, [frame(1, 3)])),
      ),
    ]);
    const all = await collect(chunked(file, 4096));
    expect(all.packets.map((p) => p.track)).toStrictEqual([1, 1]);
    const { packets } = await collect(chunked(file, 4096), new Set([2]));
    expect(packets).toStrictEqual([]);
  });

  test("chained segments each give their tracks", async () => {
    const segment = (codec: string) =>
      element(
        ID.Segment,
        element(ID.Tracks, track({ number: 1, codec })),
        element(ID.Cluster, uint(ID.Timecode, 0), simpleBlock(1, 0, [frame(1, 3)])),
      );
    const file = concat([ebmlHeader(), segment("A_ONE"), ebmlHeader(), segment("A_TWO")]);
    const { events } = await collect(chunked(file, 1000));
    expect(events.map((e) => (e.type === "tracks" ? e.tracks[0]!.codecId : e.type))).toStrictEqual([
      "A_ONE",
      "packet",
      "A_TWO",
      "packet",
    ]);
  });

  test("a file cut off inside an element", async () => {
    const file = concat([
      ebmlHeader(),
      element(
        ID.Segment,
        element(ID.Tracks, opusTrack),
        element(ID.Cluster, uint(ID.Timecode, 0), simpleBlock(1, 0, [frame(1, 50)])),
      ),
    ]);
    await expect(collect(chunked(file.subarray(0, -10), 1000))).rejects.toBeInstanceOf(MatroskaTruncatedError);
  });

  test("not EBML at all", async () => {
    await expect(collect(chunked(new TextEncoder().encode("\0\0\0 not a Matroska file"), 1000))).rejects.toThrow(
      "the file is damaged",
    );
  });

  test("stopping early cancels the source", async () => {
    let cancelled = false;
    const file = await media("tone.webm").bytes();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(file);
      },
      cancel() {
        cancelled = true;
      },
    });
    await probeMatroska(source);
    expect(cancelled).toBe(true);
  });
});
