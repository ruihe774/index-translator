// Uploaded recordings in Ogg Opus (`POST /voices`, `POST /transcriptions`), beside WAV: demuxed by
// public/ogg-opus.ts and decoded by libopus (src/opus-ffi.ts) at 48 kHz, the rate Opus codes at. The
// library is optional, as for the speech stream: without it only WAV is taken.

import { existsSync } from "node:fs";

import { demuxOggOpus } from "../public/ogg-opus";
import { OpusDecoder, opusDir, opusLibraryPath } from "./opus-ffi";
import { OPUS_TYPE } from "./opus-stream";
import { type Pcm, readWav, readWavInfo, type WavInfo } from "./wav";

export const WAV_TYPE = "audio/wav";

/** The rate Opus is decoded at. */
const RATE = 48_000;

/** The media types an upload may have: WAV, and Ogg Opus when libopus is installed beside `audioDir`. */
export function uploadTypes(audioDir: string): string[] {
  return existsSync(opusLibraryPath(opusDir(audioDir))) ? [WAV_TYPE, OPUS_TYPE] : [WAV_TYPE];
}

/** Whether the file starts like an Ogg file rather than a WAV one. */
const isOgg = (bytes: Uint8Array) =>
  bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;

/**
 * The format and length of an Ogg Opus file, from its pages, without decoding (libopus is not needed). Throws
 * an Error that says what is wrong with the file.
 */
export function readOggOpusInfo(bytes: Uint8Array): WavInfo {
  const { head, frames } = demuxOggOpus(bytes);
  return { sampleRate: RATE, channels: head.channels, frames };
}

/**
 * Decodes an Ogg Opus file with the libopus in `dir` (opusDir), at 48 kHz: the pre-skip is dropped, the
 * end cut at the last granule position and the header's output gain applied. Throws an Error that says
 * what is wrong with the file.
 */
export function readOggOpus(bytes: Uint8Array, dir: string): Pcm {
  const { head, packets, frames } = demuxOggOpus(bytes);
  const { channels } = head;
  const samples = new Float32Array(frames * channels);
  const decoder = new OpusDecoder(dir, RATE, channels);
  try {
    let skip = head.preSkip * channels;
    let at = 0;
    for (const packet of packets) {
      if (at >= samples.length) {
        break;
      }
      let pcm = decoder.decode(packet);
      if (skip > 0) {
        const dropped = Math.min(skip, pcm.length);
        pcm = pcm.subarray(dropped);
        skip -= dropped;
      }
      const kept = pcm.subarray(0, samples.length - at);
      samples.set(kept, at);
      at += kept.length;
    }
  } finally {
    decoder.destroy();
  }
  if (head.outputGain !== 0) {
    const gain = 10 ** (head.outputGain / (20 * 256));
    for (let i = 0; i < samples.length; i++) {
      samples[i]! *= gain;
    }
  }
  return { samples, sampleRate: RATE, channels };
}

/** The header of an uploaded recording of media type `type` (one of `uploadTypes`). Throws an Error as the readers do. */
export function readRecordingInfo(bytes: Uint8Array, type: string): WavInfo {
  return type === OPUS_TYPE ? readOggOpusInfo(bytes) : readWavInfo(bytes);
}

/**
 * Decodes an uploaded recording that `readRecordingInfo` accepted, WAV or Ogg Opus told apart by its first
 * bytes (`audioDir` is the speech engine's).
 */
export function readRecording(bytes: Uint8Array, audioDir: string): Pcm {
  return isOgg(bytes) ? readOggOpus(bytes, opusDir(audioDir)) : readWav(bytes);
}
