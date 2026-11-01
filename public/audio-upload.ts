// Recordings for the server's upload endpoints. A voice sample (`POST /voices`): decoded audio, mixed down
// to mono and resampled by Web Audio (an OfflineAudioContext of one channel at the rate wanted; WebCodecs
// does neither), then sent as Ogg Opus when the server takes it (`upload_types`) and this browser's
// WebCodecs AudioEncoder encodes Opus, otherwise as WAV. A recording to transcribe that is re-encoded
// (transcode.ts) streams through `OggOpusEncoder`, mono or stereo. The encoder's packets are muxed by
// ogg-opus.ts, the muxer the server's speech stream uses.

import { encodeWav } from "./mic-recorder.ts";
import { concat, OggOpusMuxer, opusPacketSamples } from "./ogg-opus.ts";

export const WAV_TYPE = "audio/wav";
export const OGG_TYPE = "audio/ogg";

/** The rate Opus codes at, so the one it is encoded from. */
const OPUS_RATE = 48_000;
/**
 * The encoder's delay when it does not say (libopus at 48 kHz: 2.5 ms of lookahead and 4 ms of delay
 * compensation), which the decoder drops from the start.
 */
const DEFAULT_PRE_SKIP = 312;
/** Silence fed after the audio so that what the encoder delays comes out too: more than any pre-skip. */
const TAIL = 1920;
/** Samples per `AudioData` handed to the encoder: a second. */
const CHUNK = OPUS_RATE;
/** Chunks the encoder may hold before the next is given, so a long recording is not copied in whole. */
const MAX_QUEUED = 4;

/** A body for `fetch` and its `Content-Type`. */
export interface Upload {
  body: ArrayBuffer | Uint8Array<ArrayBuffer>;
  type: string;
}

/**
 * Complexity 6: a browser's default is libopus's maximum, whose extra analysis took about 9 s for a
 * 30-minute stereo recording where 6 takes about 5 s (e2e/perf/opus-encode.ts). The server's Opus stream
 * uses 6 as well.
 */
const opusConfig = (bitrate: number, channels: number): AudioEncoderConfig => ({
  codec: "opus",
  sampleRate: OPUS_RATE,
  numberOfChannels: channels,
  bitrate,
  opus: { complexity: 6 },
});

/** Whether this browser encodes Opus at `bitrate` (mono unless said): WebCodecs' AudioEncoder is not everywhere yet. */
export async function opusEncodable(bitrate: number, channels = 1): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") {
    return false;
  }
  try {
    return (await AudioEncoder.isConfigSupported(opusConfig(bitrate, channels))).supported === true;
  } catch {
    return false;
  }
}

