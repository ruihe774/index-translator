// Voice samples for cloning: any audio the browser can decode (a file, or a microphone recording)
// becomes mono Ogg Opus, or a 16-bit WAV where Opus cannot be encoded here or decoded by the server
// (audio-upload.ts), that the server hands to the speech model as the reference voice.
// The recording itself and the WAV writer are in mic-recorder.ts (no DOM types, tested with fakes).

import type { Voice } from "../src/api.ts";
import { failureOf } from "./api.ts";
import { encodeUpload, type Upload } from "./audio-upload.ts";
import { MAX_SAMPLE_SECONDS, MIN_SAMPLE_SECONDS } from "./mic-recorder.ts";

export { encodeWav, MAX_SAMPLE_SECONDS, MIN_SAMPLE_SECONDS, MicRecorder } from "./mic-recorder.ts";

/**
 * What the voice file picker offers, as an `accept` list: explicit extensions and types, never
 * `audio/*`. WebKit maps that wildcard to a movie type, so on iOS the picker offers the video
 * recorder and leaves audio files out (https://bugs.webkit.org/show_bug.cgi?id=242110). WebM is
 * left out too: both `.webm` and `audio/webm` bring the video recorder back. Whether the browser
 * can decode a picked file is still settled by `audioToSample`.
 */
export const ACCEPT_AUDIO = [
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
  ".aiff",
  ".aif",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
  "audio/aiff",
  "audio/x-aiff",
].join(",");

/** The only rate the server accepts in a WAV (`sample_rate` of `GET /voices`): it is what the voice separator takes. */
const RATE = 44_100;
/** A sample's Opus bitrate: transparent for a voice, still a sixth of the WAV's size. */
const BITRATE = 96_000;

/**
 * Decodes audio of any format the browser knows, mixes it to mono, resamples and trims it, and encodes it
 * as one of `types` (`upload_types` of `GET /voices`).
 */
export async function audioToSample(data: ArrayBuffer, types: readonly string[]): Promise<Upload> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } catch {
    throw new Error("This file is not audio the browser can read.");
  } finally {
    void ctx.close();
  }
  if (decoded.duration < MIN_SAMPLE_SECONDS) {
    throw new Error(
      `The sample is too short: it needs at least ${MIN_SAMPLE_SECONDS} second${MIN_SAMPLE_SECONDS === 1 ? "" : "s"}, and a few seconds work better.`,
    );
  }
  return encodeUpload(decoded, { types, wavRate: RATE, bitrate: BITRATE, seconds: MAX_SAMPLE_SECONDS });
}

export async function uploadVoice(api: string, name: string, sample: Upload): Promise<Voice> {
  const res = await fetch(`${api}/voices?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": sample.type },
    body: sample.body,
  });
  if (!res.ok) {
    const failure = await failureOf(res);
    throw new Error(failure.body.message ?? `The server answered HTTP ${res.status}.`);
  }
  return (await res.json()) as Voice;
}
