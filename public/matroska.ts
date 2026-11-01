// A forward-only, streaming Matroska (WebM, MKV) demuxer: no seeking, no Cues. It reads a file's tracks
// and the packets of the tracks asked for (media-file.ts remuxes an Opus track into Ogg for
// `POST /transcriptions`). Pure: no DOM, so tested by bun test (test/matroska.test.ts).
//
// - The EBML header is skipped without checking DocType, so WebM and MKV are the same here.
// - Timestamps and durations are integer microseconds, rounded from nanoseconds computed in float
//   math (exact up to 2^53 ns, about 104 days).
// - CodecDelay is subtracted from every packet timestamp, as the Matroska spec requires (ffmpeg does
//   the same). For Opus the first packets' timestamps are then negative by the pre-skip.
// - Laced blocks (Xiph, EBML, fixed) are split into one packet per frame. Frame i is timestamped block
//   + i × frame duration: the track's DefaultDuration, else BlockDuration / frame count; with neither,
//   every frame gets the block's timestamp and no duration.
// - A packet's duration is BlockDuration, else the track's DefaultDuration (RFC 9559); otherwise it is
//   undefined (the spec's gap to the next block would need lookahead).
// - DiscardPadding (a BlockGroup's, in nanoseconds) is given on the block's last frame.
// - The keyframes of the tracks in `keyframes` are reported (`keyframe` events) even when their packets
//   are not read: a SimpleBlock's flag, read from its header before the block is skipped, or a BlockGroup
//   without ReferenceBlock. transcribe-flow.ts times subtitles by a video's keyframes.
// - Chained segments (EBML header + Segment pairs back to back) each emit their own `tracks` event.
// - A ContentEncodings element (compression, encryption) is not undone: a track that has one is marked
//   with its `encoding` and its packets are not what its codec reads.
// - A stream that ends exactly at an element boundary finishes normally; one that ends inside an
//   element throws MatroskaTruncatedError; malformed data throws a plain Error.
// - When the consumer stops iterating early, or an error is thrown, the source is closed (a
//   ReadableStream is cancelled).
// - Where each TrackType's byte is (`typeAt`) and where the checksums over the track list are
//   (`checksums`) are noted in file offsets, for media-player.ts, which rewrites them in place.

export interface TrackInfo {
  number: number;
  type: "video" | "audio" | "other";
  /** For example `V_VP9`, `A_OPUS`. */
  codecId: string;
  codecPrivate?: Uint8Array;
  /** Built-in codec delay in ns (Opus pre-skip), already subtracted from packet timestamps. */
  codecDelayNs: number;
  /** Nominal duration of one frame in ns (20 ms for most Opus, 1/fps for video), if the muxer wrote it. */
  defaultDurationNs?: number;
  /** BCP 47 when the file has LanguageBCP47, else the ISO 639-2 code (`eng` by default, `und` for none). */
  language: string;
  name?: string;
  /** Where the TrackType's byte is in the file; undefined when its value is not one byte long. */
  typeAt?: number;
  /** FlagDefault: the player's choice among tracks of a type. */
  isDefault: boolean;
  /** FlagEnabled: a disabled track is not played. */
  enabled: boolean;
  /** The track has a ContentEncoding: its blocks are compressed or encrypted (encryption wins); null without. */
  encoding: "compressed" | "encrypted" | null;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  /** Bits per sample (BitDepth), for PCM. */
  bitDepth?: number;
}

export type DemuxEvent =
  | {
      type: "tracks";
      timecodeScale: number;
      /** The segment's Duration from its Info, in seconds; undefined when the muxer did not write it. */
      duration: number | undefined;
      tracks: TrackInfo[];
      /** Where the CRC-32 elements of Tracks and of its TrackEntries start in the file. */
      checksums: number[];
    }
  | {
      type: "packet";
      track: number;
      /** Presentation time in integer microseconds, CodecDelay already subtracted. */
      timestamp: number;
      /** Integer microseconds: BlockDuration, else DefaultDuration (per frame for laced blocks). */
      duration?: number;
      /**
       * The frame's place in its block (laced blocks hold several). Without a frame duration all frames of a
       * block have its timestamp, so only frame 0's is the time it plays at.
       */
      frame: number;
      /** Nanoseconds of decoded audio to drop at the end of this packet (DiscardPadding). */
      discardPaddingNs?: number;
      keyframe: boolean;
      data: Uint8Array;
    }
  | {
      type: "keyframe";
      track: number;
      /** Presentation time in integer microseconds, CodecDelay already subtracted. */
      timestamp: number;
    };

