// A recording or video opened to be transcribed (`POST /transcriptions`): which file it is, which of its
// audio tracks can be sent, and the body that is sent. What the server takes goes without re-encoding: a
// WAV or Ogg Opus file as it is (or cut at the server's limit), and a mono or stereo Opus track of a WebM
// or MKV file remuxed into Ogg Opus (matroska.ts reads it, ogg-opus.ts writes it). Everything else that
// can be decoded is re-encoded by transcode.ts: other codecs, Opus of more channels, a WAV file of
// another rate or channel count or too large to go whole, and any Opus when the server has no libopus.
// Which tracks this browser decodes is asked of it (`Capabilities`). Pure apart from the Blob it reads and
// transcode.ts, so tested by bun test (test/media-file.test.ts) where there is no WebCodecs.
//
// Ogg plays its packets back to back while Matroska stamps each block with its time, so where the
// Matroska track skips ahead (audio that starts late, a recorder that dropped packets) the remux fills
// the gap with Opus packets of digital silence: the Ogg timeline stays the file's, and the segment times
// the server answers are times in the video. Audio that starts more than LEAD_LIMIT_SECONDS late is
// not filled from 0 (that could use up the server's limit on silence); the Ogg file starts at its
// first packet and `offset` says how far into the file that is.
//
// While a Matroska file is demuxed for its audio, the keyframes of its video are noted too (only the
// blocks' headers are read): cue-timing.ts moves cue edges onto the cuts they mark.

import type { Health } from "../src/api.ts";
import { demux, probeMatroska, type TrackInfo } from "./matroska.ts";
import { demuxOggOpus, OggOpusMuxer, opusPacketSamples } from "./ogg-opus.ts";
import { MAX_CHANNELS, type PcmFormat, pcmReadable } from "./pcm.ts";
import {
  browserDecodes,
  decoderConfig,
  GAP_US,
  packetMicros,
  pcmFormatOf,
  type Reading,
  type SourceChunk,
  transcode,
  UNTIMED_JUMP_US,
} from "./transcode.ts";

export type Container = "wav" | "ogg" | "matroska";

export const OGG_TYPE = "audio/ogg";
export const WAV_TYPE = "audio/wav";

/** What the server takes, from `/health` `transcribe`. */
export interface Limits {
  maxSeconds: number;
  maxBytes: number;
  minRate: number;
  maxRate: number;
}

export function limitsOf(t: NonNullable<Health["transcribe"]>): Limits {
  return {
    maxSeconds: t.max_seconds,
    maxBytes: t.max_bytes,
    minRate: t.sample_rate.min,
    maxRate: t.sample_rate.max,
  };
}

/** One audio track of the file as the dialog lists it; a WAV or Ogg file has one, numbered 0. */
export interface AudioTrack {
  number: number;
  /** The language's name in English, when the file says which (not `und`). */
  language?: string;
  name?: string;
  /** Opus, AAC, …, or the Matroska codec ID when it has no common name. */
  codec: string;
  channels?: number;
  isDefault: boolean;
  /** Why it cannot be sent (a sentence); null when it can. */
  problem: string | null;
}

export interface MediaProbe {
  container: Container;
  /** Seconds, when the file says. */
  duration: number | undefined;
  tracks: AudioTrack[];
  /** Seconds the server will get when that is less than `duration`: it is cut there. */
  cutAt: number | undefined;
  /** A Matroska file's layout, for playing it with only the chosen audio track (media-player.ts). */
  matroska?: MatroskaLayout;
}

export interface MatroskaLayout {
  video: boolean;
  /** Every audio track in the file's order, with where its TrackType's byte is. */
  audio: { number: number; typeAt: number | undefined }[];
  /** Where the CRC-32 elements over the track list start. */
  checksums: number[];
}

/** The body of `POST /transcriptions`. */
export interface Recording {
  body: Blob;
  type: typeof OGG_TYPE | typeof WAV_TYPE;
  /** Seconds of audio in it. */
  seconds: number;
  /** Cut short at the server's limit. */
  cut: boolean;
  /** Seconds into the file at which the recording starts: add to every time the server answers. */
  offset: number;
  /** The video's keyframes, when the file has a video. */
  video?: VideoFrames;
}

