# qoa-wasm

A [QOA](https://qoaformat.org) (Quite OK Audio) encoder and decoder written by hand in
WebAssembly text format ([`src/qoa.wat`](src/qoa.wat)), with a small runtime-agnostic
TypeScript wrapper ([`src/qoa.ts`](src/qoa.ts)).

- **No runtime dependencies.** The glue uses only standard ECMAScript and the WebAssembly
  JS API. It works in browsers, workers, Node, Deno and Bun. The compiled module (~7 KB) is
  embedded as base64.
- **Bit-exact with the reference encoder.** The output is byte-for-byte identical to
  [`qoa.h`](https://github.com/phoboslab/qoa). It even matches `qoa.h`'s 32-bit
  wrap-around in its quantizer for extreme residuals. The one deliberate difference is
  described under [Notes](#notes).
- **Fast.** Uses SIMD128 and relaxed SIMD, with a plain-SIMD fallback build for engines
  that lack relaxed SIMD.

## Usage

```ts
import { Qoa } from "./src/qoa.ts";

const qoa = await Qoa.create();              // or Qoa.createSync()

// interleaved int16 PCM -> QOA file
const file: Uint8Array = qoa.encode(pcm, /* channels */ 2, /* sampleRate */ 44100);

// QOA file -> { channels, sampleRate, samples: Int16Array (interleaved) }
const { channels, sampleRate, samples } = qoa.decode(file);
```

Other entry points:

| API | Purpose |
| --- | --- |
| `qoa.encode(pcm, ch, rate, { streaming: true })` | Write `0` as the sample count, which marks the file as a stream |
| `qoa.createEncoder(ch, rate)` → `.write(pcm)` / `.end()` | Incremental encoding. Each call returns the bytes that are ready (header plus whole frames) |
| `qoa.decodeFrames(file)` | Decode frame by frame. Needed for streams whose channel count or samplerate changes |
| `Qoa.probe(file)` | Parse and validate the headers without decoding |
| `qoaEncodedSize(samples, ch)` | Exact encoded size in bytes |
| `Qoa.create(bytesOrModule)` | Use your own copy of `dist/qoa.wasm` / `dist/qoa-simd.wasm` |

Malformed input and invalid arguments throw `QoaError`. Each `Qoa` instance owns one wasm
instance and is not reentrant. Incremental encoders keep their own state, so several
of them, plus other calls, can share one instance.

## How it works

**Encoder.** For every 20-sample slice, QOA's reference encoder tries all 16 scalefactors
one after another. Each try runs the LMS predictor, quantizes, reconstructs and ranks
the error. Here, four candidate scalefactors run side by side, one per SIMD lane. Each
candidate's LMS state is spread across eight `i32x4` vectors (`h0..h3`, `w0..w3`).
Prediction, quantization, dequantization (a `relaxed_swizzle` table lookup),
reconstruction and the LMS update are therefore all lane-wise, with no horizontal
operations. The error rank is accumulated exactly in `i64x2` with `extmul`, as the
reference does. A group of four candidates is abandoned as soon as every lane ranks
worse than the best candidate so far, and groups are tried starting nearest to the
previous slice's scalefactor. Ties go to the candidate the reference tries first, which
keeps the output bit-exact.

**Decoder.** Decoding is one serial dependency chain per channel. It is written as
scalar code: full slices are completely unrolled, with the history roles rotating
between locals so no values are moved. A vector dot product puts the multiply plus a
horizontal reduction on the critical path, and was measurably slower. So was decoding
two channels in one loop, because the doubled state no longer fits in registers.

## Performance

60 s of stereo 44.1 kHz audio (`npm run bench`), on an Intel Xeon @ 2.10 GHz:

| | encode | decode |
| --- | ---: | ---: |
| this, Node 22 (V8) | 232 ms (259× realtime) | 28 ms (2146× realtime) |
| this, Bun 1.4 (JSC) | 257 ms | 33 ms |
| `qoa.h`, native, `gcc -O3 -march=native` | 409 ms | 22 ms |
| `qoa.h`, native, `clang -O3 -march=native` | 653 ms | 82 ms |

The encoder is about 1.8× faster than native `qoa.h`. The decoder is within about 1.3×
of native gcc, and its time includes copying data in and out of wasm memory.

## Development

```sh
npm install          # dev dependencies only: wabt, typescript, @types/node
npm run build        # src/qoa.wat -> dist/qoa.wasm, dist/qoa-simd.wasm, src/qoa_wasm.ts
npm test             # node --test   (or: npm run test:bun)
npm run typecheck    # src/ is checked without Node types
npm run bench
```

The tests use straightforward JavaScript implementations as oracles
([`test/reference.ts`](test/reference.ts)): a decoder that follows the spec text literally
and a port of the `qoa.h` encoder. They check:

- byte-identical encoder output across signal types, channel counts and slice/frame
  edge lengths;
- the decoder against randomly generated bitstreams;
- headers, streaming, malformed input, 31 channels, and the fallback build.

Running Node directly on `.ts` files needs Node ≥ 22.18 (type stripping).

## Notes

- `qoa.h` truncates LMS weights to 16 bits when it writes a frame header, but keeps
  using the untruncated values itself. If the weights ever leave the int16 range, its
  decoder desyncs. This encoder saturates the weights instead, in both the file and its
  own state, so the decoder always starts from the same state as the encoder. In normal
  operation the weight penalty keeps the weights well inside int16, and the output is
  identical.
- The only relaxed-SIMD instruction used is `i8x16.relaxed_swizzle`, and only with
  in-range indices, so the results are deterministic on every engine.