export interface DemuxOptions {
  /** Largest element that is buffered in memory (blocks, BlockGroups, CodecPrivate). Default 64 MiB. */
  maxElementSize?: number;
  /** Only these tracks' packets are read; the blocks of others are skipped without being buffered. */
  tracks?: ReadonlySet<number>;
  /** These tracks' keyframes are reported, whether or not their packets are read. */
  keyframes?: ReadonlySet<number>;
}

export class MatroskaTruncatedError extends Error {
  constructor(what: string) {
    super(`the file is cut off (in ${what})`);
    this.name = "MatroskaTruncatedError";
  }
}

const corrupt = (what: string) => new Error(`the file is damaged (${what})`);

// Element IDs, marker bits kept, as in the Matroska spec.
const ID = {
  Segment: 0x18_53_80_67,
  Info: 0x15_49_a9_66,
  Tracks: 0x16_54_ae_6b,
  TrackEntry: 0xae,
  Video: 0xe0,
  Audio: 0xe1,
  Cluster: 0x1f_43_b6_75,
  BlockGroup: 0xa0,
  TimecodeScale: 0x2a_d7_b1,
  Duration: 0x44_89,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  Name: 0x53_6e,
  Language: 0x22_b5_9c,
  LanguageBCP47: 0x22_b5_9d,
  CodecID: 0x86,
  CodecPrivate: 0x63_a2,
  CodecDelay: 0x56_aa,
  DefaultDuration: 0x23_e3_83,
  ContentEncodings: 0x6d_80,
  ContentEncoding: 0x62_40,
  ContentEncodingType: 0x50_33,
  ContentEncryption: 0x50_35,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x62_64,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  DiscardPadding: 0x75_a2,
  Crc32: 0xbf,
} as const;

const DEFAULT_TIMECODE_SCALE = 1_000_000;
const DEFAULT_MAX_ELEMENT_SIZE = 64 * 2 ** 20;

// Masters descended into without buffering. Everything else is a leaf: read if known, skipped
// otherwise. A BlockGroup is read whole (its size is always known), so its children may come in any
// order.
const MASTERS = new Set<number>([
  ID.Segment,
  ID.Info,
  ID.Tracks,
  ID.TrackEntry,
  ID.Video,
  ID.Audio,
  ID.ContentEncodings,
  ID.ContentEncoding,
  ID.Cluster,
]);
const TRACK_FIELDS = new Set<number>([
  ID.TrackNumber,
  ID.TrackType,
  ID.FlagEnabled,
  ID.FlagDefault,
  ID.Name,
  ID.Language,
  ID.LanguageBCP47,
  ID.CodecID,
  ID.CodecPrivate,
  ID.CodecDelay,
  ID.DefaultDuration,
  ID.PixelWidth,
  ID.PixelHeight,
  ID.SamplingFrequency,
  ID.Channels,
  ID.BitDepth,
  ID.ContentEncodingType,
]);
const LEAVES_READ = new Set<number>([
  ...TRACK_FIELDS,
  ID.TimecodeScale,
  ID.Duration,
  ID.Timecode,
  ID.SimpleBlock,
  ID.BlockGroup,
]);

/** The longest a track number's VINT can be. */
const MAX_VINT = 8;
/** A block's header after its track number: an int16 relative timestamp and the flags. */
const BLOCK_HEAD = 3;