/** Where a video's keyframes are, as read while demuxing; times in seconds of the file. */
export interface VideoFrames {
  /** In the order the file has them, up to where the recording ends. */
  keyframes: number[];
  /** One frame's length (the track's DefaultDuration), when the file says. */
  frameSeconds: number | undefined;
}

/** The video a Matroska file's keyframes are taken from, and where they are collected. */
interface KeyframeSink {
  track: number;
  frames: VideoFrames;
}

/** Collects the keyframes of the file's first video track that plays; undefined without one. */
function keyframeSink(tracks: TrackInfo[]): KeyframeSink | undefined {
  const t = tracks.find((x) => x.type === "video" && x.enabled);
  return (
    t && {
      track: t.number,
      frames: {
        keyframes: [],
        frameSeconds: t.defaultDurationNs === undefined ? undefined : t.defaultDurationNs / 1e9,
      },
    }
  );
}

/** The demux options that read `track`'s packets and note the keyframes `video` collects. */
const demuxing = (track: number, video: KeyframeSink | undefined) => ({
  tracks: new Set([track]),
  keyframes: video && new Set([video.track]),
});

/** Why a file cannot be transcribed at all, as a sentence. */
export class MediaError extends Error {}

/** What the server and this browser can do with audio. */
export interface Capabilities {
  /** The server takes Ogg Opus (`upload_types`). */
  ogg: boolean;
  /** Whether this browser decodes `config` (WebCodecs). */
  decodes(config: AudioDecoderConfig): Promise<boolean>;
}

const BROWSER: Capabilities = { ogg: true, decodes: browserDecodes };

/** Opus always codes at 48 kHz. */
const RATE = 48_000;
/** A packet of Opus silence lasts 20 ms. */
const SILENCE_SAMPLES = 960;
/** 20 ms of CELT, fullband, mono (or stereo), one frame, with the silence flag set: decodes to zeros. */
const SILENCE = {
  1: new Uint8Array([0xf8, 0xff, 0xfe]),
  2: new Uint8Array([0xfc, 0xff, 0xfe]),
};
/** A late start up to this long is filled with silence; one later sets `offset` instead. */
export const LEAD_LIMIT_SECONDS = 10;
/**
 * A Matroska track that says it is at most this much longer than the server's limit is not called cut: it
 * is codec padding past a recording of exactly the limit.
 */
const CUT_SLACK_SECONDS = 0.5;
/** Room left under the server's byte limit for Ogg page headers. */
const PAGE_MARGIN = 64 * 1024;
/** An Ogg file is read whole to be checked; one this large is not. */
export const MAX_OGG_BYTES = 512 * 2 ** 20;
/** How much of a WAV file is read for its header. */
const WAV_HEAD_BYTES = 2 ** 20;

/** The container a file's first bytes say it is; null when none of those. */
export function sniff(head: Uint8Array): Container | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") {
    return "wav";
  }
  if (ascii(0, 4) === "OggS") {
    return "ogg";
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return "matroska";
  }
  return null;
}

const CODECS: Record<string, string> = {
  A_OPUS: "Opus",
  A_VORBIS: "Vorbis",
  A_FLAC: "FLAC",
  "A_MPEG/L3": "MP3",
  "A_MPEG/L2": "MP2",
  A_AC3: "AC-3",
  A_EAC3: "E-AC-3",
  A_TRUEHD: "TrueHD",
  A_ALAC: "ALAC",
};

function codecName(id: string): string {
  if (id.startsWith("A_AAC")) {
    return "AAC";
  }
  if (id.startsWith("A_DTS")) {
    return "DTS";
  }
  if (id.startsWith("A_PCM")) {
    return "PCM";
  }
  return CODECS[id] ?? id;
}

let languageNames: Intl.DisplayNames | null | undefined;

/** A language code's name in English (the page's language), or the code when it has none. */
function languageName(code: string): string | undefined {
  if (!code || code === "und" || code === "zxx" || code === "mul") {
    return undefined;
  }
  try {
    languageNames ??= new Intl.DisplayNames(["en"], {
      type: "language",
      fallback: "code",
    });
    return languageNames.of(code) ?? code;
  } catch {
    // not a well-formed tag
    return code;
  }
}

