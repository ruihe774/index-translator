// A track re-encoded for `POST /transcriptions` when it cannot be sent as it is (media-file.ts decides):
// AAC, Vorbis, FLAC, MP3 or PCM in WebM/MKV, Opus of more than two channels, a WAV file the server would
// not take whole, or any Opus for a server without libopus. WebCodecs' AudioDecoder decodes (PCM is read
// here), pcm.ts puts the samples on the file's timeline, mixes them down and resamples them, and they go
// out as Ogg Opus (64 kbps mono, 96 kbps stereo: stereo is kept because the server's music separation
// uses it) or, where the server or this browser has no Opus, as a mono 44.1 kHz WAV (30 minutes fit the
// server's 160 MiB; 16 kHz would hurt separation).
//
// A decoder's output timestamps run on from the first input unless it is flushed, so the input is
// watched for jumps (a gap at least GAP_US past where the last block ended, its length from Matroska or
// from the codec: `packetMicros`; for Vorbis, whose length needs its setup header, a step of more than
// UNTIMED_JUMP_US) and the decoder flushed before such a block: its next output then carries the block's
// time, and PcmTimeline fills the gap.
//
// `decoderConfig`, `pcmFormatOf` and `packetMicros` are pure; the rest needs WebCodecs
// (e2e/transcribe.spec.ts).

import { dequeued, OGG_TYPE, OggOpusEncoder, opusEncodable } from "./audio-upload.ts";
import type { TrackInfo } from "./matroska.ts";
import { opusPacketSamples } from "./ogg-opus.ts";
import {
  MAX_CHANNELS,
  type PcmFormat,
  type PcmOutput,
  PcmTimeline,
  type Planes,
  readPcm,
  type TimelineResult,
  WavWriter,
} from "./pcm.ts";

/** Opus bitrates by channel count. */
export const OPUS_BITRATE = { 1: 64_000, 2: 96_000 } as const;
/** The rate of a WAV body. */
export const WAV_RATE = 44_100;
/** A gap in a track's blocks that flushes the decoder (PcmTimeline fills what is at least this long). */
export const GAP_US = 10_000;
/** Without block durations, a step between blocks longer than any block plays is a gap. */
export const UNTIMED_JUMP_US = 1_000_000;
/** Chunks the decoder may hold before the next is given. */
const MAX_QUEUED = 8;

/** One encoded piece of the track, in order. */
export interface SourceChunk {
  /** Microseconds into the file. */
  timestamp: number;
  data: Uint8Array;
  /** Comes after a gap: the decoder is flushed first. */
  jump: boolean;
}

/** How a track is read: by a WebCodecs decoder, or as PCM. */
export type Reading = { decoder: AudioDecoderConfig } | { pcm: PcmFormat; rate: number };

const AAC_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8000, 7350];
const AAC_PROFILES: Record<string, number> = { MAIN: 1, LC: 2, SSR: 3, LTP: 4 };

/** An AudioSpecificConfig for the old `A_AAC/MPEG4/LC`-style IDs, which carry none (SBR is found by the decoder). */
function audioSpecificConfig(objectType: number, rate: number, channels: number): Uint8Array {
  const index = AAC_RATES.indexOf(rate);
  const bits: [number, number][] = [
    [objectType, 5],
    ...(index === -1
      ? [[15, 4] as [number, number], [rate, 24] as [number, number]]
      : [[index, 4] as [number, number]]),
    [channels, 4],
    [0, 3],
  ];
  const total = bits.reduce((n, [, w]) => n + w, 0);
  const out = new Uint8Array(Math.ceil(total / 8));
  let at = 0;
  for (const [value, width] of bits) {
    for (let b = width - 1; b >= 0; b--, at++) {
      if ((value >> b) & 1) {
        out[at >> 3]! |= 0x80 >> (at & 7);
      }
    }
  }
  return out;
}

/** The AAC object type an AudioSpecificConfig starts with. */
function objectTypeOf(asc: Uint8Array): number {
  const first = asc[0]! >> 3;
  return first === 31 ? 32 + (((asc[0]! & 7) << 3) | (asc[1]! >> 5)) : first;
}

/** The OpusHead's channel count, when the CodecPrivate is one. */
function opusChannels(head: Uint8Array | undefined): number | undefined {
  return head && head.length >= 19 && String.fromCharCode(...head.subarray(0, 8)) === "OpusHead" ? head[9] : undefined;
}

