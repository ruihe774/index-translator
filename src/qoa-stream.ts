// The speech stream's second format: QOA (Quite OK Audio), a lossy codec at about 3.2 bits per
// sample, a fifth of the 16-bit WAV the engine's samples would be written as. Chosen by the client
// with `Accept: audio/qoa`; any other request is answered with the WAV as before.
//
// The codec is qoa-wasm (public/vendor/qoa/, put there by scripts/fetch_web_libs.ts): the page
// decodes with the same files, so the two ends can never disagree. It is loaded the first time a
// client asks for QOA, and a server without it answers every such request with WAV.
//
// The engine returns the whole utterance at once (audio.cpp has no streaming output), so what is
// streamed is the encoded file: frames of 5,120 samples, a few at a time, which the page decodes
// as they arrive.

import { join } from "node:path";

import { acceptWeight } from "./accept";
import { lazyOptional } from "./opus-stream";
import type { Pcm } from "./wav";

export const QOA_TYPE = "audio/qoa";

/** The part of qoa-wasm's `Qoa` the server uses. */
export interface QoaCodec {
  createEncoder(channels: number, sampleRate: number): { write(samples: Int16Array): Uint8Array; end(): Uint8Array };
}

/** Samples per channel in a QOA frame. */
const FRAME_LEN = 5120;
/** Frames encoded and sent per chunk of the response. */
const FRAMES_PER_CHUNK = 4;

/** Whether an `Accept` header asks for QOA: only by naming it, with a weight above 0. */
export function acceptsQoa(accept: string | null): boolean {
  return acceptWeight(accept, QOA_TYPE) > 0;
}

/** Loads the codec on first use; undefined while it is not installed or does not run here. */
export function qoaLoader(publicDir: string): () => Promise<QoaCodec | undefined> {
  return lazyOptional(
    () => join(publicDir, "vendor", "qoa", "src", "qoa.ts"),
    async (file) => {
      const { Qoa } = (await import(file)) as { Qoa: { create(): Promise<QoaCodec> } };
      return Qoa.create();
    },
    "the QOA codec cannot be loaded, speech is sent as WAV",
  );
}

/** 16-bit samples from the engine's floats, rounded as `writeWav` does. */
function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 0x7f_ff);
  }
  return out;
}

/** The audio as a QOA stream, encoded a few frames at a time as the client reads. */
export function qoaResponse(codec: QoaCodec, pcm: Pcm): Response {
  const samples = toInt16(pcm.samples);
  const encoder = codec.createEncoder(pcm.channels, pcm.sampleRate);
  const chunk = FRAME_LEN * FRAMES_PER_CHUNK * pcm.channels;
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at < samples.length) {
        controller.enqueue(encoder.write(samples.subarray(at, at + chunk)));
        at += chunk;
      } else {
        controller.enqueue(encoder.end());
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "content-type": QOA_TYPE, "cache-control": "no-store", vary: "accept" } });
}
