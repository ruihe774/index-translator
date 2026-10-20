// Sample-rate conversion with libsoxr through bun:ffi: the library scripts/build_soxr.ts builds, the
// one audio.cpp resamples with, so a speech stream that is re-encoded has gone through the same
// resampler as the voice. Used on the main thread: one call per utterance, which takes a few
// milliseconds for a minute of speech.

import { CString, dlopen } from "bun:ffi";
import { existsSync } from "node:fs";

import { soxrLibraryPath } from "./audiocpp-ffi";

// A soxr_quality_spec_t: precision (bits), phase_response (50 = linear), passband_end and stopband_begin
// (fractions of the lower Nyquist rate), then `e` and `flags` (zero; six doubles cover the struct's padding
// whether `unsigned long` is 32 or 64 bits). A NULL spec is not libsoxr's "HQ" recipe: it rolls off from
// about 0.8 of Nyquist (-3.5 dB at 9 kHz, -22 dB at 10 kHz for 22.05 kHz audio), which cut the top of the
// engine's speech before the Opus encoder; this one is flat to 0.95 (10.4 kHz at 22.05 kHz).
const QUALITY_SPEC = new Float64Array([20, 50, 0.95, 1, 0, 0]);

function bind(dir: string) {
  const path = soxrLibraryPath(dir);
  if (!existsSync(path)) {
    throw new Error(`libsoxr not found in ${dir}; run: bun scripts/build_soxr.ts`);
  }
  return dlopen(path, {
    // soxr_error_t is a string, null when it worked; the io and runtime specs are left to their defaults
    // (32-bit float samples, interleaved).
    soxr_oneshot: {
      args: ["f64", "f64", "u32", "ptr", "usize", "ptr", "ptr", "usize", "ptr", "ptr", "ptr", "ptr"],
      returns: "ptr",
    },
  }).symbols;
}

export type Resample = (samples: Float32Array, channels: number, from: number, to: number) => Float32Array;

/** A resampler on the libsoxr in `dir`, opened on the first use. */
export function soxrResampler(dir: string): Resample {
  let lib: ReturnType<typeof bind> | undefined;
  return (samples, channels, from, to) => {
    if (from === to) {
      return samples;
    }
    lib ??= bind(dir);
    const frames = Math.floor(samples.length / channels);
    // The output is `frames * to / from` long, give or take the filter's edge.
    const capacity = Math.ceil((frames * to) / from) + 64;
    const out = new Float32Array(capacity * channels);
    const done = new BigUint64Array(2);
    const error = lib.soxr_oneshot(
      from,
      to,
      channels,
      samples,
      BigInt(frames),
      done.subarray(0, 1),
      out,
      BigInt(capacity),
      done.subarray(1, 2),
      null,
      QUALITY_SPEC,
      null,
    );
    if (error) {
      throw new Error(`libsoxr: ${new CString(error)}`);
    }
    return out.subarray(0, Number(done[1]) * channels);
  };
}
