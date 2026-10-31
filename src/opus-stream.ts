// The speech stream's compressed format: Ogg Opus, which every current browser decodes itself. A
// client names it with `Accept: audio/ogg`; the WAV the engine wrote is what a client that cannot play
// it, or a server without the encoder, gets instead.
//
// The encoder is libopus (vendor/opus, built by scripts/build_libopus.ts; src/opus-ffi.ts). It is given
// 48 kHz mono, so the engine's 22.05 kHz audio is resampled with libsoxr first (src/resample.ts); the
// muxer is src/ogg-opus.ts.
//
// The engine returns the whole utterance at once, so what is streamed is the encoded file: pages of
// about a second, encoded as the client reads.

import { lazyOptional } from "./lazy-optional";
import { concat, OggOpusMuxer, type OpusPacket } from "./ogg-opus";
import { opusDir, OpusEncoder, type OpusEncoderOptions, opusLibraryPath } from "./opus-ffi";
import type { Resample } from "./resample";
import type { Pcm } from "./wav";

/** The type a client asks for. */
export const OPUS_TYPE = "audio/ogg";

/** Samples per frame: 20 ms at 48 kHz. */
const FRAME = 960;
const RATE = 48_000;

const ENCODER: OpusEncoderOptions = {
  sampleRate: RATE,
  channels: 1,
  bitrate: 64_000,
  // 7 and up add libopus's tonality analysis, which steers CELT's bit allocation for music; on the
  // example voices it changed neither the size nor the segmental SNR (+0.2 dB) to speak of, and
  // encoding took a third longer.
  complexity: 6,
  // OPUS_BANDWIDTH_SUPERWIDEBAND (12 kHz): the engine's audio is 22.05 kHz, so nothing above 11 kHz is coded.
  bandwidth: 1104,
};

/** Where the encoder is: libopus's directory. */
interface OpusCodec {
  dir: string;
  resample: Resample;
}

/** Loads the encoder on first use; undefined while it is not installed or does not open here. */
export function opusLoader(audioDir: string, resample: Resample): () => Promise<OpusCodec | undefined> {
  const dir = opusDir(audioDir);
  return lazyOptional(
    () => opusLibraryPath(dir),
    () => {
      // Fails here, not in the first request, when the library does not open or refuses the settings.
      new OpusEncoder(dir, ENCODER).destroy();
      return Promise.resolve({ dir, resample });
    },
    "the Opus encoder cannot be loaded, speech is sent as WAV",
  );
}

/** Mono 48 kHz samples in -1 to 1 from the engine's audio: channels averaged, then resampled. */
function toEncoderRate(pcm: Pcm, resample: Resample): Float32Array {
  let mono = pcm.samples;
  if (pcm.channels > 1) {
    const frames = Math.floor(mono.length / pcm.channels);
    mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < pcm.channels; c++) {
        sum += pcm.samples[i * pcm.channels + c]!;
      }
      mono[i] = sum / pcm.channels;
    }
  }
  const out = resample(mono, 1, pcm.sampleRate, RATE);
  // The resampler overshoots a little at a full-scale edge; the encoder wants -1 to 1.
  return out.map((v) => Math.max(-1, Math.min(1, v)));
}

/** The audio as an Ogg Opus stream, encoded a page at a time as the client reads. */
export function opusResponse(codec: OpusCodec, pcm: Pcm): Response {
  const samples = toEncoderRate(pcm, codec.resample);
  const encoder = new OpusEncoder(codec.dir, ENCODER);
  // The decoder drops the encoder's delay from the start; the audio is padded with silence until
  // what it delays is out as well, and the last packet is cut back to where the audio ends.
  const { lookahead } = encoder;
  const target = samples.length + lookahead;
  const frames = Math.ceil(target / FRAME);
  const mux = new OggOpusMuxer({
    channels: 1,
    sampleRate: pcm.sampleRate,
    preSkip: lookahead,
    vendor: "index-translator, libopus",
  });

  // The encoder is freed when the generator ends (at the last packet or on an error) or the client goes.
  function* packets(): Generator<OpusPacket> {
    try {
      const input = new Float32Array(FRAME);
      for (let frame = 1; frame <= frames; frame++) {
        const from = (frame - 1) * FRAME;
        input.fill(0);
        input.set(samples.subarray(from, from + FRAME));
        const duration = FRAME;
        const padding = frame === frames ? frames * FRAME - target : 0;
        yield { data: encoder.encode(input), duration, validDuration: duration - padding };
      }
    } finally {
      encoder.destroy();
    }
  }

  const queue = packets();
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    // Encodes until a page is complete, or to the end of the audio.
    pull(controller) {
      const parts: Uint8Array[] = [];
      if (!started) {
        started = true;
        parts.push(mux.header());
      }
      for (;;) {
        const next = queue.next();
        if (next.done) {
          parts.push(mux.finish());
          controller.enqueue(concat(parts));
          controller.close();
          return;
        }
        const page = mux.addPacket(next.value);
        if (page.length > 0) {
          parts.push(page);
          controller.enqueue(concat(parts));
          return;
        }
      }
    },
    cancel() {
      // Also before the first packet, when the generator has not entered its `try`.
      encoder.destroy();
    },
  });
  return new Response(body, {
    headers: { "content-type": `${OPUS_TYPE}; codecs=opus`, "cache-control": "no-store", vary: "accept" },
  });
}
