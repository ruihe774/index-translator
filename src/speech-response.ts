// The engine's WAV as the client asked for it: Ogg Opus when `Accept` names it and the encoder runs
// here, else the WAV.

import { acceptWeight } from "./accept";
import type { Config } from "./config";
import { soxrDir } from "./ffi-util";
import { OPUS_TYPE, opusLoader, opusResponse } from "./opus-stream";
import { soxrResampler } from "./resample";
import { readWav } from "./wav";

const wavResponse = (wav: ArrayBuffer) =>
  new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "no-store", vary: "accept" } });

export function createSpeechResponder(cfg: Pick<Config, "audioDir">) {
  const opusCodec = opusLoader(cfg.audioDir, soxrResampler(soxrDir(cfg.audioDir)));

  return async function speechResponse(wav: ArrayBuffer, accept: string | null): Promise<Response> {
    if (acceptWeight(accept, OPUS_TYPE) <= 0) {
      return wavResponse(wav);
    }
    try {
      const pcm = readWav(new Uint8Array(wav));
      const codec = pcm.samples.length > 0 ? await opusCodec() : undefined;
      if (codec) {
        return opusResponse(codec, pcm);
      }
    } catch (e) {
      console.error(`[speech] the utterance could not be encoded as ${OPUS_TYPE}, sending WAV: ${String(e)}`);
    }
    return wavResponse(wav);
  };
}
