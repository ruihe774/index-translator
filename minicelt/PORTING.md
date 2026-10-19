# minicelt porting guide

minicelt is a mechanical Rust port of the libopus CELT-only float encoder
(`OPUS_APPLICATION_RESTRICTED_CELT`), for wasm32 only. C source: libopus 1.6.1
plus a fork's WASM SIMD / relaxed SIMD kernels (https://github.com/ruihe774/opus,
branch `v1.6.1-wasm-simd`; checked out at `/home/user/opus-wasm-simd` in the
development container). The reference for testing is plain upstream libopus
(`third_party/opus`) for the WASM 2.0 build; see Tests for WASM 3.0.

## Fixed configuration

- 48 kHz input (`upsample == 1`), mono or stereo (`channels` 1 or 2, chosen at
  init), 20 ms frames (`LM == 3`, `frame_size == 960`; short blocks are still
  used for transients). The only mode is the static `mode48000_960_120`.
- VBR, with constrained VBR on (the libopus default) or off. No CBR
  (`vbr_rate == 0` paths are removed with a `debug_assert!`).
- DTX is supported (Opus layer).
- No tonality analysis (`src/analysis.c`, `mlp.c`): `AnalysisInfo::valid` is
  always 0, and code under `if (analysis.valid)` / `st->analysis.valid` is
  removed with a `debug_assert!`. The test reference is built without
  `analysis.c` to match (see Tests).
- Float path only (no `FIXED_POINT`), no `FLOAT_APPROX`, no `ENABLE_QEXT`,
  `ENABLE_DRED`, `ENABLE_PFA`, `CUSTOM_MODES`, `RESYNTH`, no LFE, no energy
  mask (surround), no `signalling` (Opus custom header), `start == 0`.
- Where the fork has a WASM SIMD kernel (`celt/wasm`), port **that** kernel with
  `core::arch::wasm32` and drop the scalar C version. Relaxed SIMD: C's
  `#if defined(__wasm_relaxed_simd__)` becomes
  `#[cfg(target_feature = "relaxed-simd")]`. Kernels that matter here:
  `op_pvq_search_wasm` (vq_wasm.c), `celt_inner_prod_wasm`,
  `dual_inner_prod_wasm`, `xcorr_kernel_wasm`, `celt_pitch_xcorr_wasm`,
  `comb_filter_const_wasm` (pitch_wasm.c). The MDCT, FFT and `bands.c` have no
  kernels and are ported as plain scalar code.
- Branches that are unreachable under the fixed configuration (other modes or
  rates, CBR, QEXT, decoder-only `encode == 0` paths) may be removed when doing
  so is trivial; leave a `debug_assert!` of the assumption. Functions shared
  with the decoder lose their `encode` parameter (always 1). When in doubt,
  port as-is.

## Layout

One Rust module per C file, with the C file name (`celt/quant_bands.c` →
`src/celt/quant_bands.rs`, `src/opus_encoder.c` → `src/opus/encoder.rs`).
Function, struct, field and constant names stay as in C (`quant_coarse_energy`,
`st->prefilter_period`); the crate allows the naming lints. Header-only inlines
go into the module of the matching `.c` file.

| C | Rust |
|---|---|
| `arch.h` (types, `MIN16`/`MAX32`/`IMIN`/..., `celt_isnan`, `ABS16`) | `celt::arch` |
| `mathops.h`, `mathops.c` (float) | `celt::mathops` |
| `float_cast.h` | `celt::float_cast` |
| `entcode.h`/`entcode.c`, `entenc.c` | `celt::entcode`, `celt::entenc` |
| `modes.h`, `static_modes_float.h` | `celt::modes`, `celt::static_modes_float` (generated) |
| `kiss_fft.h`/`.c`, `mdct.h`/`.c` | `celt::kiss_fft`, `celt::mdct` |
| `pitch.h`/`.c` + `wasm/pitch_wasm.c` | `celt::pitch` |
| `vq.h`/`.c` + `wasm/vq_wasm.c` | `celt::vq` |
| `celt.h`, `celt.c` | `celt::celt` |
| `struct OpusCustomEncoder` | `celt::celt_encoder::CELTEncoder` (`#[repr(C)]`) |
| `opus_defines.h`, `opus_private.h` constants | `opus::defines` |
| `stack_alloc.h` | `stack` |

`CELTMode`, `kiss_fft_state`, `mdct_lookup` and `PulseCache` hold their tables
as `&'static` slices instead of pointers (they are only ever the static mode).
`CELTEncoder` keeps the C layout; its trailing variable-size arrays (`in_mem`,
`prefilter_mem`, `oldBandE`, `oldLogE`, `oldLogE2`, `energyError`) are fixed
arrays sized for two channels and indexed with the C per-channel strides
(`c*overlap`, `c*COMBFILTER_MAXPERIOD`, `c*nbEBands`), so for stereo the
bytes equal the C allocation.

## Translation rules

- Types: `int`/`opus_int32` → `i32`, `unsigned`/`opus_uint32` → `u32`,
  `opus_int16` → `i16`, `unsigned char` → `u8`, `signed char` → `i8`,
  `opus_val16`/`opus_val32`/`celt_sig`/`celt_norm`/`celt_ener`/`celt_glog`/
  `opus_res`/`celt_coef`/`float` → `f32`, `double` → `f64`.
