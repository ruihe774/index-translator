# minicelt porting guide

minicelt is a mechanical Rust port of the libopus CELT-only float encoder
(`OPUS_APPLICATION_RESTRICTED_CELT`), for wasm32 only. C source: the fork
https://github.com/ruihe774/opus-wasm-simd, branch `v1.6.1-wasm-simd`
(upstream libopus 1.6.1 plus WASM SIMD / relaxed SIMD kernels in `celt/wasm`;
its scalar encoder code is identical to 1.6.1). Do not use the fork's
`wasm-simd` branch: it is based on post-1.6.1 upstream, whose scalar code
behaves differently. The bit-exact reference for testing is that C built to wasm
and run in the same engine (the kernels sum in lane order, so they are not
bit-exact with scalar C); natively built upstream libopus 1.6.1
(`third_party/opus`) is a validity and quality cross-check. See Tests.

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
   of the fork's C (branch `v1.6.1-wasm-simd`, `OPUS_SRC`, default
   `/home/user/opus-v1.6.1-wasm-simd`; wasi-sdk at `WASI_SDK_PATH`, default
   `/opt/wasi-sdk`; `-msimd128 -ffp-contract=off`, plus `-mrelaxed-simd` for
   the WASM 3.0 variant, with `csrc/analysis_stub.c` instead of `src/analysis.c`/`mlp*.c`)
   is linked into `cargo test` binaries that run under Node's WASI. Each ported
   function has a `#[cfg(test)] mod tests` that calls the C function and the
   Rust one on the same inputs and compares all outputs and in/out state
   bit-exactly. Because the C and the Rust run in the same wasm engine with the
   same SIMD instructions, this is bit-exact for both variants.

   Run: `minicelt/scripts/oracle-test.sh [2|3|all] [cargo test args]` (from anywhere;
   needs `rustup target add wasm32-wasip1`, Node). It runs
   `cargo test -p minicelt --target wasm32-wasip1` (runner `minicelt/scripts/wasi-run`,
   `[profile.test]` opt-level 1 with debug assertions and overflow checks); variant 3 uses
   `+relaxed-simd` and `--target-dir target/v3`.

   Writing a test (examples: `celt/entenc.rs`, `layout_tests.rs`; helpers in `src/testutil.rs`):
   - Public C functions are declared in `minicelt_oracle` under their C names
     (`ec_enc_init`, `comb_filter`, `alg_quant`, `quant_all_bands`, ...). C `static` functions
     are reached through `oracle_<name>` wrappers: the .c file is compiled via a wrapper TU
     `oracle/csrc/<file>_x.c` that `#include`s it and forwards (celt_encoder, bands, vq,
     quant_bands, rate, cwrs, pitch, kiss_fft, opus_encoder; header inlines/macros in
     `inlines_x.c`). To expose another static function add the forwarder there and the
     `extern` line in `oracle/src/lib.rs`. `CELTMode *`, `ec_enc *`, `struct band_ctx *` ...
     are `*const/*mut c_void`: cast the Rust `#[repr(C)]` value (`&mut x as *mut _ as *mut c_void`).
     `testutil::c_mode()` is the C mode; `minicelt_oracle::mode_info()` gives its tables
     (so tests do not depend on the Rust mode tables); `layout_tests.rs` checks struct layouts
     from the `oracle_*_layout` tables.
   - Call the Rust and the C function on identical copies of random input (`testutil::Rng`,
     `MusicGen`/`music()` for realistic 48 kHz signals), then compare every output buffer and
     the state (`testutil::same_enc` for range coders, `assert_eq!` on `f32::to_bits` or the
     raw bytes for float state).
   - Whole-encoder tests: `RefEncoder::new(channels)` wraps `opus_encoder_create(48000, ch,
     RESTRICTED_CELT)` with `set_bitrate/complexity/vbr/vbr_constraint/dtx`, `encode_float`,
     `final_range`, `in_dtx`, and `celt_encoder_ptr()` / `celt_state_bytes()` for the embedded
     `CELTEncoder`, to compare packets and the encoder state frame by frame.
     The reference has no tonality analysis, matching the port.
