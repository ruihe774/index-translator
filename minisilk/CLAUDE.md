# minisilk

Rust port of the libopus SILK-only float encoder for wasm32. Read `PORTING.md` before changing
`src/`; it holds the translation rules and test details.

## Scope (fixed, do not widen without asking)

- wasm32 only (no native build); variants WASM 2.0 (`+simd128`) and 3.0 (`+relaxed-simd`).
- Mono, 16 kHz, wideband, 20 ms frames, VBR. DTX kept; no FEC/LBRR, CBR, stereo, other frame sizes.
  Trim aggressively: anything that cannot change the output within this subset (code, state, tables) is removed, not kept "for completeness".
- `no_std`, no alloc. Scratch memory is the static pseudostack in `src/stack.rs`.

## Layout

- `src/silk`, `src/celt`, `src/opus`: one Rust module per C file, C names kept.
- `wasm/`: the `minisilk-wasm` cdylib with the `minisilk_*` exports; `wasm/build.rs` sets the shadow stack size.
- `test/compare.ts` (Deno FFI) + `test/shim.c`: differential test against `third_party/opus`
  (submodule, libopus v1.6.1).
  `test/stack_peak.ts` measures the stack sizes (see `PORTING.md`, "Memory").

## Commands (from the workspace root)

- `scripts/build.sh silk [2|3|all] [release|checked|both]` -> `target/minisilk-wasm{2,3}[-checked].wasm`
- `scripts/test.sh silk [--quick]` builds everything and runs the comparison. There are no Rust unit tests.

## Rules

- Bit-exactness with scalar libopus is the test goal. Match C numeric precision exactly
  (integer promotion, `f32` vs `f64`); never hand-vectorize plain C loops.
- Where the fork has a WASM SIMD kernel, port it with `core::arch::wasm32`; add no scalar fallback.
  Relaxed SIMD uses `cfg(target_feature = "relaxed-simd")`.
- Keep C function/field/constant names. Comment density follows the C comments that explain the algorithm.
- `src/` is BSD-3 (libopus derivative); `test/audio` is GPL-2.0 and test-only.