- **Float macros**: in the float build the fixed-point macros are identities or
  plain operators. Write them out: `MULT16_32_Q15(a,b)` → `a*b`,
  `MAC16_16(c,a,b)` → `c + a*b`, `SHR32(a,s)`/`SHL32`/`PSHR32`/`VSHR32`/
  `EXTEND32`/`EXTRACT16`/`SATURATE*`/`ROUND16` → `a`, `QCONST16(x,b)`/
  `QCONST32`/`GCONST(x)` → `x` (as an `f32` literal), `HALF32(x)` → `0.5*x`,
  `ADD32`/`SUB32` → `+`/`-`, `DIV32_16(a,b)` → `a/b`. Keep the order of
  operations exactly (`(c)+(a)*(b)`, left to right). Use the `arch` functions
  for `MIN16`/`MAX16`/`MIN32`/`MAX32`/`MING`/`MAXG`/`FMIN`/`FMAX` (C ternary
  semantics, *not* `f32::min`/`max`) and `IMIN`/`IMAX`.
- **Integer promotion**: C computes `opus_int16`/`unsigned char` arithmetic in
  `int`. Cast explicitly (`a as i32 * b as i32`). Watch unsigned arithmetic
  (`opus_uint32`, `unsigned`): mixing `int` and `unsigned` converts to
  `unsigned` in C.
- **Float promotion**: C evaluates an expression in `double` as soon as one
  operand is `double` (a `1.0` or `.5` literal without `f`, a `double`
  variable, `floor()`, `log()`, `sqrt()`, `exp()`, `cos()`, ...). Reproduce the
  exact precision of every operation with `as f64`/`as f32`; `int` operands
  combined with `float` become `float`. Getting this wrong shows up as a
  bit-exactness failure. libm functions: `libm::` (double: `exp`, `log`,
  `floor`, ...; float: `floorf`, `fabsf`, ...), exactly the precision C calls.
- Rust does not contract `a * b + c` into an FMA, and the reference is built
  with `-ffp-contract=off`, so plain expressions match. Never hand-vectorize a
  plain C loop to imitate compiler output.
- C `(int)x` on a float truncates; Rust `x as i32` truncates and saturates.
  `float2int` (`lrintf`) rounds half to even (`celt::float_cast::float2int`).
  `floor(.5+x)` stays exactly that.
- Arrays: prefer slices (`&[f32]`, `&mut [i32]`). Where C uses negative
  offsets or pointer arithmetic into a larger buffer, pass the buffer plus an
  offset, or use raw pointers; `unsafe` is allowed anywhere. C argument order is
  kept; `const T *` → `&[T]`, `T *` output → `&mut [T]` / `&mut T`.
- `celt_assert`/`celt_sig_assert` → `debug_assert!`. Drop `arch` parameters.
- Plain C arithmetic uses plain Rust operators, so `checked` builds trap on
  integer overflow. Use `wrapping_*` exactly where C relies on wraparound
  (unsigned arithmetic in `entenc`, `celt_lcg_rand`, ...) and say so.
- `ALLOC` / `SAVE_STACK` / `RESTORE_STACK`:
  ```rust
  let st = stack::save();          // SAVE_STACK
  let x = st.alloc::<i32>(n);      // ALLOC(x, n, opus_int32)
  // RESTORE_STACK when st goes out of scope
  ```
  Allocated memory is not cleared, as in C. `ALLOC_NONE` → nothing.
- `celt_udiv`/`celt_sudiv`: `USE_SMALL_DIV_TABLE` is not defined (it is ARM
  only), so they are plain `/`.
- Keep the C comments that explain the algorithm; drop the boilerplate.
- No `std`, no `alloc` in non-test code.

## Tests

There are no Rust unit tests in the final tree. Two layers:

1. **Per-function oracle** (`minicelt/oracle`, during development; dropped
   before the port is finished, and kept at a git tag). A wasm32-wasip1 build
   of the fork's C (`-msimd128 -ffp-contract=off`, plus `-mrelaxed-simd` for
   the WASM 3.0 variant, with the analysis stub instead of `src/analysis.c`) is
   linked into `cargo test` binaries that run under Node's WASI. Each ported
   function has a `#[cfg(test)] mod tests` that calls the C function and the
   Rust one on the same inputs and compares all outputs and in/out state
   bit-exactly. Because the C and the Rust run in the same wasm engine with the
   same SIMD instructions, this is bit-exact for both variants.
2. **End-to-end** (`minicelt/test/compare.ts`, Deno): the wasm builds against
   natively built upstream libopus (`scripts/build-native.sh`: intrinsics off,
   `-ffp-contract=off`, `src/analysis.c` replaced by
   `minicelt/test/analysis_stub.c`), comparing packets, final range and DTX
   state frame by frame.

**Relaxed SIMD and FMA**: `f32x4.relaxed_madd` is fused on x86 with FMA (V8
emits `vfmadd`), so the WASM 3.0 build's float kernels round differently from
scalar C. The WASM 3.0 build is therefore compared end to end against the fork's
C built for wasm with `-mrelaxed-simd` (run in the same engine); the native
scalar build is the bit-exact reference for WASM 2.0 only.