2. **End to end** (`minicelt/test/compare.ts`, Deno; `scripts/test.sh celt [--quick] [--all]
   [--refs-only] [--strict-scalar] [--filter=text] [audio files...]`). Every implementation sits behind one
   adapter with the `test/shim.c` API (create, ctl setters, encode i16/f32, final range, in_dtx,
   lookahead; decoder for the bitstream check):
   - `scalar`, `rtcd`: upstream libopus 1.6.1 natively (`scripts/build-native.sh`, Deno FFI).
   - `cwasm2`, `cwasm3`: the fork's C (`OPUS_WASM_SRC`) + `shim.c` + `analysis_stub.c`, built by
     `minicelt/test/build-cwasm.sh` (run by `scripts/test.sh` when `target/native/minicelt-cwasm{2,3}.wasm`
     are missing; wasi-sdk at `WASI_SDK_PATH`, default `/opt/wasi-sdk`) as wasm32-wasip1 reactors
     (`-mexec-model=reactor`, exporting `shim_*`, `malloc`, `free`; `-O2 -msimd128 -ffp-contract=off`, plus
     `-mrelaxed-simd` for cwasm3; `test/cwasm/config.h`). The harness instantiates them with a stub WASI
     import object and calls `_initialize`.
   - `wasm2`, `wasm2-checked`, `wasm3`, `wasm3-checked`: the minicelt builds (`minicelt_*` exports).

   The same input and ctl schedule (static settings: bitrate, complexity, constrained VBR, DTX, packet
   loss, bandwidth, i16/f32 input, hot f32 x2.5; dynamic runs with random mid-stream changes; mono and
   stereo; 48 kHz speech upsampled x3, synthetic music, transients, noise, chirp, DTX patterns, DC, clipping,
   hard-panned/anti-phase/mono-compatible stereo) goes through each implementation once; the traces
   (packets, final range, in_dtx, ctl return codes) are then compared pairwise. **Exact pairs** (mismatch =
   failure): `cwasm2` = `wasm2` = `wasm2-checked`, `cwasm3` = `wasm3` = `wasm3-checked`. **Informational**:
   scalar and rtcd vs the wasm builds, `cwasm2` vs `cwasm3`. Native scalar is *not* an exact reference for
   WASM 2.0 here (unlike SILK): the fork's float SIMD kernels (`celt_inner_prod`, `dual_inner_prod`,
   `xcorr_kernel`/`celt_pitch_xcorr`, `op_pvq_search`, ...) accumulate in lane order, not in the C order, so
   packets differ occasionally (in about half of the short runs, with identical SNR). The fork's C built with
   its kernels disabled is bit-exact with scalar in every run (checked), so the harness, the libm and the
   signal path are not the cause. `--strict-scalar` makes scalar vs `wasm2`/`wasm2-checked` exact pairs. Any
   trap, native decoder error, bad TOC or encoder/decoder final range mismatch fails every run.
   Every packet is also decoded natively (scalar decoder with the right channel count) and the SNR of
   the decoded streams is reported. `--refs-only` runs the reference self-check without minicelt wasm.

**Relaxed SIMD and FMA**: `f32x4.relaxed_madd` is fused on x86 with FMA (V8
emits `vfmadd`), so the WASM 3.0 build's float kernels round differently from
scalar C. The WASM 3.0 build is therefore compared end to end against the fork's
C (`v1.6.1-wasm-simd`) built for wasm with `-mrelaxed-simd` (run in the same engine). The WASM 2.0
build is compared against the same C built with `-msimd128`; the native scalar build is informational
only, because the fork's float kernels sum in a different order than the C code (see 2.).
