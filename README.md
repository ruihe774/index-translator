# minisilk / minicelt

Minimal Opus encoders for WebAssembly: Rust ports of the libopus 1.6.1 float encoder, `no_std`,
no allocation, using WASM SIMD (which upstream libopus does not). Each produces valid Opus
packets that are bit-exact with upstream libopus configured the same way.

| Crate | Encoder | Scope |
|---|---|---|
| [minisilk](minisilk/README.md) | SILK-only (`OPUS_APPLICATION_RESTRICTED_SILK`) | mono, 16 kHz, wideband, 20 ms, VBR, DTX |
| [minicelt](minicelt/README.md) | CELT-only (`OPUS_APPLICATION_RESTRICTED_CELT`) | mono/stereo, 48 kHz, 20 ms, VBR/constrained VBR, DTX |

The two crates share no code. Both target wasm32 only, in two variants: WASM 2.0 (`+simd128`)
and WASM 3.0 (`+simd128,+relaxed-simd`).

## Build and test

Requires Rust with the `wasm32-unknown-unknown` target; the tests also need a C compiler, CMake,
Ninja and Deno.

```sh
scripts/build.sh [silk|celt|all] [2|3|all] [release|checked|both]   # -> target/mini{silk,celt}-wasm{2,3}[-checked].wasm
git submodule update --init                                         # third_party/opus (libopus v1.6.1)
scripts/test.sh [silk|celt|all] [--quick] [audio files...]
```

## License

BSD-3-Clause, as a derivative of libopus; see [COPYING](COPYING) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The speech samples in `test/audio` are GPL-2.0
and are used only by the tests.