class ByteQueue {
  private chunks: Uint8Array[] = [];
  private length = 0;
  /** Bytes consumed so far: the file offset of what `peek()` starts with. */
  position = 0;
  private ended = false;
  private readonly source: AsyncIterator<Uint8Array>;

  constructor(src: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>) {
    // Safari's ReadableStream is not async iterable.
    const iterable = Symbol.asyncIterator in src ? src : streamChunks(src);
    this.source = iterable[Symbol.asyncIterator]();
  }

  /** Buffers until `peek()` holds at least `n` contiguous bytes; false when the source ends first. */
  async ensure(n: number): Promise<boolean> {
    if (n === 0) {
      return true;
    }
    while (this.length < n && !this.ended) {
      const next = await this.source.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      if (next.value.length > 0) {
        this.chunks.push(next.value);
        this.length += next.value.length;
      }
    }
    if (this.length < n) {
      return false;
    }
    if (this.chunks[0]!.length < n) {
      // Only as many chunks are merged as needed.
      let total = 0;
      let k = 0;
      while (total < n) {
        total += this.chunks[k++]!.length;
      }
      const merged = new Uint8Array(total);
      let at = 0;
      for (let i = 0; i < k; i++) {
        merged.set(this.chunks[i]!, at);
        at += this.chunks[i]!.length;
      }
      this.chunks.splice(0, k, merged);
    }
    return true;
  }

  peek(): Uint8Array {
    return this.chunks[0] ?? new Uint8Array(0);
  }

  consume(n: number): void {
    this.length -= n;
    this.position += n;
    while (n > 0) {
      const chunk = this.chunks[0]!;
      if (n < chunk.length) {
        this.chunks[0] = chunk.subarray(n);
        return;
      }
      n -= chunk.length;
      this.chunks.shift();
    }
  }

  /** Drops `n` bytes without buffering them all; false when the source ends first. */
  async skip(n: number): Promise<boolean> {
    while (n > 0) {
      if (this.length === 0 && !(await this.ensure(1))) {
        return false;
      }
      const take = Math.min(n, this.length);
      this.consume(take);
      n -= take;
    }
    return true;
  }

  /** Closes the source if it has not ended (cancels a ReadableStream). */
  async close(): Promise<void> {
    if (this.ended) {
      return;
    }
    this.ended = true;
    try {
      await this.source.return?.();
    } catch {
      // the source has already failed
    }
  }
}

async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => {
        // already failed
      });
    }
    reader.releaseLock();
  }
}

/** A VINT's total length from its first byte; 0 when invalid. */
const vintLength = (first: number) => (first === 0 ? 0 : Math.clz32(first) - 23);

/** An element ID: 1 to 4 bytes, marker bit kept. */
function readId(b: Uint8Array, at: number): { length: number; value: number } | null {
  if (at >= b.length) {
    return null;
  }
  const length = vintLength(b[at]!);
  if (length === 0 || length > 4 || at + length > b.length) {
    return null;
  }
  let value = 0;
  for (let i = 0; i < length; i++) {
    value = value * 256 + b[at + i]!;
  }
  return { length, value };
}

/** A size VINT, marker stripped. All data bits set means "unknown". */
function readVint(b: Uint8Array, at: number): { length: number; value: number; unknown: boolean } | null {
  if (at >= b.length) {
    return null;
  }
  const first = b[at]!;
  const length = vintLength(first);
  if (length === 0 || at + length > b.length) {
    return null;
  }
  const mask = 0xff >> length;
  let value = first & mask;
  let allOnes = value === mask;
  for (let i = 1; i < length; i++) {
    const x = b[at + i]!;
    value = value * 256 + x;
    if (x !== 0xff) {
      allOnes = false;
    }
  }
  if (allOnes) {
    return { length, value: -1, unknown: true };
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw corrupt("a size over 2^53 - 1");
  }
  return { length, value, unknown: false };
}

// Per EBML (RFC 8794), an empty integer or float element has its default value.
function readUint(b: Uint8Array, fallback: number): number {
  if (b.length === 0) {
    return fallback;
  }
  if (b.length > 8) {
    throw corrupt("an integer longer than 8 bytes");
  }
  let value = 0;
  for (const x of b) {
    value = value * 256 + x;
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw corrupt("an integer over 2^53 - 1");
  }
  return value;
}

