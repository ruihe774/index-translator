# minisilk porting guide

minisilk is a mechanical Rust port of the libopus SILK-only float encoder
(`OPUS_APPLICATION_RESTRICTED_SILK`), for wasm32 only. C source:
`/mnt/workspace/opus` (a libopus fork with WASM SIMD / relaxed SIMD kernels).

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
- Rust does not contract `a * b + c` into an FMA. The oracle is built with
  `-ffp-contract=off`, so C only fuses where the source explicitly uses a
  relaxed madd intrinsic; plain expressions match. (With contraction on, clang
  fuses multiply-adds in loops it auto-vectorizes under `-mrelaxed-simd`, which
  would make the reference depend on the optimizer.) Never hand-vectorize a
  plain C loop to imitate compiler output.
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

Every ported function gets a differential test against the C oracle in a
`#[cfg(test)] mod tests` at the bottom of its module:

```rust
#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_lin2log(inLin: i32) -> i32;
        }
    }
    #[test]
    fn matches_c() { /* random + edge-case inputs; compare outputs bit-exactly */ }
}
```

- The oracle (`oracle/`) is the full float libopus built with wasi-sdk with the
  same SIMD variant as the test build, linked into the test binary, so every
  non-`static` C function can be declared and called. Kernels are exported
  under their WASM names (`silk_NSQ_wasm`, `celt_pitch_xcorr_wasm`,
  `silk_inner_product_FLP_wasm`, ...). Declare C functions with minisilk's own
  `#[repr(C)]` types.
- Compare all outputs and all in/out state bit-exactly (floats via
  `to_bits()`).
- `testutil` has `Rng`, `SpeechGen` (speech-like 16 kHz signal), `zeroed_box`,
  and `CSilkEncoder`, a `silk_encoder` state driven by the C `silk_Encode` in
  minisilk's configuration, for realistic states and inputs.
- Run both variants: `scripts/test.sh` (or `scripts/test.sh 2|3`, plus cargo
  test args, e.g. `scripts/test.sh 3 NLSF`).
- On wasm a panic aborts the whole test binary, so the first failure stops the
  run; use `-- --nocapture` to see its message.
- Use realistic input ranges (what the encoder actually feeds the function),
  plus edge cases. Random garbage inputs can make C hit undefined behaviour.

## Native cross-check

The wasm C oracle is itself checked against natively built upstream libopus (the
commit the fork is based on) by encoding through the public API from Deno:

```sh
native/build.sh && scripts/build.sh
deno run --allow-read --allow-ffi --allow-run native/compare.ts [--quick] [audio files...]
```

`native/build.sh` builds `target/native/libopus-scalar.so` (intrinsics off,
`-ffp-contract=off`) and `libopus-rtcd.so` (upstream defaults, SSE/AVX2). Both
wasm variants must be bit-exact with the scalar build (packets, final range,
DTX state). The rtcd build's float kernels sum in a different order, so it is
compared for stream validity and coding quality only. Every minisilk packet is
also decoded natively and its decoder final range checked.

## Struct layout

`scripts/gen_layout.py` generates a C/Rust `sizeof`/`offsetof` cross-check from
the structs in `silk/structs.rs`, `silk/float/structs_flp.rs` and
`celt/entcode.rs`. Re-run it after changing any of them.
