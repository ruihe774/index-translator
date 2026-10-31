// A recording or video opened to be transcribed (`POST /transcriptions`): which file it is, which of its
// audio tracks can be sent, and the body that is sent. Nothing is decoded or re-encoded here: a WAV or
// Ogg Opus file goes as it is (or cut at the server's limit), and an Opus track of a WebM or MKV file is
// remuxed into Ogg Opus (matroska.ts reads it, ogg-opus.ts writes it). Pure apart from the Blob it reads,
// so tested by bun test (test/media-file.test.ts).
//
// Ogg plays its packets back to back while Matroska stamps each block with its time, so where the
// Matroska track skips ahead (audio that starts late, a recorder that dropped packets) the remux fills
// the gap with Opus packets of digital silence: the Ogg timeline stays the file's, and the segment times
// the server answers are times in the video. Audio that starts more than LEAD_LIMIT_SECONDS late is
// not filled from 0 (that could use up the server's limit on silence); the Ogg file starts at its
// first packet and `offset` says how far into the file that is.

import type { Health } from "../src/api.ts";
import { demux, probeMatroska, type TrackInfo } from "./matroska.ts";
import { demuxOggOpus, OggOpusMuxer, opusPacketSamples } from "./ogg-opus.ts";

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
}

/** Why a file cannot be transcribed at all, as a sentence. */
export class MediaError extends Error {}

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

/** Why a Matroska track cannot be remuxed for the server; null when it can. */
export function trackProblem(t: TrackInfo): string | null {
  if (t.encoded) {
    return "It is compressed inside the file, which is not supported.";
  }
  if (t.codecId !== "A_OPUS") {
    return `${codecName(t.codecId)} audio is not supported yet: only Opus tracks can be transcribed.`;
  }
  const head = readOpusHead(t.codecPrivate);
  if (!head) {
    return "Its Opus header is missing or damaged.";
  }
  if (head.channels > 2) {
    return `It has ${head.channels} channels: only mono and stereo tracks can be transcribed.`;
  }
  if (head.family !== 0 || head.channels < 1) {
    return "Its channel layout is not supported.";
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

/** Why a WAV file cannot be sent; null when it can. Mirrors the server's checks (src/wav.ts, src/speech.ts). */
export function wavProblem(h: WavHeader, limits: Limits): string | null {
  const supported =
    (h.format === FORMAT_PCM && [8, 16, 24, 32].includes(h.bits)) ||
    (h.format === FORMAT_FLOAT && [32, 64].includes(h.bits));
  if (!supported) {
    return "Its encoding is not supported: only PCM and floating-point WAV files can be transcribed.";
  }
  if (h.channels < 1 || h.channels > 2) {
    return `It has ${h.channels} channels: only mono and stereo recordings can be transcribed.`;
  }
  if (h.sampleRate < limits.minRate || h.sampleRate > limits.maxRate) {
    const k = (hz: number) => `${hz / 1000} kHz`;
    return `Its sample rate is ${k(h.sampleRate)}: only ${k(limits.minRate)} to ${k(limits.maxRate)} can be transcribed.`;
  }
  if (h.dataBytes < h.blockAlign) {
    return "It holds no audio.";
  }
  return null;
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
export async function probeMedia(file: Blob, limits: Limits): Promise<MediaProbe> {
  const container = sniff(await bytesOf(file.slice(0, 12)));
  if (container === "wav") {
    const h = readWavHeader(await bytesOf(file.slice(0, WAV_HEAD_BYTES)), file.size);
    const problem = wavProblem(h, limits);
    const duration = h.dataBytes / h.blockAlign / h.sampleRate;
    const keep = problem ? duration : wavKeep(h, limits);
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
    const tracks = info.tracks
      .filter((t) => t.type === "audio")
      .map((t) => ({
        number: t.number,
        language: languageName(t.language),
        name: t.name || undefined,
        codec: codecName(t.codecId),
        channels: readOpusHead(t.codecPrivate)?.channels ?? t.channels,
        isDefault: t.isDefault,
        problem: trackProblem(t),
      }));
    if (tracks.length === 0) {
      throw new MediaError("It has no audio track.");
    }
    const { duration } = info;
    return {
      container,
      duration,
      tracks,
      cutAt: duration !== undefined && duration > limits.maxSeconds ? limits.maxSeconds : undefined,
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
async function remuxMatroska(file: Blob, t: TrackInfo, limits: Limits, o: PrepareOptions): Promise<Recording> {
  const head = readOpusHead(t.codecPrivate)!;
  const writer = new OpusWriter(head.channels as 1 | 2, head.preSkip, limits.maxSeconds * RATE, limits.maxBytes);
  /** Samples at 48 kHz from the file's 0 to the Ogg file's 0. */
  let offset: number | undefined;
  /** The packet before, held back until it is known whether it is the last one (DiscardPadding). */
  let held: { data: Uint8Array; duration: number; discard: number } | undefined;
  let segments = 0;
  let full = false;

  for await (const event of demux(counted(file, o.onProgress), {
    tracks: new Set([t.number]),
  })) {
    o.signal?.throwIfAborted();
    if (event.type === "tracks") {
      // A chained segment is another recording: the first one is what is sent.
      if (++segments > 1) {
        break;
      }
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

/**
 * The body to send for `track` of a file `probeMedia` read: the file itself when the server takes it as
 * it is, else the file cut at the server's limit, or the track remuxed. Throws MediaError, or the
 * signal's reason when it is aborted.
 */
export async function prepareRecording(
  file: Blob,
  probe: MediaProbe,
  track: number,
  limits: Limits,
  o: PrepareOptions = {},
): Promise<Recording> {
  if (probe.container === "wav") {
    const h = readWavHeader(await bytesOf(file.slice(0, WAV_HEAD_BYTES)), file.size);
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
    const { frames } = demuxOggOpus(bytes);
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
  try {
    return await remuxMatroska(file, t, limits, o);
  } catch (e) {
    if (e instanceof MediaError || o.signal?.aborted) {
      throw e;
    }
    throw new MediaError(`It cannot be read: ${e instanceof Error ? e.message : String(e)}.`);
  }
}