interface OpusHeadInfo {
  channels: number;
  preSkip: number;
  family: number;
}

/** An OpusHead (an Opus track's CodecPrivate); null when it is not one. */
function readOpusHead(bytes: Uint8Array | undefined): OpusHeadInfo | null {
  if (!bytes || bytes.length < 19 || String.fromCharCode(...bytes.subarray(0, 8)) !== "OpusHead") {
    return null;
  }
  return {
    channels: bytes[9]!,
    preSkip: bytes[10]! | (bytes[11]! << 8),
    family: bytes[18]!,
  };
}

/** How a Matroska track is read when it is re-encoded; null when it cannot be. */
function readingOf(t: TrackInfo): Reading | null {
  const pcm = pcmFormatOf(t);
  if (pcm) {
    return pcmReadable(pcm.pcm) ? pcm : null;
  }
  const decoder = decoderConfig(t);
  return decoder ? { decoder } : null;
}

/** A mono or stereo Opus track, which goes remuxed, not re-encoded, when the server takes Ogg. */
function remuxable(t: TrackInfo): boolean {
  const head = t.codecId === "A_OPUS" ? readOpusHead(t.codecPrivate) : null;
  return head !== null && head.family === 0 && head.channels >= 1 && head.channels <= 2;
}

/** Why a Matroska track cannot be sent whatever the browser; null when it may be. */
export function trackProblem(t: TrackInfo): string | null {
  if (t.encoding === "encrypted") {
    return "It is encrypted.";
  }
  if (t.encoding === "compressed") {
    return "It is compressed inside the file, which is not supported.";
  }
  const reading = readingOf(t);
  if (!reading) {
    return t.codecId === "A_OPUS"
      ? "Its Opus header is missing or damaged."
      : `${codecName(t.codecId)} audio cannot be transcribed.`;
  }
  const channels = "pcm" in reading ? reading.pcm.channels : reading.decoder.numberOfChannels;
  if (channels > MAX_CHANNELS) {
    return `It has ${channels} channels: at most ${MAX_CHANNELS} can be mixed down.`;
  }
  return null;
}

/** Why the track cannot be sent from this browser to this server; null when it can. */
async function trackProblemHere(t: TrackInfo, caps: Capabilities): Promise<string | null> {
  const problem = trackProblem(t);
  if (problem || (caps.ogg && remuxable(t))) {
    return problem;
  }
  const reading = readingOf(t)!;
  if ("decoder" in reading && !(await caps.decodes(reading.decoder))) {
    return `This browser cannot decode ${codecName(t.codecId)} audio.`;
  }
  return null;
}

