# minicelt porting guide

minicelt is a mechanical Rust port of the libopus CELT-only float encoder
(`OPUS_APPLICATION_RESTRICTED_CELT`), for wasm32 only. C source: the fork
https://github.com/ruihe774/opus-wasm-simd, branch `v1.6.1-wasm-simd` (upstream
libopus 1.6.1 plus WASM SIMD / relaxed SIMD kernels in `celt/wasm`; its scalar
encoder code is identical to 1.6.1; not vendored here, fetch it to port). Do not
use the fork's `wasm-simd` branch: it is based on post-1.6.1 upstream, whose
scalar code behaves differently. The oracle for testing is natively built
upstream libopus 1.6.1 (`third_party/opus`, scalar C), compared by tolerance
because the kernels sum in lane order and are not bit-exact with scalar C. See
Tests.

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
  `dual_inner_prod_wasm`, `celt_pitch_xcorr_wasm` (with its `xcorr_kernel_wasm` part),
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
  `float2int` (`lrintf`) would be `libm::rintf` (round half to even); the encoder does not
  use it.
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

There are no Rust unit tests. During development every ported function was compared
bit-exactly against the same C function (a wasm32-wasip1 build of the fork's C, linked into
`cargo test` and run under Node's WASI, so C and Rust ran the same SIMD in the same engine); that
per-function oracle, its wrapper TUs and the tests are kept at the git tag
`minicelt-oracle-tests` (`minicelt/scripts/oracle-test.sh [2|3|all]` there). The test suite is
now end to end only:

**End to end** (`minicelt/test/compare.ts`, Deno; `scripts/test.sh celt [--quick] [--all]
[--strict-scalar] [--filter=text] [audio files...]`). Every implementation sits behind one
adapter with the `test/shim.c` API (create, ctl setters, encode i16/f32, final range, in_dtx,
lookahead; decoder for the bitstream check):
- `scalar`, `rtcd`: upstream libopus 1.6.1 natively (`scripts/build-native.sh`, Deno FFI).
- `wasm2`, `wasm2-checked`, `wasm3`, `wasm3-checked`: the minicelt builds (`minicelt_*` exports).

The same input and ctl schedule (static settings: bitrate, complexity, constrained VBR, DTX, packet
loss, bandwidth, i16/f32 input, hot f32 x2.5; dynamic runs with random mid-stream changes; mono and
stereo; 48 kHz speech upsampled x3, synthetic music, transients, noise, chirp, DTX patterns, DC, clipping,
hard-panned/anti-phase/mono-compatible stereo) goes through each implementation once; the traces
(packets, final range, in_dtx, ctl return codes) are then compared pairwise. **Exact pairs** (mismatch =
failure): `wasm2` = `wasm2-checked`, `wasm3` = `wasm3-checked`. **Informational**: scalar and rtcd vs the
wasm builds. Native scalar is *not* an exact reference for the minicelt builds (unlike SILK): the float
SIMD kernels (`celt_inner_prod`, `dual_inner_prod`, `xcorr_kernel`/`celt_pitch_xcorr`, `op_pvq_search`, ...)
accumulate in lane order, not in the C order, so packets differ in a share of the frames (identical SNR).
The fork's C built with its kernels disabled was bit-exact with scalar in every run (checked while the fork
was part of the tests), so the harness, the libm and the signal path are not the cause. `--strict-scalar`
makes scalar vs `wasm2`/`wasm2-checked` exact pairs. Any trap, native decoder error, bad TOC or
encoder/decoder final range mismatch fails every run. Every packet is also decoded natively (scalar
decoder with the right channel count) and the SNR of the decoded streams is reported.

**Tolerance gate against upstream scalar** (the oracle for the minicelt builds). `scalar` vs `wasm2`,
`wasm2-checked`, `wasm3`, `wasm3-checked` is judged by effects, because SIMD summation order and FMA change
packets in a share of the frames (upstream's own SIMD
builds do too: `scripts/variance.ts` measured 0.15-1.3 % of frames on aarch64 NEON and 41-45 % on x86-64 AVX2, whose
`celt_pitch_xcorr` fuses with FMA, with SILK bit-exact on both) without a measurable effect on quality or size.
Checks (`GATE` in `compare.ts`), pooled over all runs and again for mono and stereo: ctl return codes and lookahead
equal; `|mean dSNR|` <= 0.02 dB and `|mean dbytes|` <= 0.01 % (a mean fails only if it is also more than 4 standard
errors from zero: noise is symmetric, a defect is not); every run within 1 dB and 2 % of the size (4 bytes floor);
`in_dtx` differing in <= 0.5 % of the frames; per CELT band (21 bands, Hann-windowed 20 ms frames of the decoded
streams) the mean log-spectral distance B-A within 0.02 dB (same significance rule) and the mean absolute distance
within 0.1 dB, over all decoded frames. The band check is there because SNR is dominated by the loud low bands and
cannot see a defect in the top ones. Packet divergence rate is reported, not gated: it is uninformative on x86. The
same checks run for `scalar` vs `rtcd` (upstream's own SIMD) as the baseline of the bounds: if it fails on a host,
the bounds are too tight for it. In `--quick` the band checks are informational (too few frames: the baseline fails
them there). Sensitivity: a 2.4 % change of the encoder's pre-emphasis fails nearly every check; a 10 % change of the
constrained-VBR modulation factor (0.67 to 0.60) fails only the mean band distance, and smaller decision tweaks are
not detectable.

**Relaxed SIMD and FMA**: `f32x4.relaxed_madd` is fused on x86 with FMA (V8
emits `vfmadd`), so the WASM 3.0 build's float kernels round differently from
scalar C, and the float kernels of both builds sum in a different order than the C
code. Both are therefore judged against native scalar by the tolerance gate above, not
bit-exactly. The WASM 3.0 build is the one most likely to approach the gate's bounds
(its FMA behaviour is that of upstream's x86 AVX2 build, which diverges most).
