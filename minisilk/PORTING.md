# minisilk porting guide

minisilk is a mechanical Rust port of the libopus SILK-only float encoder
(`OPUS_APPLICATION_RESTRICTED_SILK`), for wasm32 only. C source: libopus 1.6.1
plus a fork's WASM SIMD / relaxed SIMD kernels (https://github.com/ruihe774/opus-wasm-simd,
branch `v1.6.1-wasm-simd`, submodule `third_party/opus-wasm-simd`). The kernels are bit-exact with the scalar C, so the
reference for testing is plain upstream libopus (`third_party/opus`).

## Fixed configuration

- 16 kHz mono input, wideband (internal rate is always 16 kHz), 20 ms frames
  (`nb_subfr == 4`, `frame_length == 320`), VBR.
- DTX is supported. No FEC/LBRR, no CBR, no stereo, no resampler (replaced by a
  10-sample delay line), no 10/40/60 ms frames.
- Float path only (`silk/float`, no `FIXED_POINT`).
- Where the fork has a WASM SIMD kernel (`silk/wasm`, `silk/float/wasm`,
  `celt/wasm`), port **that** kernel with `core::arch::wasm32` and drop the
  scalar C version. Relaxed SIMD: C's `#if defined(__wasm_relaxed_simd__)`
  becomes `#[cfg(target_feature = "relaxed-simd")]`. Scalar fallbacks for
  configurations we never use (e.g. `nStatesDelayedDecision > 4`) become a
  `debug_assert!`.
- Branches that are unreachable under the fixed configuration (fs_kHz != 16,
  nb_subfr == 2, stereo, LBRR, CBR) may be removed when doing so is trivial;
  leave a `debug_assert!` of the assumption. When in doubt, port as-is.

## Layout

One Rust module per C file, with the C file name (`silk/NLSF_VQ.c` →
`src/silk/NLSF_VQ.rs`). Function, struct, field and constant names stay as in C
(`silk_NLSF_VQ`, `psEncC->sCmn.fs_kHz`); the crate allows the naming lints.

| C | Rust |
|---|---|
| `silk/define.h`, `errors.h`, `tuning_parameters.h`, `pitch_est_defines.h` | `silk::{define, tuning_parameters, pitch_est_defines}` (ints are `i32`, `1.0f` → `f32`, `1.0` → `f64`) |
| `SigProc_FIX.h` macros, `macros.h`, `Inlines.h` | `silk::macros` |
| `SigProc_FLP.h` inlines, `float2int` | `silk::float::sigproc_flp` |
| `structs.h`, `control.h`, `structs_FLP.h` | `silk::structs`, `silk::float::structs_flp` (`#[repr(C)]`, same layout as C) |
| `tables.h` | `silk::tables` (re-exports all `tables_*` modules) |
| `entcode.h` `ec_ctx` | `celt::entcode` |
| `stack_alloc.h` | `stack` |

## Translation rules

- Types: `opus_int`/`int`/`opus_int32` → `i32`, `opus_int16` → `i16`,
  `opus_int8` → `i8`, `opus_uint8` → `u8`, `silk_float`/`float` → `f32`,
  `double` → `f64`.
- **Integer promotion**: C computes `opus_int16` arithmetic in `int`. Cast
  explicitly (`a as i32 * b as i32`). The macros take `i32` arguments for that
  reason.
- **Float promotion**: C evaluates an expression in `double` as soon as one
  operand is `double` (a `1.0` literal, a `double` variable, `log10()` etc.).
  Reproduce the exact precision of every operation with `as f64`/`as f32`.
  Getting this wrong shows up as a bit-exactness failure.
- Rust does not contract `a * b + c` into an FMA, and the reference is built
  with `-ffp-contract=off`, so plain expressions match. Never hand-vectorize a
  plain C loop to imitate compiler output (with contraction on, clang fuses
  multiply-adds in loops it auto-vectorizes under `-mrelaxed-simd`, which would
  make the result depend on the optimizer).
- C `(opus_int)x` on a float truncates; Rust `x as i32` truncates and saturates.
  `silk_float2int`/`float2int` round half to even (`f32.nearest`).
- Arrays: prefer slices (`&[i16]`, `&mut [f32]`). Where C uses negative
  offsets or pointer arithmetic into a larger buffer, pass the buffer plus an
  offset, or use raw pointers; `unsafe` is allowed anywhere.
- `silk_assert`/`celt_assert` → `debug_assert!`. Drop `arch` parameters.
- Plain C arithmetic uses plain Rust operators, so debug builds trap on
  overflow. Use the `_ovflw` macros / `wrapping_*` exactly where C does. If C
  overflows (in practice wraps) in normal operation, use `wrapping_*` and say
  so in a comment.
- `ALLOC` / `SAVE_STACK` / `RESTORE_STACK`:
  ```rust
  let st = stack::save();          // SAVE_STACK
  let x = st.alloc::<i32>(n);      // ALLOC(x, n, opus_int32)
  // RESTORE_STACK when st goes out of scope
  ```
  Allocated memory is not cleared, as in C.
- Keep the C comments that explain the algorithm; drop the boilerplate.
- No `std`, no `alloc` in non-test code.

## Tests

There are no Rust unit tests. `minisilk/test/compare.ts` (Deno) drives the wasm builds
through their exports next to natively built upstream libopus (via FFI and the
non-variadic wrappers in `minisilk/test/shim.c`) and compares the output frame by frame:

```sh
git submodule update --init      # third_party/opus (libopus v1.6.1)
scripts/test.sh silk [--quick] [audio files...]
```

Requirements: Rust with the `wasm32-unknown-unknown` target, a C compiler,
CMake, Ninja and Deno. Paths are relative to the workspace root. `scripts/test.sh`
runs `scripts/build-native.sh` once (rerun it after changing `test/shim.c` or the
submodule), `scripts/build.sh silk all both`, then the comparison.

- `scripts/build-native.sh` builds `target/native/minisilk-scalar.so` (intrinsics
  off) and `minisilk-rtcd.so` (upstream defaults, SSE/AVX2 on x86), both with
  `-ffp-contract=off`.
- `scripts/build.sh silk all both` builds the release wasm and the `checked` ones
  (the `checked` Cargo profile: release code with `debug_assert!`s and overflow
  checks, which trap on failure).
- Inputs: the speech recordings in `test/audio` (see
  `THIRD_PARTY_NOTICES.md`) at two levels with silent and noisy pauses, synthetic
  speech, noise at several levels, a chirp, a clipped square wave and clicks,
  tones and DC. Configurations: every bitrate x complexity, DTX on/off, i16/f32
  input, hot f32 input, and random mid-stream ctl changes.
- Every wasm build must be bit-exact with the scalar build (packets, final
  range, DTX state). The rtcd build's float kernels sum in a different order,
  so it is compared for stream validity and coding quality only. Every minisilk
  packet is also decoded natively and its decoder final range checked.
- A mismatch shows only where the stream diverges. The per-function
  differential tests against a wasm build of the C (one per ported function,
  comparing whole encoder states) are in commit `adfc1f7` (the parent of `c58066e`,
  which dropped them); check it out to localize a regression.