function readInt(b: Uint8Array): number {
  if (b.length === 0) {
    return 0;
  }
  const value = readUint(b, 0);
  // Two's complement over the element's width.
  return b[0]! & 0x80 ? value - 2 ** (8 * b.length) : value;
}

function readFloat(b: Uint8Array, fallback: number): number {
  if (b.length === 0) {
    return fallback;
  }
  const view = new DataView(b.buffer, b.byteOffset, b.length);
  if (b.length === 4) {
    return view.getFloat32(0);
  }
  if (b.length === 8) {
    return view.getFloat64(0);
  }
  throw corrupt(`a float of ${b.length} bytes`);
}

const utf8 = new TextDecoder();
const readString = (b: Uint8Array) => utf8.decode(b).replace(/\0+$/, "");

/** Tracks whose language came from LanguageBCP47. */
const bcp47 = new WeakSet<TrackInfo>();

function setTrackField(t: TrackInfo, id: number, p: Uint8Array): void {
  switch (id) {
    case ID.TrackNumber: {
      t.number = readUint(p, 0);
      break;
    }
    case ID.TrackType: {
      const type = readUint(p, 0);
      t.type = type === 1 ? "video" : type === 2 ? "audio" : "other";
      break;
    }
    case ID.FlagEnabled: {
      t.enabled = readUint(p, 1) !== 0;
      break;
    }
    case ID.FlagDefault: {
      t.isDefault = readUint(p, 1) !== 0;
      break;
    }
    case ID.Name: {
      t.name = readString(p);
      break;
    }
    case ID.Language: {
      // LanguageBCP47 wins wherever it is written.
      if (!bcp47.has(t)) {
        t.language = readString(p) || "eng";
      }
      break;
    }
    case ID.LanguageBCP47: {
      t.language = readString(p) || t.language;
      bcp47.add(t);
      break;
    }
    case ID.CodecID: {
      t.codecId = readString(p);
      break;
    }
    case ID.CodecPrivate: {
      t.codecPrivate = p.slice();
      break;
    }
    case ID.CodecDelay: {
      t.codecDelayNs = readUint(p, 0);
      break;
    }
    case ID.DefaultDuration: {
      const ns = readUint(p, 0);
      t.defaultDurationNs = ns > 0 ? ns : undefined;
      break;
    }
    case ID.PixelWidth: {
      t.width = readUint(p, 0);
      break;
    }
    case ID.PixelHeight: {
      t.height = readUint(p, 0);
      break;
    }
    case ID.SamplingFrequency: {
      t.sampleRate = readFloat(p, 8000);
      break;
    }
    case ID.BitDepth: {
      t.bitDepth = readUint(p, 0) || undefined;
      break;
    }
    case ID.ContentEncodingType: {
      // 0 is compression, 1 encryption.
      if (readUint(p, 0) === 1) {
        t.encoding = "encrypted";
      }
      break;
    }
    case ID.Channels: {
      t.channels = readUint(p, 1);
      break;
    }
  }
}

const newTrack = (): TrackInfo => ({
  number: 0,
  type: "other",
  codecId: "",
  codecDelayNs: 0,
  language: "eng",
  isDefault: true,
  enabled: true,
  encoding: null,
});

/** A big-endian int16 at `at` (a block's relative timestamp). */
const readInt16 = (b: Uint8Array, at: number) => (((b[at]! << 8) | b[at + 1]!) << 16) >> 16;

interface ParsedBlock {
  track: number;
  relativeTicks: number;
  flags: number;
  frames: Uint8Array[];
}

