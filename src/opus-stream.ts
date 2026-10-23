// The speech stream's preferred format: Ogg Opus, which every current browser decodes itself. A
// client names it with `Accept: audio/ogg`; QOA and WAV (src/qoa-stream.ts, the WAV the engine
// wrote) are what a client that cannot play it, or a server without the encoder, falls back to.
//
// The encoder is minicelt (vendor/minicelt, put there by scripts/fetch_minicelt.ts): libopus's
// CELT encoder in WebAssembly. It takes 48 kHz mono, so the engine's 22.05 kHz audio is resampled
// with libsoxr first (src/resample.ts); the muxer is src/ogg-opus.ts.
//
// The engine returns the whole utterance at once, so what is streamed is the encoded file: pages of
// about a second, encoded as the client reads.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { concat, OggOpusMuxer, type OpusPacket } from "./ogg-opus";
import type { Resample } from "./resample";
import type { Pcm } from "./wav";

/** The type a client asks for. */
export const OPUS_TYPE = "audio/ogg";

/** Samples per frame: 20 ms at 48 kHz. */
const FRAME = 960;
const RATE = 48_000;
const BITRATE = 64_000;
const COMPLEXITY = 6;
/** OPUS_BANDWIDTH_SUPERWIDEBAND (12 kHz): the engine's audio is 22.05 kHz, so nothing above 11 kHz is coded. */
const BANDWIDTH = 1104;

/** Where scripts/fetch_minicelt.ts puts the encoder, beside the engine directory `audioDir`. */
export const miniceltPath = (audioDir: string) => join(audioDir, "..", "minicelt", "minicelt-wasm3.wasm");

interface Minicelt {
  memory: WebAssembly.Memory;
  minicelt_init(channels: number, bitrate: number, complexity: number, vbrConstraint: number, dtx: number): number;
  minicelt_set_bandwidth(bandwidth: number): number;
  minicelt_input_ptr(): number;
  minicelt_output_ptr(): number;
  minicelt_encode(): number;
  minicelt_lookahead(): number;
}

/** The compiled encoder; each stream instantiates it again, since the module holds one encoder's state. */
interface OpusCodec {
  module: WebAssembly.Module;
  resample: Resample;
}

/** A new encoder of the module, set up for speech. */
function start(module: WebAssembly.Module): Minicelt {
  const encoder = new WebAssembly.Instance(module).exports as unknown as Minicelt;
  const status = encoder.minicelt_init(1, BITRATE, COMPLEXITY, 1, 0);
  if (status < 0) {
    throw new Error(`minicelt_init failed with ${status}`);
  }
  const bandwidth = encoder.minicelt_set_bandwidth(BANDWIDTH);
  if (bandwidth < 0) {
    throw new Error(`minicelt_set_bandwidth failed with ${bandwidth}`);
  }
  return encoder;
}

/**
 * A codec loaded on first use from `file()`: undefined while the file is not there, or when loading
 * it fails (logged as `failure` and the codec is given up for good). The file's absence is not
 * remembered, so installing it needs no restart.
 */
export function lazyOptional<T>(
  file: () => string,
  load: (file: string) => Promise<T>,
  failure: string,
): () => Promise<T | undefined> {
  let loading: Promise<T | undefined> | undefined;
  return async () => {
    const path = file();
    if (!loading && !existsSync(path)) {
      return;
    }
    loading ??= (async (): Promise<T | undefined> => {
      try {
        return await load(path);
      } catch (e) {
        console.error(`[speech] ${failure}: ${String(e)}`);
      }
    })();
    return loading;
  };
}

/** Loads the encoder on first use; undefined while it is not installed or does not run here. */
export function opusLoader(audioDir: string, resample: Resample): () => Promise<OpusCodec | undefined> {
  return lazyOptional(
    () => miniceltPath(audioDir),
    async (file) => {
      const module = await WebAssembly.compile(await Bun.file(file).arrayBuffer());
      // Fails here, not in the first request, when the runtime lacks what the build needs (relaxed SIMD).
      start(module);
      return { module, resample };
    },
    "the Opus encoder cannot be loaded, speech is sent as QOA or WAV",
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
  const encoder = start(codec.module);
  const input = new Float32Array(encoder.memory.buffer, encoder.minicelt_input_ptr(), FRAME);
  const output = new Uint8Array(encoder.memory.buffer, encoder.minicelt_output_ptr());
  // The decoder drops the encoder's delay from the start; the audio is padded with silence until
  // what it delays is out as well, and the last packet is cut back to where the audio ends.
  const lookahead = encoder.minicelt_lookahead();
  const target = samples.length + lookahead;
  const frames = Math.ceil(target / FRAME);
  const mux = new OggOpusMuxer({
    channels: 1,
    sampleRate: pcm.sampleRate,
    preSkip: lookahead,
    vendor: "index-translator, minicelt",
  });

  function* packets(): Generator<OpusPacket> {
    for (let frame = 1; frame <= frames; frame++) {
      const from = (frame - 1) * FRAME;
      input.fill(0);
      input.set(samples.subarray(from, from + FRAME));
      const length = encoder.minicelt_encode();
      if (length < 0) {
        throw new Error(`minicelt_encode failed with ${length}`);
      }
      const duration = FRAME;
      const padding = frame === frames ? frames * FRAME - target : 0;
      yield { data: output.slice(0, length), duration, validDuration: duration - padding };
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
  });
  return new Response(body, {
    headers: { "content-type": `${OPUS_TYPE}; codecs=opus`, "cache-control": "no-store", vary: "accept" },
  });
}