/** The track the dialog starts on: the first usable default, else the first usable one. */
export function preferredTrack(tracks: AudioTrack[]): AudioTrack | undefined {
  const usable = tracks.filter((t) => t.problem === null);
  return usable.find((t) => t.isDefault) ?? usable[0];
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xff_fe;

/** A WAV file's header, as far as checking and cutting it needs. */
export interface WavHeader {
  format: number;
  channels: number;
  sampleRate: number;
  bits: number;
  /** Bytes per frame (all channels). */
  blockAlign: number;
  /** The `fmt ` chunk's body, copied into the header of a cut file. */
  fmt: Uint8Array;
  /** Where the audio starts. */
  dataStart: number;
  /** Bytes of audio: as the header says, or to the end of the file when it says 0 or too much. */
  dataBytes: number;
}

/** Reads the header of a WAV file of `size` bytes from its first bytes `head`. Throws MediaError. */
export function readWavHeader(head: Uint8Array, size: number): WavHeader {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (at: number) => String.fromCharCode(...head.subarray(at, at + 4));
  let fmt: Uint8Array | undefined;
  for (let at = 12; at + 8 <= head.length;) {
    const chunk = view.getUint32(at + 4, true);
    const body = at + 8;
    if (tag(at) === "fmt " && body + 16 <= head.length) {
      fmt = head.slice(body, body + Math.min(chunk, head.length - body));
    } else if (tag(at) === "data") {
      if (!fmt) {
        break;
      }
      const f = new DataView(fmt.buffer);
      let format = f.getUint16(0, true);
      if (format === FORMAT_EXTENSIBLE && fmt.length >= 26) {
        format = f.getUint16(24, true);
      }
      const channels = f.getUint16(2, true);
      const bits = f.getUint16(14, true);
      const blockAlign = (channels * bits) / 8;
      // A recorder that could not seek back leaves the size at zero or all ones: what is there counts.
      const dataBytes = chunk === 0 || body + chunk > size ? size - body : chunk;
      return {
        format,
        channels,
        sampleRate: f.getUint32(4, true),
        bits,
        blockAlign,
        fmt,
        dataStart: body,
        dataBytes,
      };
    }
    at = body + chunk + (chunk & 1);
  }
  throw new MediaError("It is not a WAV file that can be read.");
}

/** How the samples of a WAV file are laid out. */
const wavFormat = (h: WavHeader): PcmFormat => ({
  channels: h.channels,
  bits: h.bits,
  float: h.format === FORMAT_FLOAT,
  bigEndian: false,
});

/** Why a WAV file cannot be transcribed at all; null when it can, as it is or re-encoded. */
export function wavProblem(h: WavHeader): string | null {
  const supported = (h.format === FORMAT_PCM || h.format === FORMAT_FLOAT) && pcmReadable(wavFormat(h));
  if (!supported || h.sampleRate < 1) {
    return "Its encoding is not supported: only PCM and floating-point WAV files can be transcribed.";
  }
  if (h.channels > MAX_CHANNELS) {
    return `It has ${h.channels} channels: at most ${MAX_CHANNELS} can be mixed down.`;
  }
  if (h.dataBytes < h.blockAlign) {
    return "It holds no audio.";
  }
  return null;
}

/**
 * Whether the server takes the WAV file as it is, cut only at `max_seconds` (mirrors its checks in
 * src/wav.ts, src/speech.ts); otherwise it is re-encoded.
 */
function wavSendable(h: WavHeader, limits: Limits): boolean {
  const duration = h.dataBytes / h.blockAlign / h.sampleRate;
  return (
    h.channels <= 2 &&
    h.sampleRate >= limits.minRate &&
    h.sampleRate <= limits.maxRate &&
    wavKeep(h, limits) >= Math.min(duration, limits.maxSeconds)
  );
}

/** Seconds of a WAV file that fit the server's limits. */
function wavKeep(h: WavHeader, limits: Limits): number {
  const bytes = Math.min(h.dataBytes, limits.maxBytes - 44 - h.fmt.length);
  const frames = Math.min(Math.floor(bytes / h.blockAlign), limits.maxSeconds * h.sampleRate);
  return frames / h.sampleRate;
}

/** A WAV file holding the first `seconds` of `file`'s audio: a new header before the file's own bytes. */
function cutWav(file: Blob, h: WavHeader, seconds: number): Blob {
  const dataBytes = Math.round(seconds * h.sampleRate) * h.blockAlign;
  const head = new Uint8Array(20 + h.fmt.length + 8);
  const view = new DataView(head.buffer);
  const ascii = (at: number, s: string) => head.set(new TextEncoder().encode(s), at);
  ascii(0, "RIFF");
  view.setUint32(4, head.length - 8 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, h.fmt.length, true);
  head.set(h.fmt, 20);
  ascii(20 + h.fmt.length, "data");
  view.setUint32(24 + h.fmt.length, dataBytes, true);
  return new Blob([head, file.slice(h.dataStart, h.dataStart + dataBytes)], {
    type: WAV_TYPE,
  });
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/**
 * What the file is and which of its audio tracks can be sent. Throws MediaError when it cannot be
 * transcribed at all (not a file of these kinds, or not readable); a track that cannot be sent is listed
 * with its `problem`.
 */
export async function probeMedia(file: Blob, limits: Limits, caps: Capabilities = BROWSER): Promise<MediaProbe> {
  const container = sniff(await bytesOf(file.slice(0, 12)));
  if (container === "wav") {
    const h = readWavHeader(await bytesOf(file.slice(0, WAV_HEAD_BYTES)), file.size);
    const problem = wavProblem(h);
    const duration = h.dataBytes / h.blockAlign / h.sampleRate;
    // Re-encoded, it is cut only at `max_seconds`.
    const keep = problem
      ? duration
      : wavSendable(h, limits)
        ? wavKeep(h, limits)
        : Math.min(duration, limits.maxSeconds);
    return {
      container,
      duration,
      tracks: [
        {
          number: 0,
          codec: "WAV",
          channels: h.channels,
          isDefault: true,
          problem,
        },
      ],
      cutAt: keep < duration ? keep : undefined,
    };
  }
  if (container === "ogg") {
    if (file.size > MAX_OGG_BYTES) {
      throw new MediaError(`It is larger than ${MAX_OGG_BYTES / 2 ** 20} MB, too large an Ogg file to open.`);
    }
    let channels: number | undefined;
    let duration: number | undefined;
    let problem: string | null = null;
    try {
      const { head, frames } = demuxOggOpus(await bytesOf(file));
      ({ channels } = head);
      duration = frames / RATE;
      if (!caps.ogg && !(await caps.decodes(oggDecoderConfig(head)))) {
        problem = "This browser cannot decode Opus audio.";
      }
    } catch (e) {
      problem = `It cannot be read: ${e instanceof Error ? e.message : String(e)}.`;
    }
    return {
      container,
      duration,
      tracks: [{ number: 0, codec: "Opus", channels, isDefault: true, problem }],
      cutAt: duration !== undefined && duration > limits.maxSeconds ? limits.maxSeconds : undefined,
    };
  }
  if (container === "matroska") {
    let info: Awaited<ReturnType<typeof probeMatroska>>;
    try {
      info = await probeMatroska(file.stream());
    } catch (e) {
      throw new MediaError(`It cannot be read: ${e instanceof Error ? e.message : String(e)}.`);
    }
    const tracks = await Promise.all(
      info.tracks
        .filter((t) => t.type === "audio")
        .map(async (t) => ({
          number: t.number,
          language: languageName(t.language),
          name: t.name || undefined,
          codec: codecName(t.codecId),
          channels: readOpusHead(t.codecPrivate)?.channels ?? t.channels,
          isDefault: t.isDefault,
          problem: await trackProblemHere(t, caps),
        })),
    );
    if (tracks.length === 0) {
      throw new MediaError("It has no audio track.");
    }
    const { duration } = info;
    return {
      container,
      duration,
      tracks,
      cutAt: duration !== undefined && duration > limits.maxSeconds + CUT_SLACK_SECONDS ? limits.maxSeconds : undefined,
      matroska: {
        video: info.tracks.some((t) => t.type === "video"),
        audio: info.tracks.filter((t) => t.type === "audio").map((t) => ({ number: t.number, typeAt: t.typeAt })),
        checksums: info.checksums,
      },
    };
  }
  throw new MediaError("It is not a WAV, Ogg, WebM or MKV file.");
}

/**
 * Writes Opus packets as an Ogg Opus file of at most `keep` samples (after the pre-skip) and the
 * server's byte limit. `add` returns false once the file is full.
 */
class OpusWriter {
  private readonly muxer: OggOpusMuxer;
  private readonly parts: Uint8Array[];
  private bytes = 0;
  /** Samples written, pre-skip included: the granule position after the last packet. */
  written = 0;
  cut = false;

  constructor(
    readonly channels: 1 | 2,
    readonly preSkip: number,
    private readonly keep: number,
    private readonly maxBytes: number,
  ) {
    this.muxer = new OggOpusMuxer({
      channels,
      sampleRate: RATE,
      preSkip,
      vendor: "index-translator",
    });
    this.parts = [this.muxer.header()];
  }

  /** Samples of audio written: what the decoder plays. */
  get audio(): number {
    return Math.max(0, this.written - this.preSkip);
  }

  /** Adds a packet that plays `valid` of its `duration` samples (less only at the end of the stream). */
  add(data: Uint8Array, duration: number, valid = duration): boolean {
    if (this.cut) {
      return false;
    }
    if (this.bytes + data.length + PAGE_MARGIN > this.maxBytes) {
      this.cut = true;
      return false;
    }
    const room = this.preSkip + this.keep - this.written;
    const played = Math.min(valid, room);
    this.push(this.muxer.addPacket({ data, duration, validDuration: played }));
    this.bytes += data.length;
    this.written += played;
    if (this.written >= this.preSkip + this.keep) {
      this.cut = played < valid || this.cut;
      return false;
    }
    return true;
  }

  addSilence(count: number): boolean {
    const packet = SILENCE[this.channels];
    for (let i = 0; i < count; i++) {
      if (!this.add(packet, SILENCE_SAMPLES)) {
        return false;
      }
    }
    return true;
  }

  finish(): Blob {
    this.push(this.muxer.finish());
    return new Blob(this.parts as Uint8Array<ArrayBuffer>[], {
      type: OGG_TYPE,
    });
  }

  private push(bytes: Uint8Array) {
    if (bytes.length > 0) {
      this.parts.push(bytes);
    }
  }
}

export interface PrepareOptions {
  /** The server takes Ogg Opus; true unless said. */
  ogg?: boolean;
  signal?: AbortSignal;
  /** Called with the share of the file read so far, 0 to 1. */
  onProgress?: (fraction: number) => void;
}

/** A stream of the file that reports how much of it has been read. */
function counted(file: Blob, onProgress?: (fraction: number) => void): ReadableStream<Uint8Array> {
  if (!onProgress) {
    return file.stream();
  }
  let read = 0;
  return file.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        read += chunk.length;
        onProgress(file.size > 0 ? read / file.size : 1);
        controller.enqueue(chunk);
      },
    }),
  );
}