/** The WebCodecs configuration that decodes a Matroska audio track; null when no codec of WebCodecs is it. */
export function decoderConfig(t: TrackInfo): AudioDecoderConfig | null {
  const sampleRate = Math.round(t.sampleRate ?? 48_000);
  const numberOfChannels = t.channels ?? 2;
  const described = (codec: string) =>
    t.codecPrivate ? { codec, sampleRate, numberOfChannels, description: t.codecPrivate } : null;
  switch (t.codecId) {
    case "A_OPUS": {
      const channels = opusChannels(t.codecPrivate);
      return channels === undefined
        ? null
        : { codec: "opus", sampleRate: 48_000, numberOfChannels: channels, description: t.codecPrivate! };
    }
    case "A_VORBIS": {
      return described("vorbis");
    }
    case "A_FLAC": {
      return described("flac");
    }
    case "A_MPEG/L3": {
      return { codec: "mp3", sampleRate, numberOfChannels };
    }
    case "A_AC3": {
      return { codec: "ac-3", sampleRate, numberOfChannels };
    }
    case "A_EAC3": {
      return { codec: "ec-3", sampleRate, numberOfChannels };
    }
  }
  if (t.codecId === "A_AAC" && t.codecPrivate && t.codecPrivate.length >= 2) {
    return described(`mp4a.40.${objectTypeOf(t.codecPrivate)}`);
  }
  const legacy = /^A_AAC\/MPEG[24]\/(MAIN|LC|SSR|LTP)(?:\/SBR)?$/.exec(t.codecId);
  if (legacy) {
    const objectType = AAC_PROFILES[legacy[1]!]!;
    const description = t.codecPrivate ?? audioSpecificConfig(objectType, sampleRate, numberOfChannels);
    return { codec: `mp4a.40.${objectType}`, sampleRate, numberOfChannels, description };
  }
  return null;
}

const MP3_RATES = [44_100, 48_000, 32_000];

/** Samples in an MP3 frame, and its rate, from its header. */
function mp3Frame(data: Uint8Array): number | undefined {
  if (data.length < 4 || data[0] !== 0xff || (data[1]! & 0xe0) !== 0xe0) {
    return undefined;
  }
  const version = (data[1]! >> 3) & 3; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
  const layer = (data[1]! >> 1) & 3; // 1: layer III
  const rate = MP3_RATES[(data[2]! >> 2) & 3];
  if (version === 1 || layer !== 1 || rate === undefined) {
    return undefined;
  }
  const samples = version === 3 ? 1152 : 576;
  return (samples * 1e6) / (rate / (version === 3 ? 1 : version === 2 ? 2 : 4));
}

/** Samples in a FLAC frame, from its header's block size code. */
function flacSamples(data: Uint8Array): number | undefined {
  if (data.length < 6 || data[0] !== 0xff || (data[1]! & 0xfe) !== 0xf8) {
    return undefined;
  }
  const code = data[2]! >> 4;
  if (code === 1) {
    return 192;
  }
  if (code >= 2 && code <= 5) {
    return 576 << (code - 2);
  }
  if (code >= 8) {
    return 256 << (code - 8);
  }
  if (code !== 6 && code !== 7) {
    return undefined;
  }
  // The size follows the frame or sample number, UTF-8 coded: its length is in its first byte.
  let numberLength = 1;
  for (let mask = 0x80; data[4]! & mask && mask > 1; mask >>= 1) {
    numberLength++;
  }
  numberLength = numberLength === 1 ? 1 : numberLength - 1;
  const at = 4 + numberLength;
  return code === 6 ? (data[at] ?? 0) + 1 : (((data[at] ?? 0) << 8) | (data[at + 1] ?? 0)) + 1;
}

/**
 * How long each packet of a track plays, in microseconds, from the codec where Matroska does not say:
 * Opus from its TOC, AAC 1024 (or 960) samples, MP3 and FLAC from their frame headers, PCM from its size;
 * undefined for Vorbis and what is not one of these.
 */
export function packetMicros(t: TrackInfo): (data: Uint8Array) => number | undefined {
  const rate = t.sampleRate;
  const pcm = pcmFormatOf(t);
  if (pcm) {
    const frameBytes = (pcm.pcm.bits / 8) * pcm.pcm.channels;
    return (data) => (data.length / frameBytes / pcm.rate) * 1e6;
  }
  if (t.codecId === "A_OPUS") {
    return (data) => (opusPacketSamples(data) * 1e6) / 48_000;
  }
  if (t.codecId === "A_MPEG/L3") {
    return mp3Frame;
  }
  if (t.codecId === "A_FLAC" && rate) {
    return (data) => {
      const samples = flacSamples(data);
      return samples === undefined ? undefined : (samples * 1e6) / rate;
    };
  }
  const config = t.codecId.startsWith("A_AAC") ? decoderConfig(t) : null;
  if (config && rate) {
    const asc = config.description ? new Uint8Array(config.description as ArrayBuffer) : undefined;
    // GASpecificConfig's frameLengthFlag, after the object type, rate index and channels of a plain AAC config.
    const short = asc && asc.length >= 2 && asc[0]! >> 3 <= 4 && (asc[0]! & 7) !== 7 && (asc[1]! & 0x04) !== 0;
    const samples = short ? 960 : 1024;
    return () => (samples * 1e6) / rate;
  }
  return unknownLength;
}

const unknownLength = (_: Uint8Array): number | undefined => undefined;

