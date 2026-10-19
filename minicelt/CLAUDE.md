# minicelt

Rust port of the libopus CELT-only float encoder for wasm32. Read `PORTING.md` before changing
`src/`; it holds the translation rules and test details.

## Scope (fixed, do not widen without asking)

- wasm32 only (no native build); variants WASM 2.0 (`+simd128`) and 3.0 (`+relaxed-simd`).
- 48 kHz, mono or stereo, 20 ms frames, VBR with constrained VBR on/off, DTX.
  No CBR, no tonality analysis, no other rates or frame sizes, no QEXT/DRED/custom modes.
- `no_std`, no alloc. Scratch memory is the static pseudostack in `src/stack.rs`.

## Layout

- `src/celt`, `src/opus`: one Rust module per C file, C names kept.
- `wasm/`: the `minicelt-wasm` cdylib with the `minicelt_*` exports.
- `test/compare.ts` (Deno FFI) + `test/shim.c` + `test/analysis_stub.c`: differential test against
  `third_party/opus`. `scripts/gen_tables.py` generates the tables.

## Commands (from the workspace root)

- `scripts/build.sh celt [2|3|all] [release|checked|both]` -> `target/minicelt-wasm{2,3}[-checked].wasm`
- `scripts/test.sh celt [--quick]` builds everything and runs the comparison.

## Rules

- Bit-exactness with scalar libopus is the test goal. Match C numeric precision exactly
  (integer promotion, `f32` vs `f64`); never hand-vectorize plain C loops.
- Where the fork has a WASM SIMD kernel, port it with `core::arch::wasm32`; add no scalar fallback.
  Relaxed SIMD uses `cfg(target_feature = "relaxed-simd")`.
- Keep C function/field/constant names. Comment density follows the C comments that explain the algorithm.
- `src/` is BSD-3 (libopus derivative).
