# minisilk

A minimal Opus encoder: a Rust port of the libopus SILK-only float
encoder (`OPUS_APPLICATION_RESTRICTED_SILK`), designed for WebAssembly. `no_std`, no allocation.
WASM SIMD is used (which the upstream libopus does not).
Its packets are valid Opus and bit-exact with upstream libopus 1.6.1
configured the same way.

## Scope

Fixed on purpose, to keep the encoder small:

- wasm32 only, in two variants: WASM 2.0 (`+simd128`) and WASM 3.0 (`+simd128,+relaxed-simd`)
- mono, 16 kHz input (resample before calling), wideband, 20 ms frames (320 samples), VBR
- DTX supported; no FEC/LBRR, CBR, stereo, or 10/40/60 ms frames

## Build

Requires Rust with the `wasm32-unknown-unknown` target.

```sh
scripts/build.sh [2|3|all] [release|checked|both]
```

This writes `target/minisilk-wasm2.wasm` and `target/minisilk-wasm3.wasm`. The `checked` builds
keep debug assertions and overflow checks and are used by the tests.

## Use

The `.wasm` exports a single static encoder (see `wasm/src/lib.rs`):

| Export | |
|---|---|
| `minisilk_init(bitrate, complexity, dtx)` | (re)initialise; returns 0 or a negative Opus error |
| `minisilk_input_ptr()` / `minisilk_input_i16_ptr()` | 320-sample input buffer (f32 in ±1, or i16) |
| `minisilk_encode()` / `minisilk_encode_i16()` | encode one frame; returns the packet length or a negative error |
| `minisilk_output_ptr()` | packet bytes (capacity 1276) |
| `minisilk_set_bitrate/complexity/dtx/packet_loss_perc(v)` | mirror the `OPUS_SET_*` ctls |
| `minisilk_lookahead()`, `minisilk_final_range()`, `minisilk_in_dtx()` | mirror the `OPUS_GET_*` ctls |

```js
const { instance } = await WebAssembly.instantiateStreaming(fetch('minisilk-wasm2.wasm'));
const x = instance.exports;
x.minisilk_init(24000, 5, 0);
new Float32Array(x.memory.buffer, x.minisilk_input_ptr(), 320).set(frame);
const n = x.minisilk_encode();
const packet = new Uint8Array(x.memory.buffer, x.minisilk_output_ptr(), n).slice();
```

## Test

```sh
git submodule update --init   # third_party/opus (libopus v1.6.1)
scripts/test.sh [--quick] [audio files...]
```

Needs Rust, a C compiler, CMake, Ninja and Deno. The test encodes the same inputs with every wasm
build and with natively built libopus (via Deno FFI), and requires identical packets, final range
and DTX state against the scalar build. See [PORTING.md](PORTING.md) for details and translation rules.

## License

BSD-3-Clause, as a derivative of libopus; see [COPYING](COPYING) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The speech samples in `test/audio` are GPL-2.0
and are used only by the tests.
