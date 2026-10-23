// The engine's WAV as the client asked for it: Ogg Opus or QOA when `Accept` names the type and the
// codec runs here (the heavier weight first, Opus on a tie), else the WAV.

import { acceptWeight } from "./accept";
import { soxrDir } from "./audiocpp-ffi";
import type { Config } from "./config";
import { OPUS_TYPE, opusLoader, opusResponse } from "./opus-stream";
import { QOA_TYPE, qoaLoader, qoaResponse } from "./qoa-stream";
import { soxrResampler } from "./resample";
import { type Pcm, readWav } from "./wav";

const wavResponse = (wav: ArrayBuffer) =>
  new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "no-store", vary: "accept" } });

export function createSpeechResponder(cfg: Pick<Config, "publicDir" | "audioDir">) {
  const qoaCodec = qoaLoader(cfg.publicDir);
  const opusCodec = opusLoader(cfg.audioDir, soxrResampler(soxrDir(cfg.audioDir)));

  const encoders = [
    {
      type: OPUS_TYPE,
      async encode(pcm: Pcm) {
        const codec = await opusCodec();
        return codec && opusResponse(codec, pcm);
      },
    },
    {
      type: QOA_TYPE,
      async encode(pcm: Pcm) {
        const codec = await qoaCodec();
        return codec && qoaResponse(codec, pcm);
      },
    },
  ];

  return async function speechResponse(wav: ArrayBuffer, accept: string | null): Promise<Response> {
    const wanted = encoders
      .map((encoder) => ({ encoder, weight: acceptWeight(accept, encoder.type) }))
      .filter(({ weight }) => weight > 0)
      .sort((a, b) => b.weight - a.weight);
    if (wanted.length === 0) {
      return wavResponse(wav);
    }
    try {
      const pcm = readWav(new Uint8Array(wav));
      if (pcm.samples.length === 0) {
        return wavResponse(wav);
      }
      for (const { encoder } of wanted) {
        try {
          const response = await encoder.encode(pcm);
          if (response) {
            return response;
          }
        } catch (e) {
          console.error(`[speech] the utterance could not be encoded as ${encoder.type}: ${String(e)}`);
        }
      }
    } catch (e) {
      console.error(`[speech] the utterance could not be read for encoding, sending WAV: ${String(e)}`);
    }
    return wavResponse(wav);
  };
}
