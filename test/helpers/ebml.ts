// A tiny EBML writer for Matroska files the tests need and no muxer writes on request: gaps,
// lacing, unknown sizes, chained segments, files cut off midway.

import { concat } from "../../public/ogg-opus";

/** An element ID's bytes (marker bits included, as the spec writes them). */
function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) {
    out.unshift(v % 256);
  }
  return out;
}

/** A size as an 8-byte VINT, or the 1-byte "unknown". */
function sizeBytes(size: number | "unknown"): number[] {
  if (size === "unknown") {
    return [0xff];
  }
  const out = [0x01];
  for (let i = 6; i >= 0; i--) {
    out.push(Math.floor(size / 256 ** i) % 256);
  }
  return out;
}

export function element(id: number, ...children: Uint8Array[]): Uint8Array {
  const body = concat(children);
  return concat([new Uint8Array([...idBytes(id), ...sizeBytes(body.length)]), body]);
}

/** A master of unknown size, as a live stream writes Segment and Cluster. */
export function openElement(id: number, ...children: Uint8Array[]): Uint8Array {
  return concat([new Uint8Array([...idBytes(id), ...sizeBytes("unknown")]), ...children]);
}

export function uint(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) {
    bytes.unshift(v % 256);
  }
  return element(id, new Uint8Array(bytes.length ? bytes : [0]));
}

/** A signed integer in two bytes. */
export function int16(id: number, value: number): Uint8Array {
  const v = value < 0 ? value + 0x1_00_00 : value;
  return element(id, new Uint8Array([v >> 8, v & 0xff]));
}

export function float(id: number, value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return element(id, bytes);
}

export const text = (id: number, value: string) => element(id, new TextEncoder().encode(value));

export const ID = {
  EBML: 0x1a_45_df_a3,
  DocType: 0x42_82,
  Segment: 0x18_53_80_67,
  Info: 0x15_49_a9_66,
  TimecodeScale: 0x2a_d7_b1,
  Duration: 0x44_89,
  Tracks: 0x16_54_ae_6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
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
  BitDepth: 0x62_64,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f_43_b6_75,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  DiscardPadding: 0x75_a2,
  Void: 0xec,
} as const;

export const ebmlHeader = (docType = "webm") => element(ID.EBML, text(ID.DocType, docType));

/** An OpusHead as Matroska's CodecPrivate holds it (family 0 unless `family` is given). */
export function opusHead(channels: number, preSkip = 312, family = 0): Uint8Array {
  const head = new Uint8Array(family === 0 ? 19 : 21 + channels);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1;
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, 48_000, true);
  head[18] = family;
  if (family !== 0) {
    head[19] = channels;
    head[20] = 0;
    for (let i = 0; i < channels; i++) {
      head[21 + i] = i;
    }
  }
  return head;
}

export interface TrackSpec {
  number: number;
  codec?: string;
  type?: number;
  channels?: number;
  codecPrivate?: Uint8Array;
  codecDelayNs?: number;
  defaultDurationNs?: number;
  extra?: Uint8Array[];
}

export function track(t: TrackSpec): Uint8Array {
  return element(
    ID.TrackEntry,
    uint(ID.TrackNumber, t.number),
    uint(ID.TrackType, t.type ?? 2),
    text(ID.CodecID, t.codec ?? "A_OPUS"),
    ...(t.codecPrivate ? [element(ID.CodecPrivate, t.codecPrivate)] : []),
    ...(t.codecDelayNs === undefined ? [] : [uint(ID.CodecDelay, t.codecDelayNs)]),
    ...(t.defaultDurationNs === undefined ? [] : [uint(ID.DefaultDuration, t.defaultDurationNs)]),
    ...(t.channels === undefined ? [] : [element(ID.Audio, uint(ID.Channels, t.channels))]),
    ...(t.extra ?? []),
  );
}

/** A SimpleBlock or Block payload: track, relative time, flags, then the frames, laced as asked. */
export function blockPayload(
  trackNumber: number,
  relative: number,
  frames: Uint8Array[],
  lacing: "none" | "xiph" | "ebml" | "fixed" = "none",
  flags = 0x80,
): Uint8Array {
  const rel = relative < 0 ? relative + 0x1_00_00 : relative;
  const lacingBits = { none: 0, xiph: 1, fixed: 2, ebml: 3 }[lacing];
  const head = [0x80 | trackNumber, rel >> 8, rel & 0xff, flags | (lacingBits << 1)];
  if (lacing === "none") {
    return concat([new Uint8Array(head), frames[0]!]);
  }
  head.push(frames.length - 1);
  if (lacing === "xiph") {
    for (const f of frames.slice(0, -1)) {
      let n = f.length;
      for (; n >= 255; n -= 255) {
        head.push(255);
      }
      head.push(n);
    }
  } else if (lacing === "ebml" && frames.length > 1) {
    // First size as an unsigned 2-byte VINT, then signed 2-byte differences.
    const first = frames[0]!.length;
    head.push(0x40 | (first >> 8), first & 0xff);
    for (let i = 1; i < frames.length - 1; i++) {
      const d = frames[i]!.length - frames[i - 1]!.length + 0x1f_ff;
      head.push(0x40 | (d >> 8), d & 0xff);
    }
  }
  return concat([new Uint8Array(head), ...frames]);
}

export const simpleBlock = (...args: Parameters<typeof blockPayload>) => element(ID.SimpleBlock, blockPayload(...args));

/** A stream of `bytes` cut into chunks of `size` bytes, to exercise reads across chunk boundaries. */
export function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

/** A 20 ms CELT packet with `n` bytes after its TOC (stereo with `stereo`): enough for the muxers and tests. */
export function opusPacket(n = 3, stereo = false): Uint8Array {
  const p = new Uint8Array(1 + n);
  p[0] = stereo ? 0xfc : 0xf8;
  p.fill(0x11, 1);
  return p;
}