/** A SimpleBlock's or Block's payload: track VINT, int16 relative timestamp, flags, then the frames (maybe laced). */
function parseBlock(b: Uint8Array): ParsedBlock {
  const track = readVint(b, 0);
  if (!track || track.unknown || track.value === 0) {
    throw corrupt("a block with no track number");
  }
  let at = track.length;
  if (b.length < at + 3) {
    throw corrupt("a block header too short");
  }
  const relativeTicks = readInt16(b, at);
  const flags = b[at + 2]!;
  at += 3;
  const base = { track: track.value, relativeTicks, flags };
  const lacing = (flags >> 1) & 3; // 0 none, 1 Xiph, 2 fixed, 3 EBML
  if (lacing === 0) {
    return { ...base, frames: [b.slice(at)] };
  }

  if (at >= b.length) {
    throw corrupt("a laced block with no frame count");
  }
  const count = b[at++]! + 1;
  const sizes: number[] = [];
  if (lacing === 2) {
    const rest = b.length - at;
    if (rest % count !== 0) {
      throw corrupt("fixed lacing that does not divide the block");
    }
    for (let i = 0; i < count; i++) {
      sizes.push(rest / count);
    }
  } else {
    if (lacing === 1) {
      for (let i = 0; i < count - 1; i++) {
        let size = 0;
        let x: number;
        do {
          if (at >= b.length) {
            throw corrupt("Xiph lace sizes past the block");
          }
          x = b[at++]!;
          size += x;
        } while (x === 255);
        sizes.push(size);
      }
    } else if (count > 1) {
      const first = readVint(b, at);
      if (!first || first.unknown) {
        throw corrupt("a bad EBML lace size");
      }
      at += first.length;
      let size = first.value;
      sizes.push(size);
      for (let i = 1; i < count - 1; i++) {
        const delta = readVint(b, at);
        if (!delta || delta.unknown) {
          throw corrupt("a bad EBML lace size");
        }
        at += delta.length;
        size += delta.value - (2 ** (7 * delta.length - 1) - 1); // a signed VINT
        if (size < 0) {
          throw corrupt("a negative EBML lace size");
        }
        sizes.push(size);
      }
    }
    const used = sizes.reduce((a, c) => a + c, 0);
    const last = b.length - at - used;
    if (last < 0) {
      throw corrupt("lace sizes past the block");
    }
    sizes.push(last);
  }
  const frames: Uint8Array[] = [];
  for (const size of sizes) {
    frames.push(b.slice(at, at + size));
    at += size;
  }
  return { ...base, frames };
}

interface ParsedGroup {
  block?: Uint8Array;
  durationTicks?: number;
  discardPaddingNs?: number;
  hasReference: boolean;
}

/** A whole BlockGroup; its children may come in any order. */
function parseBlockGroup(g: Uint8Array): ParsedGroup {
  const group: ParsedGroup = { hasReference: false };
  for (let at = 0; at < g.length;) {
    const id = readId(g, at);
    if (!id) {
      throw corrupt("a bad element ID in a BlockGroup");
    }
    const size = readVint(g, at + id.length);
    if (!size || size.unknown) {
      throw corrupt("a bad element size in a BlockGroup");
    }
    const start = at + id.length + size.length;
    const end = start + size.value;
    if (end > g.length) {
      throw corrupt("an element past the end of its BlockGroup");
    }
    const p = g.subarray(start, end);
    if (id.value === ID.Block) {
      group.block = p;
    } else if (id.value === ID.BlockDuration) {
      group.durationTicks = readUint(p, 0);
    } else if (id.value === ID.DiscardPadding) {
      group.discardPaddingNs = readInt(p);
    } else if (id.value === ID.ReferenceBlock) {
      group.hasReference = true;
    }
    at = end;
  }
  return group;
}

