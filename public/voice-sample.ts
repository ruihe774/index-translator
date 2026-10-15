// Voice samples for cloning: any audio the browser can decode (a file, or a microphone recording)
// becomes a mono 16-bit WAV that the server hands to the speech model as the reference voice.
// The recording itself and the WAV writer are in mic-recorder.ts (no DOM types, tested with fakes).

import type { ErrorResponse, Voice } from "../src/api.ts";
import { encodeWav, MAX_SAMPLE_SECONDS, MIN_SAMPLE_SECONDS } from "./mic-recorder.ts";

export { encodeWav, MAX_SAMPLE_SECONDS, MIN_SAMPLE_SECONDS, MicRecorder } from "./mic-recorder.ts";

const RATE = 24_000;

/** Decodes audio of any format the browser knows, mixes it to mono, resamples and trims it. */
export async function audioToWav(data: ArrayBuffer): Promise<ArrayBuffer> {
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
  const length = Math.round(Math.min(decoded.duration, MAX_SAMPLE_SECONDS) * RATE);
  const offline = new OfflineAudioContext(1, length, RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded; // channels are mixed down to the one output channel
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), RATE);
}

export async function uploadVoice(api: string, name: string, wav: ArrayBuffer): Promise<Voice> {
  const res = await fetch(`${api}/voices?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: wav,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Partial<ErrorResponse> | null;
    throw new Error(body?.error?.message ?? `The server answered HTTP ${res.status}.`);
  }
  return (await res.json()) as Voice;
}