/** How a Matroska PCM track's bytes are laid out; null when it is not PCM this page reads. */
export function pcmFormatOf(t: TrackInfo): { pcm: PcmFormat; rate: number } | null {
  const kinds: Record<string, { float: boolean; bigEndian: boolean }> = {
    "A_PCM/INT/LIT": { float: false, bigEndian: false },
    "A_PCM/INT/BIG": { float: false, bigEndian: true },
    "A_PCM/FLOAT/IEEE": { float: true, bigEndian: false },
  };
  const kind = kinds[t.codecId];
  const rate = t.sampleRate;
  if (!kind || !t.bitDepth || !rate || !Number.isInteger(rate)) {
    return null;
  }
  return { pcm: { ...kind, bits: t.bitDepth, channels: t.channels ?? 1 }, rate };
}

/** Whether this browser decodes `config`. */
export async function browserDecodes(config: AudioDecoderConfig): Promise<boolean> {
  if (typeof AudioDecoder === "undefined") {
    return false;
  }
  try {
    return (await AudioDecoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
}

/** An Ogg Opus body as PcmTimeline's output. */
class OpusOutput implements PcmOutput {
  readonly rate: number;
  private readonly encoder: OggOpusEncoder;

  constructor(readonly channels: 1 | 2) {
    this.encoder = new OggOpusEncoder(channels, OPUS_BITRATE[channels]);
    ({ rate: this.rate } = this.encoder);
  }

  write(planes: Planes) {
    return this.encoder.write(planes);
  }

  async finish() {
    return { body: new Blob([await this.encoder.finish()], { type: OGG_TYPE }), type: OGG_TYPE };
  }

  close() {
    this.encoder.close();
  }
}

export interface TranscodeOptions {
  /** The server takes Ogg Opus. */
  ogg: boolean;
  keepSeconds: number;
  /** The server's `max_bytes`. */
  maxBytes: number;
  leadLimitSeconds: number;
  signal?: AbortSignal;
}

/** The decoded audio's channels as planes. */
function planesOf(d: AudioData): Planes {
  return Array.from({ length: d.numberOfChannels }, (_, c) => {
    const plane = new Float32Array(d.numberOfFrames);
    d.copyTo(plane, { planeIndex: c, format: "f32-planar" });
    return plane;
  });
}

/** Decodes `chunks` into the timeline until they end or it is full. */
async function decode(
  chunks: AsyncIterable<SourceChunk> | Iterable<SourceChunk>,
  config: AudioDecoderConfig,
  timeline: PcmTimeline,
  signal?: AbortSignal,
) {
  const ready: AudioData[] = [];
  let failure: DOMException | undefined;
  const decoder = new AudioDecoder({
    output: (d) => void ready.push(d),
    error: (e) => void (failure = e),
  });
  const drain = async () => {
    while (ready.length > 0) {
      const d = ready.shift()!;
      try {
        if (!timeline.full) {
          await timeline.add(d.timestamp, planesOf(d), d.sampleRate);
        }
      } finally {
        d.close();
      }
    }
  };
  try {
    decoder.configure(config);
    for await (const c of chunks) {
      signal?.throwIfAborted();
      if (failure) {
        throw failure;
      }
      if (c.jump) {
        await decoder.flush();
        await drain();
      }
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: c.timestamp, data: c.data }));
      while (decoder.decodeQueueSize > MAX_QUEUED && decoder.state === "configured") {
        await dequeued(decoder);
      }
      await drain();
      if (timeline.full) {
        break;
      }
    }
    if (failure) {
      throw failure;
    }
    if (!timeline.full) {
      await decoder.flush();
      await drain();
    }
  } finally {
    for (const d of ready) {
      d.close();
    }
    if (decoder.state !== "closed") {
      decoder.close();
    }
  }
}

/**
 * The track re-encoded: Ogg Opus where the server takes it and this browser encodes it, else a mono
 * 44.1 kHz WAV. Rejects when decoding or encoding fails, or with the signal's reason.
 */
export async function transcode(
  chunks: AsyncIterable<SourceChunk> | Iterable<SourceChunk>,
  reading: Reading,
  o: TranscodeOptions,
): Promise<TimelineResult> {
  const opus = {
    1: o.ogg && (await opusEncodable(OPUS_BITRATE[1], 1)),
    2: o.ogg && (await opusEncodable(OPUS_BITRATE[2], 2)),
  };
  let opened: OpusOutput | null = null;
  const timeline = new PcmTimeline({
    keepSeconds: o.keepSeconds,
    leadLimitSeconds: o.leadLimitSeconds,
    output: (channels) => {
      if (channels > MAX_CHANNELS) {
        throw new Error(`it has ${channels} channels`);
      }
      const wanted = channels === 1 ? 1 : 2;
      if (opus[wanted]) {
        opened = new OpusOutput(wanted);
        return opened;
      }
      return new WavWriter(1, WAV_RATE, o.maxBytes);
    },
  });
  try {
    if ("decoder" in reading) {
      await decode(chunks, reading.decoder, timeline, o.signal);
    } else {
      for await (const c of chunks) {
        o.signal?.throwIfAborted();
        if (!(await timeline.add(c.timestamp, readPcm(c.data, reading.pcm), reading.rate))) {
          break;
        }
      }
    }
    o.signal?.throwIfAborted();
    return await timeline.finish();
  } finally {
    (opened as OpusOutput | null)?.close();
  }
}