export async function* demux(
  src: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: DemuxOptions = {},
): AsyncGenerator<DemuxEvent> {
  const maxElementSize = options.maxElementSize ?? DEFAULT_MAX_ELEMENT_SIZE;
  const wanted = options.tracks;
  const keyframesOf = options.keyframes;
  const q = new ByteQueue(src);
  let timecodeScale = DEFAULT_TIMECODE_SCALE;
  let durationTicks: number | undefined;
  let tracks: TrackInfo[] = [];
  let checksums: number[] = [];
  let current: TrackInfo | null = null;
  /** The master just entered, while none of its children has been read: a CRC-32 comes first. */
  let entered: number | null = null;
  let clusterTime = 0;
  let tracksEmitted = false;
  let segmentSeen = false;

  const tracksEvent = (): DemuxEvent => {
    tracksEmitted = true;
    const duration = durationTicks === undefined ? undefined : (durationTicks * timecodeScale) / 1e9;
    return { type: "tracks", timecodeScale, duration, tracks, checksums };
  };

  /** Where a block of `trackNumber` starts, in ns: its cluster's time plus its own, less CodecDelay. */
  const blockStartNs = (trackNumber: number, relativeTicks: number) =>
    (clusterTime + relativeTicks) * timecodeScale - (tracks.find((t) => t.number === trackNumber)?.codecDelayNs ?? 0);

  function* keyframe(trackNumber: number, relativeTicks: number): Generator<DemuxEvent> {
    if (keyframesOf?.has(trackNumber)) {
      yield {
        type: "keyframe",
        track: trackNumber,
        timestamp: Math.round(blockStartNs(trackNumber, relativeTicks) / 1000),
      };
    }
  }

  function* packets(block: ParsedBlock, keyframe: boolean, group?: ParsedGroup): Generator<DemuxEvent> {
    if (wanted && !wanted.has(block.track)) {
      return;
    }
    const track = tracks.find((t) => t.number === block.track);
    const startNs = blockStartNs(block.track, block.relativeTicks);
    const n = block.frames.length;
    const blockNs = group?.durationTicks === undefined ? undefined : group.durationTicks * timecodeScale;
    // BlockDuration's implicit default is the track's DefaultDuration (RFC 9559).
    const frameNs =
      n === 1
        ? (blockNs ?? track?.defaultDurationNs)
        : (track?.defaultDurationNs ?? (blockNs === undefined ? undefined : blockNs / n));
    for (let i = 0; i < n; i++) {
      yield {
        type: "packet",
        track: block.track,
        timestamp: Math.round((startNs + i * (frameNs ?? 0)) / 1000),
        frame: i,
        duration: frameNs === undefined ? undefined : Math.round(frameNs / 1000),
        ...(i === n - 1 &&
          group?.discardPaddingNs !== undefined && {
            discardPaddingNs: group.discardPaddingNs,
          }),
        keyframe,
        data: block.frames[i]!,
      };
    }
  }

  try {
    for (;;) {
      // The header is read piece by piece, so nothing past it is waited for.
      if (!(await q.ensure(1))) {
        break; // a clean end at an element boundary
      }
      const start = q.position;
      const parent = entered;
      entered = null;
      const idLength = vintLength(q.peek()[0]!);
      if (idLength === 0 || idLength > 4) {
        throw corrupt("a bad element ID");
      }
      if (!(await q.ensure(idLength + 1))) {
        throw new MatroskaTruncatedError("an element header");
      }
      const sizeLength = vintLength(q.peek()[idLength]!);
      if (sizeLength === 0) {
        throw corrupt("a bad element size");
      }
      if (!(await q.ensure(idLength + sizeLength))) {
        throw new MatroskaTruncatedError("an element header");
      }
      const head = q.peek();
      const id = readId(head, 0)!;
      const size = readVint(head, idLength)!;
      q.consume(idLength + sizeLength);

      if (MASTERS.has(id.value)) {
        // Descend. Unknown sizes (live streams) need nothing: the ends of masters are never tracked.
        if (id.value === ID.Segment) {
          if (segmentSeen) {
            // A chained segment starts afresh.
            if (!tracksEmitted) {
              yield tracksEvent();
            }
            tracks = [];
            checksums = [];
            current = null;
            timecodeScale = DEFAULT_TIMECODE_SCALE;
            durationTicks = undefined;
            clusterTime = 0;
            tracksEmitted = false;
          }
          segmentSeen = true;
        } else if (id.value === ID.TrackEntry) {
          current = newTrack();
          tracks.push(current);
        } else if (id.value === ID.ContentEncoding && current) {
          // Compression unless its type or a ContentEncryption says otherwise.
          current.encoding ??= "compressed";
        } else if (id.value === ID.Cluster && !tracksEmitted) {
          yield tracksEvent();
        }
        entered = id.value;
        continue;
      }

      const hex = id.value.toString(16);
      if (size.unknown) {
        throw corrupt(`an unknown size on element 0x${hex}`);
      }
      if (id.value === ID.ContentEncryption && current) {
        current.encoding = "encrypted";
      }
      if (id.value === ID.Crc32 && (parent === ID.Tracks || parent === ID.TrackEntry)) {
        checksums.push(start);
      }
      // A block of a track not asked for is skipped after reading its track number (and, for a track
      // whose keyframes are asked for, its time and flags).
      if (wanted && id.value === ID.SimpleBlock && size.value > 0) {
        if (!(await q.ensure(Math.min(size.value, MAX_VINT + BLOCK_HEAD)))) {
          throw new MatroskaTruncatedError(`element 0x${hex}`);
        }
        const head = q.peek();
        const track = readVint(head, 0);
        if (track && !track.unknown && !wanted.has(track.value)) {
          const at = track.length;
          if (size.value >= at + BLOCK_HEAD && (head[at + 2]! & 0x80) !== 0) {
            yield* keyframe(track.value, readInt16(head, at));
          }
          if (!(await q.skip(size.value))) {
            throw new MatroskaTruncatedError(`element 0x${hex}`);
          }
          continue;
        }
      }
      if (!LEAVES_READ.has(id.value)) {
        if (!(await q.skip(size.value))) {
          throw new MatroskaTruncatedError(`element 0x${hex}`);
        }
        continue;
      }
      if (size.value > maxElementSize) {
        throw corrupt(`element 0x${hex} of ${size.value} bytes`);
      }
      if (!(await q.ensure(size.value))) {
        throw new MatroskaTruncatedError(`element 0x${hex}`);
      }
      const p = q.peek().subarray(0, size.value);

      if (TRACK_FIELDS.has(id.value)) {
        // Strays outside a TrackEntry are ignored.
        if (current) {
          setTrackField(current, id.value, p);
          if (id.value === ID.TrackType) {
            current.typeAt = size.value === 1 ? q.position : undefined;
          }
        }
      } else {
        switch (id.value) {
          case ID.TimecodeScale: {
            timecodeScale = readUint(p, DEFAULT_TIMECODE_SCALE);
            if (timecodeScale === 0) {
              throw corrupt("a TimecodeScale of 0");
            }
            break;
          }
          case ID.Duration: {
            durationTicks = readFloat(p, 0) || undefined;
            break;
          }
          case ID.Timecode: {
            clusterTime = readUint(p, 0);
            break;
          }
          case ID.SimpleBlock: {
            const block = parseBlock(p);
            if ((block.flags & 0x80) !== 0) {
              yield* keyframe(block.track, block.relativeTicks);
            }
            yield* packets(block, (block.flags & 0x80) !== 0);
            break;
          }
          case ID.BlockGroup: {
            const group = parseBlockGroup(p);
            if (group.block) {
              const block = parseBlock(group.block);
              if (!group.hasReference) {
                yield* keyframe(block.track, block.relativeTicks);
              }
              yield* packets(block, !group.hasReference, group);
            }
            break;
          }
        }
      }
      q.consume(size.value);
    }
    if (!tracksEmitted) {
      yield tracksEvent();
    }
  } finally {
    await q.close();
  }
}

/** The first segment's tracks and duration, read up to its first Cluster; the rest is not read. */
export async function probeMatroska(
  src: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<{ duration: number | undefined; tracks: TrackInfo[]; checksums: number[] }> {
  for await (const event of demux(src, { tracks: new Set() })) {
    if (event.type === "tracks") {
      return { duration: event.duration, tracks: event.tracks, checksums: event.checksums };
    }
  }
  return { duration: undefined, tracks: [], checksums: [] };
}