/** The track's Opus packets remuxed into Ogg, gaps filled with silence (see the top of this file). */
async function remuxMatroska(
  file: Blob,
  t: TrackInfo,
  video: KeyframeSink | undefined,
  limits: Limits,
  o: PrepareOptions,
): Promise<Recording> {
  const head = readOpusHead(t.codecPrivate)!;
  const writer = new OpusWriter(head.channels as 1 | 2, head.preSkip, limits.maxSeconds * RATE, limits.maxBytes);
  /** Samples at 48 kHz from the file's 0 to the Ogg file's 0. */
  let offset: number | undefined;
  /** The packet before, held back until it is known whether it is the last one (DiscardPadding). */
  let held: { data: Uint8Array; duration: number; discard: number } | undefined;
  let segments = 0;
  let full = false;

  for await (const event of demux(counted(file, o.onProgress), demuxing(t.number, video))) {
    o.signal?.throwIfAborted();
    if (event.type === "tracks") {
      // A chained segment is another recording: the first one is what is sent.
      if (++segments > 1) {
        break;
      }
      continue;
    }
    if (event.type === "keyframe") {
      video?.frames.keyframes.push(event.timestamp / 1e6);
      continue;
    }
    const duration = opusPacketSamples(event.data);
    if (held && !writer.add(held.data, held.duration)) {
      full = true;
      held = undefined;
      break;
    }
    held = undefined;
    // Only a block's first frame carries the time it plays at (a lace without frame durations).
    if (event.frame === 0) {
      // Where the packet plays in the file, and where the Ogg file would play it.
      const at = (event.timestamp * RATE) / 1e6;
      if (offset === undefined) {
        const lead = at + head.preSkip;
        // Within half a packet of 0 is on time (timestamps are rounded to the millisecond).
        const fill = lead > -SILENCE_SAMPLES / 2 && lead <= LEAD_LIMIT_SECONDS * RATE;
        offset = fill ? 0 : lead;
        if (fill && !writer.addSilence(Math.max(0, Math.round(lead / SILENCE_SAMPLES)))) {
          full = true;
          break;
        }
      } else {
        const gap = at - (writer.written - head.preSkip + offset);
        const count = Math.round(gap / SILENCE_SAMPLES);
        if (count > 0 && !writer.addSilence(count)) {
          full = true;
          break;
        }
      }
    }
    const discard = Math.max(0, Math.round(((event.discardPaddingNs ?? 0) * RATE) / 1e9));
    held = { data: event.data, duration, discard };
  }
  if (held) {
    writer.add(held.data, held.duration, Math.max(0, held.duration - held.discard));
  }
  if (writer.audio === 0) {
    throw new MediaError("The track holds no audio.");
  }
  return {
    body: writer.finish(),
    type: OGG_TYPE,
    seconds: writer.audio / RATE,
    cut: full || writer.cut,
    offset: (offset ?? 0) / RATE,
    ...(video && { video: video.frames }),
  };
}

