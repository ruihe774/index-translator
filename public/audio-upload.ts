// Recordings for the server's upload endpoints (`POST /voices`, and `POST /transcriptions` once the page
// offers it): decoded audio, mixed down to mono and resampled by Web Audio (an OfflineAudioContext of one
// channel at the rate wanted; WebCodecs does neither), then sent as Ogg Opus when the server takes it
// (`upload_types`) and this browser's WebCodecs AudioEncoder encodes Opus, otherwise as WAV. The encoder's
// packets are muxed by ogg-opus.ts, the muxer the server's speech stream uses.

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

const opusConfig = (bitrate: number): AudioEncoderConfig => ({
  codec: "opus",
  sampleRate: OPUS_RATE,
  numberOfChannels: 1,
  bitrate,
});

/** Whether this browser encodes mono Opus at `bitrate`: WebCodecs' AudioEncoder is not everywhere yet. */
export async function opusEncodable(bitrate: number): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") {
    return false;
  }
  try {
    return (await AudioEncoder.isConfigSupported(opusConfig(bitrate))).supported === true;
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
 * Mono 48 kHz samples as an Ogg Opus file, encoded by WebCodecs at `bitrate`. Only where `opusEncodable`
 * said so; rejects when the encoder fails.
 */
export async function encodeOggOpus(
  samples: Float32Array<ArrayBuffer>,
  bitrate: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const packets: Uint8Array[] = [];
  let preSkip = DEFAULT_PRE_SKIP;
  let failure: DOMException | undefined;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      preSkip = preSkipOf(metadata?.decoderConfig?.description) ?? preSkip;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push(data);
    },
    error: (e) => void (failure = e),
  });
  /** Hands the encoder `data`, which starts `from` samples into the recording. */
  const feed = (data: Float32Array<ArrayBuffer>, from: number) => {
    const audio = new AudioData({
      format: "f32-planar",
      sampleRate: OPUS_RATE,
      numberOfChannels: 1,
      numberOfFrames: data.length,
      timestamp: Math.round((from * 1e6) / OPUS_RATE),
      data,
    });
    encoder.encode(audio);
    audio.close();
  };
  try {
    encoder.configure(opusConfig(bitrate));
    // An error closes the encoder, and the next `encode` throws.
    for (let from = 0; from < samples.length; from += CHUNK) {
      feed(samples.subarray(from, from + CHUNK), from);
      while (encoder.encodeQueueSize > MAX_QUEUED && encoder.state === "configured") {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    }
    feed(new Float32Array(TAIL), samples.length);
    await encoder.flush();
  } finally {
    if (encoder.state !== "closed") {
      encoder.close();
    }
  }
  if (failure) {
    throw failure;
  }

  // The decoder drops the pre-skip; the granule position ends the audio where the samples end, so packets
  // wholly past that (the tail's) are left out and the last one is cut.
  const durations = packets.map(opusPacketSamples);
  const end = preSkip + samples.length;
  let total = durations.reduce((n, d) => n + d, 0);
  while (packets.length > 1 && total - durations.at(-1)! >= end) {
    total -= durations.pop()!;
    packets.pop();
  }
  const mux = new OggOpusMuxer({ channels: 1, sampleRate: OPUS_RATE, preSkip, vendor: "index-translator, WebCodecs" });
  const parts = [mux.header()];
  packets.forEach((data, i) => {
    const duration = durations[i]!;
    const padding = i === packets.length - 1 ? Math.max(0, total - end) : 0;
    parts.push(mux.addPacket({ data, duration, validDuration: duration - padding }));
  });
  parts.push(mux.finish());
  return concat(parts) as Uint8Array<ArrayBuffer>;
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