/** The first `seconds` of the audio as mono samples at `rate`: channels mixed down, then resampled. */
export async function mixDown(
  decoded: AudioBuffer,
  rate: number,
  seconds = decoded.duration,
): Promise<Float32Array<ArrayBuffer>> {
  const length = Math.round(Math.min(decoded.duration, seconds) * rate);
  const offline = new OfflineAudioContext(1, length, rate);
  const source = offline.createBufferSource();
  source.buffer = decoded; // channels are mixed down to the one output channel
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

/** The pre-skip of an OpusHead that an encoder gives as its decoder's `description`, if it is one. */
function preSkipOf(description: AllowSharedBufferSource | undefined): number | undefined {
  if (!description) {
    return undefined;
  }
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  return bytes.length >= 19 && magic === "OpusHead" ? bytes[10]! | (bytes[11]! << 8) : undefined;
}

/**
 * Resolves once the codec's queue has shrunk: its `dequeue` event (a reset or close fires it too, so a
 * failed codec ends the wait). Where a codec has no such event, a task through a MessageChannel lets its
 * callbacks run (nested `setTimeout(0)`s wait at least 4 ms each, which made 30 minutes take 40 s).
 */
export function dequeued(codec: AudioEncoder | AudioDecoder): Promise<void> {
  return new Promise<void>((resolve) => {
    if ("ondequeue" in codec) {
      codec.addEventListener("dequeue", () => resolve(), { once: true });
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Planar 48 kHz samples encoded by WebCodecs and muxed into an Ogg Opus file as they come. Only
 * where `opusEncodable` said so; `write` and `finish` reject when the encoder fails. The file's pages
 * are kept (at most 128 kbps, a few megabytes a minute); the samples are not. Muxing as the packets
 * come keeps `finish` short: muxing 30 minutes at once held the page for about 200 ms.
 */
export class OggOpusEncoder {
  readonly rate = OPUS_RATE;
  private readonly encoder: AudioEncoder;
  /** Made by the first packet, whose metadata tells the pre-skip that its OpusHead says. */
  private mux: OggOpusMuxer | undefined;
  /** The file's pages so far. */
  private readonly pages: Uint8Array[] = [];
  /** Packets not yet muxed: those that may end past the audio, which `finish` cuts or leaves out. */
  private readonly held: Uint8Array[] = [];
  /** 48 kHz samples, pre-skip included, through the last packet muxed. */
  private muxed = 0;
  private preSkip = DEFAULT_PRE_SKIP;
  private failure: DOMException | undefined;
  /** Frames given, silence at the end not counted. */
  private frames = 0;
  /** Frames waiting to make up a CHUNK, per channel. */
  private pending: Float32Array[][];
  private pendingFrames = 0;
  /** Frames handed to the encoder. */
  private fed = 0;

  constructor(
    readonly channels: 1 | 2,
    bitrate: number,
  ) {
    this.pending = Array.from({ length: channels }, () => []);
    this.encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        if (!this.mux) {
          this.preSkip = preSkipOf(metadata?.decoderConfig?.description) ?? this.preSkip;
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.held.push(data);
        this.muxWhole();
      },
      error: (e) => void (this.failure = e),
    });
    this.encoder.configure(opusConfig(bitrate, channels));
  }

  /** Adds samples, one array per channel. */
  async write(planes: Float32Array[]) {
    const length = planes[0]?.length ?? 0;
    for (const [c, p] of planes.entries()) {
      this.pending[c]!.push(p);
    }
    this.pendingFrames += length;
    this.frames += length;
    if (this.pendingFrames >= CHUNK) {
      await this.encodePending();
    }
  }

  /** The Ogg Opus file; the encoder is closed. */
  async finish(): Promise<Uint8Array<ArrayBuffer>> {
    try {
      await this.encodePending();
      this.feed(Array.from({ length: this.channels }, () => new Float32Array(TAIL)));
      await this.encoder.flush();
    } finally {
      this.close();
    }
    this.throwIfFailed();

    // The decoder drops the pre-skip; the granule position ends the audio where the samples end, so packets
    // wholly past that (the tail's) are left out and the last one is cut. The file keeps one packet.
    const mux = this.muxer();
    const { held } = this;
    const durations = held.map(opusPacketSamples);
    const end = this.preSkip + this.frames;
    let total = durations.reduce((n, d) => n + d, this.muxed);
    while (held.length > (this.muxed > 0 ? 0 : 1) && total - durations.at(-1)! >= end) {
      total -= durations.pop()!;
      held.pop();
    }
    held.forEach((data, i) => {
      const duration = durations[i]!;
      const padding = i === held.length - 1 ? Math.max(0, total - end) : 0;
      this.pages.push(mux.addPacket({ data, duration, validDuration: duration - padding }));
    });
    this.pages.push(mux.finish());
    return concat(this.pages) as Uint8Array<ArrayBuffer>;
  }

  private muxer(): OggOpusMuxer {
    if (!this.mux) {
      this.mux = new OggOpusMuxer({
        channels: this.channels,
        sampleRate: OPUS_RATE,
        preSkip: this.preSkip,
        vendor: "index-translator, WebCodecs",
      });
      this.pages.push(this.mux.header());
    }
    return this.mux;
  }

  /** Muxes the held packets that end within the samples written so far: no later sample cuts those. */
  private muxWhole() {
    const mux = this.muxer();
    const end = this.preSkip + this.frames;
    let taken = 0;
    for (const data of this.held) {
      const duration = opusPacketSamples(data);
      if (this.muxed + duration > end) {
        break;
      }
      this.muxed += duration;
      const page = mux.addPacket({ data, duration, validDuration: duration });
      if (page.length > 0) {
        this.pages.push(page);
      }
      taken++;
    }
    this.held.splice(0, taken);
  }

  /** Gives up: the encoder is closed and nothing is written. */
  close() {
    if (this.encoder.state !== "closed") {
      this.encoder.close();
    }
  }

  private throwIfFailed() {
    if (this.failure) {
      throw this.failure;
    }
  }

  private async encodePending() {
    if (this.pendingFrames === 0) {
      return;
    }
    const planes = this.pending.map((parts) => {
      const joined = new Float32Array(this.pendingFrames);
      let at = 0;
      for (const p of parts) {
        joined.set(p, at);
        at += p.length;
      }
      return joined;
    });
    this.pending = Array.from({ length: this.channels }, () => []);
    this.pendingFrames = 0;
    this.feed(planes);
    // An error closes the encoder, and the next `encode` throws.
    while (this.encoder.encodeQueueSize > MAX_QUEUED && this.encoder.state === "configured") {
      await dequeued(this.encoder);
    }
    this.throwIfFailed();
  }

  /** Hands the encoder `planes`, the next samples after those given before. */
  private feed(planes: Float32Array[]) {
    const length = planes[0]?.length ?? 0;
    const data = new Float32Array(length * this.channels);
    planes.forEach((p, c) => data.set(p, c * length));
    const audio = new AudioData({
      format: "f32-planar",
      sampleRate: OPUS_RATE,
      numberOfChannels: this.channels,
      numberOfFrames: length,
      timestamp: Math.round((this.fed * 1e6) / OPUS_RATE),
      data,
    });
    this.fed += length;
    this.encoder.encode(audio);
    audio.close();
  }
}

/**
 * Mono 48 kHz samples as an Ogg Opus file, encoded by WebCodecs at `bitrate`. Only where `opusEncodable`
 * said so; rejects when the encoder fails.
 */
export async function encodeOggOpus(
  samples: Float32Array<ArrayBuffer>,
  bitrate: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new OggOpusEncoder(1, bitrate);
  try {
    for (let from = 0; from < samples.length; from += CHUNK) {
      await encoder.write([samples.subarray(from, from + CHUNK)]);
    }
    return await encoder.finish();
  } finally {
    encoder.close();
  }
}

export interface UploadOptions {
  /** The server's `upload_types`. */
  types: readonly string[];
  /** The rate of a WAV upload (Opus is always 48 kHz). */
  wavRate: number;
  /** The Opus bitrate. */
  bitrate: number;
  /** How much of the audio to send; all of it by default. */
  seconds?: number;
}

/** Decoded audio as mono Ogg Opus where both sides can, else as a 16-bit WAV at `wavRate`. */
export async function encodeUpload(decoded: AudioBuffer, options: UploadOptions): Promise<Upload> {
  const { types, wavRate, bitrate, seconds } = options;
  if (types.includes(OGG_TYPE) && (await opusEncodable(bitrate))) {
    try {
      return { type: OGG_TYPE, body: await encodeOggOpus(await mixDown(decoded, OPUS_RATE, seconds), bitrate) };
    } catch {
      // The encoder said it could and then failed: WAV, as where it cannot.
    }
  }
  return { type: WAV_TYPE, body: encodeWav(await mixDown(decoded, wavRate, seconds), wavRate) };
}