/** An Ogg Opus file re-muxed with only its first `limits.maxSeconds`. */
function cutOgg(bytes: Uint8Array, limits: Limits): Recording {
  const { head, packets } = demuxOggOpus(bytes);
  const writer = new OpusWriter(head.channels, head.preSkip, limits.maxSeconds * RATE, limits.maxBytes);
  for (const packet of packets) {
    if (!writer.add(packet, opusPacketSamples(packet))) {
      break;
    }
  }
  return {
    body: writer.finish(),
    type: OGG_TYPE,
    seconds: writer.audio / RATE,
    cut: true,
    offset: 0,
  };
}

/** The WebCodecs configuration of an Ogg Opus file's stream. */
function oggDecoderConfig(head: { channels: number; preSkip: number; inputSampleRate?: number }): AudioDecoderConfig {
  const opusHead = new Uint8Array(19);
  opusHead.set(new TextEncoder().encode("OpusHead"));
  const view = new DataView(opusHead.buffer);
  view.setUint8(8, 1);
  view.setUint8(9, head.channels);
  view.setUint16(10, head.preSkip, true);
  view.setUint32(12, head.inputSampleRate ?? RATE, true);
  return { codec: "opus", sampleRate: RATE, numberOfChannels: head.channels, description: opusHead };
}

