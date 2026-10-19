# minicelt

A minimal Opus encoder: a Rust port of the libopus CELT-only float encoder
(`OPUS_APPLICATION_RESTRICTED_CELT`), designed for WebAssembly. `no_std`, no allocation (a 48 KiB
static scratch buffer). WASM SIMD is used (which the upstream libopus does not). Its packets are
valid Opus and bit-exact with libopus 1.6.1 configured the same way and built with the same WASM
SIMD kernels (https://github.com/ruihe774/opus-wasm-simd, branch `v1.6.1-wasm-simd`).

## Scope

Fixed on purpose, to keep the encoder small:

- wasm32 only, in two variants: WASM 2.0 (`+simd128`) and WASM 3.0 (`+simd128,+relaxed-simd`)
- 48 kHz input (resample before calling), mono or stereo, 20 ms frames (960 samples per channel)
- VBR, with constrained VBR on (the libopus default) or off; DTX supported
- no CBR, no tonality analysis (libopus runs it at complexity 7 and above; minicelt behaves
  like libopus with it disabled), no other frame sizes or sampling rates

## Build

Requires Rust with the `wasm32-unknown-unknown` target. From the workspace root:

```sh
scripts/build.sh celt [2|3|all] [release|checked|both]
```

This writes `target/minicelt-wasm2.wasm` and `target/minicelt-wasm3.wasm` (about 125 KB each).
The `checked` builds keep debug assertions and overflow checks and are used by the tests.

## Use

The `.wasm` exports a single static encoder (see `wasm/src/lib.rs`):

| Export | |
|---|---|
| `minicelt_init(channels, bitrate, complexity, vbr_constraint, dtx)` | (re)initialise; returns 0 or a negative Opus error |
| `minicelt_input_ptr()` / `minicelt_input_i16_ptr()` | input buffer for 960 interleaved samples per channel (f32 in ±1, or i16) |
| `minicelt_encode()` / `minicelt_encode_i16()` | encode one frame; returns the packet length or a negative error |
| `minicelt_output_ptr()` | packet bytes (capacity 1276) |
| `minicelt_set_bitrate/complexity/vbr_constraint/dtx/packet_loss_perc/bandwidth(v)` | mirror the `OPUS_SET_*` ctls |
| `minicelt_lookahead()`, `minicelt_final_range()`, `minicelt_in_dtx()` | mirror the `OPUS_GET_*` ctls |

```js
const { instance } = await WebAssembly.instantiateStreaming(fetch('minicelt-wasm2.wasm'));
const x = instance.exports;
x.minicelt_init(2, 96000, 10, 1, 0);
new Float32Array(x.memory.buffer, x.minicelt_input_ptr(), 1920).set(interleavedFrame);
const n = x.minicelt_encode();
const packet = new Uint8Array(x.memory.buffer, x.minicelt_output_ptr(), n).slice();
```

## Test

```sh
git submodule update --init   # third_party/opus (libopus v1.6.1), third_party/opus-wasm-simd
scripts/test.sh celt [--quick] [audio files...]
```

Needs Rust, a C compiler, CMake, Ninja, wasi-sdk (`WASI_SDK_PATH`) and Deno; the submodule
`third_party/opus-wasm-simd` holds the fork. The test encodes the same inputs with every wasm build, with the C built to
wasm with the same kernels, and with natively built libopus (via Deno FFI), and requires identical
packets, final range and DTX state against the C wasm builds. See [PORTING.md](PORTING.md) for
details and translation rules.

## License

BSD-3-Clause, as a derivative of libopus; see [COPYING](../COPYING) and
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
