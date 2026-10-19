// The speech stream's preferred format: Ogg Opus, which every current browser decodes itself. A
// client names it with `Accept: audio/ogg`; QOA and WAV (src/qoa-stream.ts, the WAV the engine
// wrote) are what a client that cannot play it, or a server without the encoder, falls back to.
//
// The encoder is minisilk (vendor/minisilk, put there by scripts/fetch_minisilk.ts): libopus's
// SILK encoder, wideband, in WebAssembly. It takes 16 kHz mono, so the engine's 22.05 kHz audio is
// resampled with libsoxr first (src/resample.ts); the muxer is src/ogg-opus.ts. The speech is band-
// limited to 8 kHz by that, which costs little for a voice at 24 kbit/s.
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

/** Samples per frame: 20 ms at 16 kHz. */
const FRAME = 320;
const RATE = 16_000;
/** An Ogg Opus stream always counts in 48 kHz samples. */
const PER_SAMPLE = 48_000 / RATE;
const BITRATE = 24_000;
const COMPLEXITY = 9;

/** Where scripts/fetch_minisilk.ts puts the encoder, beside the engine directory `audioDir`. */
export const minisilkPath = (audioDir: string) => join(audioDir, "..", "minisilk", "minisilk-wasm3.wasm");

interface Minisilk {
  memory: WebAssembly.Memory;
  minisilk_init(bitrate: number, complexity: number, dtx: number): number;
  minisilk_input_ptr(): number;
  minisilk_output_ptr(): number;
  minisilk_encode(): number;
  minisilk_lookahead(): number;
}

/** The compiled encoder; each stream instantiates it again, since the module holds one encoder's state. */
export interface OpusCodec {
  module: WebAssembly.Module;
  resample: Resample;
}

/** A new encoder of the module, set up for speech. */
function start(module: WebAssembly.Module): Minisilk {
  const encoder = new WebAssembly.Instance(module).exports as unknown as Minisilk;
  const status = encoder.minisilk_init(BITRATE, COMPLEXITY, 0);
  if (status < 0) {
    throw new Error(`minisilk_init failed with ${status}`);
  }
  return encoder;
}

/** Loads the encoder on first use; undefined while it is not installed or does not run here. */
export function opusLoader(audioDir: string, resample: Resample): () => Promise<OpusCodec | undefined> {
  let loading: Promise<OpusCodec | undefined> | undefined;
  return async () => {
    const file = minisilkPath(audioDir);
    // Not remembered while the file is missing, so installing it needs no restart.
    if (!loading && !existsSync(file)) {
      return;
    }
    loading ??= (async () => {
      try {
        const module = await WebAssembly.compile(await Bun.file(file).arrayBuffer());
        // Fails here, not in the first request, when the runtime lacks what the build needs (relaxed SIMD).
        start(module);
        return { module, resample };
      } catch (e) {
        console.error(`[speech] the Opus encoder cannot be loaded, speech is sent as QOA or WAV: ${String(e)}`);
      }
    })();
    return loading;
  };
}

/** Mono 16 kHz samples in -1 to 1 from the engine's audio: channels averaged, then resampled. */
function toWideband(pcm: Pcm, resample: Resample): Float32Array {
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
  const samples = toWideband(pcm, codec.resample);
  const encoder = start(codec.module);
  const input = new Float32Array(encoder.memory.buffer, encoder.minisilk_input_ptr(), FRAME);
  const output = new Uint8Array(encoder.memory.buffer, encoder.minisilk_output_ptr());
  // The decoder drops the encoder's delay from the start; the audio is padded with silence until
  // what it delays is out as well, and the last packet is cut back to where the audio ends.
  const lookahead = encoder.minisilk_lookahead();
  const target = samples.length + lookahead;
  const frames = Math.ceil(target / FRAME);
  const mux = new OggOpusMuxer({
    channels: 1,
    sampleRate: pcm.sampleRate,
    preSkip: lookahead * PER_SAMPLE,
    vendor: "index-translator, minisilk",
  });

  function* packets(): Generator<OpusPacket> {
    for (let frame = 1; frame <= frames; frame++) {
      const from = (frame - 1) * FRAME;
      input.fill(0);
      input.set(samples.subarray(from, from + FRAME));
      const length = encoder.minisilk_encode();
      if (length < 0) {
        throw new Error(`minisilk_encode failed with ${length}`);
      }
      const duration = FRAME * PER_SAMPLE;
      const padding = frame === frames ? (frames * FRAME - target) * PER_SAMPLE : 0;
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