/** An Ogg Opus file's packets, timed from the granule positions they would have. */
function* oggChunks(bytes: Uint8Array, o: PrepareOptions): Generator<SourceChunk> {
  const { head, packets } = demuxOggOpus(bytes);
  let at = -head.preSkip;
  for (const [i, data] of packets.entries()) {
    o.onProgress?.(i / packets.length);
    yield { timestamp: (at * 1e6) / RATE, data, jump: false };
    at += opusPacketSamples(data);
  }
}

/** Frames of a WAV file read at a time when it is re-encoded. */
const WAV_PIECE_FRAMES = 1 << 16;

/** A WAV file's audio in pieces of whole frames, timed by their place. */
async function* wavChunks(file: Blob, h: WavHeader, o: PrepareOptions): AsyncGenerator<SourceChunk> {
  const data = file.slice(h.dataStart, h.dataStart + h.dataBytes);
  const piece = WAV_PIECE_FRAMES * h.blockAlign;
  let frames = 0;
  for (let at = 0; at + h.blockAlign <= data.size; at += piece) {
    o.signal?.throwIfAborted();
    o.onProgress?.(at / data.size);
    const bytes = await bytesOf(data.slice(at, Math.min(data.size, at + piece)));
    const whole = bytes.subarray(0, bytes.length - (bytes.length % h.blockAlign));
    yield { timestamp: (frames * 1e6) / h.sampleRate, data: whole, jump: false };
    frames += whole.length / h.blockAlign;
  }
}

/**
 * The track's packets, each marked when it comes after a gap (see transcode.ts): a block that starts at
 * least GAP_US after the last one ended (lengths from Matroska, else `packetMicros`), or, when that
 * block's length is unknown, more than UNTIMED_JUMP_US after it started.
 */
async function* matroskaChunks(
  file: Blob,
  t: TrackInfo,
  video: KeyframeSink | undefined,
  o: PrepareOptions,
): AsyncGenerator<SourceChunk> {
  const micros = packetMicros(t);
  let segments = 0;
  /** The last block's start, and its end while every frame's length is known. */
  let blockStart: number | undefined;
  let blockEnd: number | undefined;
  for await (const event of demux(counted(file, o.onProgress), demuxing(t.number, video))) {
    o.signal?.throwIfAborted();
    if (event.type === "tracks") {
      // A chained segment is another recording: the first one is what is sent.
      if (++segments > 1) {
        return;
      }
      continue;
    }
    if (event.type === "keyframe") {
      video?.frames.keyframes.push(event.timestamp / 1e6);
      continue;
    }
    let jump = false;
    if (event.frame === 0) {
      if (blockEnd !== undefined) {
        jump = event.timestamp - blockEnd >= GAP_US;
      } else if (blockStart !== undefined) {
        jump = event.timestamp - blockStart > UNTIMED_JUMP_US;
      }
      blockStart = event.timestamp;
      blockEnd = event.timestamp;
    }
    const length = event.duration ?? micros(event.data);
    blockEnd = length === undefined || blockEnd === undefined ? undefined : blockEnd + length;
    yield { timestamp: event.timestamp, data: event.data, jump };
  }
}

/** Re-encodes what `chunks` hold (transcode.ts) into a Recording. */
async function reencode(
  chunks: AsyncIterable<SourceChunk> | Iterable<SourceChunk>,
  reading: Reading,
  limits: Limits,
  o: PrepareOptions,
  duration: number | undefined,
): Promise<Recording> {
  try {
    const r = await transcode(chunks, reading, {
      ogg: o.ogg ?? true,
      keepSeconds: limits.maxSeconds,
      maxBytes: limits.maxBytes,
      leadLimitSeconds: LEAD_LIMIT_SECONDS,
      signal: o.signal,
    });
    // Stopped at the limit by what is only padding past it is not cut.
    const padding =
      r.seconds >= limits.maxSeconds - 1e-3 &&
      duration !== undefined &&
      duration <= limits.maxSeconds + CUT_SLACK_SECONDS;
    return { ...r, cut: r.cut && !padding, type: r.type === OGG_TYPE ? OGG_TYPE : WAV_TYPE };
  } catch (e) {
    if (e instanceof Error && e.message === "no audio") {
      throw new MediaError("The track holds no audio.");
    }
    throw e;
  }
}

/**
 * The body to send for `track` of a file `probeMedia` read: the file itself when the server takes it as
 * it is, else the file cut at the server's limit, the track remuxed, or re-encoded. Throws MediaError, or
 * the signal's reason when it is aborted.
 */
export async function prepareRecording(
  file: Blob,
  probe: MediaProbe,
  track: number,
  limits: Limits,
  o: PrepareOptions = {},
): Promise<Recording> {
  try {
    return await prepare(file, probe, track, limits, o);
  } catch (e) {
    if (e instanceof MediaError || o.signal?.aborted) {
      throw e;
    }
    throw new MediaError(`It cannot be read: ${e instanceof Error ? e.message : String(e)}.`);
  }
}

async function prepare(
  file: Blob,
  probe: MediaProbe,
  track: number,
  limits: Limits,
  o: PrepareOptions,
): Promise<Recording> {
  const ogg = o.ogg ?? true;
  if (probe.container === "wav") {
    const h = readWavHeader(await bytesOf(file.slice(0, WAV_HEAD_BYTES)), file.size);
    const problem = wavProblem(h);
    if (problem) {
      throw new MediaError(problem);
    }
    if (!wavSendable(h, limits)) {
      return reencode(wavChunks(file, h, o), { pcm: wavFormat(h), rate: h.sampleRate }, limits, o, probe.duration);
    }
    const duration = h.dataBytes / h.blockAlign / h.sampleRate;
    const keep = wavKeep(h, limits);
    if (keep >= duration) {
      return {
        body: file,
        type: WAV_TYPE,
        seconds: duration,
        cut: false,
        offset: 0,
      };
    }
    return {
      body: cutWav(file, h, keep),
      type: WAV_TYPE,
      seconds: keep,
      cut: true,
      offset: 0,
    };
  }
  if (probe.container === "ogg") {
    const bytes = await bytesOf(file);
    const { head, frames } = demuxOggOpus(bytes);
    if (!ogg) {
      return reencode(oggChunks(bytes, o), { decoder: oggDecoderConfig(head) }, limits, o, probe.duration);
    }
    if (frames <= limits.maxSeconds * RATE && file.size <= limits.maxBytes) {
      return {
        body: file,
        type: OGG_TYPE,
        seconds: frames / RATE,
        cut: false,
        offset: 0,
      };
    }
    return cutOgg(bytes, limits);
  }
  const { tracks } = await probeMatroska(file.stream());
  const t = tracks.find((x) => x.number === track);
  const problem = t ? trackProblem(t) : "The track is not in the file.";
  if (!t || problem) {
    throw new MediaError(problem ?? "The track cannot be transcribed.");
  }
  const video = keyframeSink(tracks);
  if (ogg && remuxable(t)) {
    return remuxMatroska(file, t, video, limits, o);
  }
  const r = await reencode(matroskaChunks(file, t, video, o), readingOf(t)!, limits, o, probe.duration);
  return video ? { ...r, video: video.frames } : r;
}
