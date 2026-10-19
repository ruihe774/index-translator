//! Link-only crate for the C reference build (the fork's float libopus with WASM SIMD kernels,
//! built by `build.rs` with wasi-sdk), plus the declarations tests need:
//!
//! * the public C functions (`ec_enc_*`, `comb_filter`, `alg_quant`, `quant_all_bands`, ...),
//! * `oracle_<name>` wrappers of the C `static` functions (csrc/*_x.c),
//! * layout tables (`sizeof`/`offsetof` of private C structs),
//! * [`RefEncoder`], a safe wrapper over the reference `OpusEncoder`.
//!
//! Pointers to C structs (`CELTMode*`, `ec_enc*`, `struct band_ctx*`, `CELTEncoder*`, ...) are
//! `*const/*mut c_void`; the tests cast their own `#[repr(C)]` types to them. Arrays are typed.
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals, clippy::missing_safety_doc, clippy::too_many_arguments)]

use std::ffi::{CStr, c_char, c_int, c_uchar, c_uint, c_void};

pub const OPUS_OK: c_int = 0;
pub const OPUS_APPLICATION_RESTRICTED_CELT: c_int = 2053;
pub const OPUS_BANDWIDTH_FULLBAND: c_int = 1105;

#[repr(C)]
pub struct OpusEncoder {
    _p: [u8; 0],
}

/// `{name, value}` entry of a C layout table (terminated by a null name).
#[repr(C)]
pub struct LayoutEntry {
    name: *const c_char,
    value: c_int,
}

/// `oracle_mode_info()` output: a flattened view of a `CELTMode`.
#[repr(C)]
pub struct ModeInfo {
    pub Fs: c_int,
    pub overlap: c_int,
    pub nbEBands: c_int,
    pub effEBands: c_int,
    pub maxLM: c_int,
    pub nbShortMdcts: c_int,
    pub shortMdctSize: c_int,
    pub nbAllocVectors: c_int,
    pub eBands: *const i16,
    pub window: *const f32,
    pub logN: *const i16,
    pub allocVectors: *const u8,
    pub cache_index: *const i16,
    pub cache_bits: *const u8,
    pub cache_caps: *const u8,
    /// `&mode->mdct` (`mdct_lookup *`)
    pub mdct: *const c_void,
    /// `mode->mdct.kfft[0..4]` (`kiss_fft_state *`)
    pub kfft: [*const c_void; 4],
    pub cache_size: c_int,
    pub preemph: [f32; 4],
    pub mdct_n: c_int,
    pub mdct_maxshift: c_int,
    pub mdct_trig: *const f32,
}

unsafe extern "C" {
    static oracle_celt_encoder_layout: LayoutEntry;
    static oracle_bands_layout: LayoutEntry;
    static oracle_opus_encoder_layout: LayoutEntry;
    static oracle_mode_layout: LayoutEntry;
}

fn read_table(first: *const LayoutEntry) -> Vec<(String, usize)> {
    let mut v = Vec::new();
    let mut p = first;
    unsafe {
        while !(*p).name.is_null() {
            v.push((CStr::from_ptr((*p).name).to_str().unwrap().to_owned(), (*p).value as usize));
            p = p.add(1);
        }
    }
    v
}

/// A C layout table: `sizeof(T)` is stored as `"T"`, `offsetof(T, f)` as `"T.f"`
/// (T includes the `struct ` keyword where C needs it, e.g. `"struct OpusCustomEncoder.rng"`).
pub struct Layout(Vec<(String, usize)>);

impl Layout {
    pub fn get(&self, key: &str) -> usize {
        self.0.iter().find(|(k, _)| k == key).unwrap_or_else(|| panic!("no layout entry {key}")).1
    }
    pub fn entries(&self) -> &[(String, usize)] {
        &self.0
    }
}

/// `struct OpusCustomEncoder` (`CELTEncoder`): sizeof and offsetof of every field up to `in_mem`,
/// plus `AnalysisInfo` and `SILKInfo` sizes.
pub fn celt_encoder_layout() -> Layout {
    Layout(read_table(unsafe { &oracle_celt_encoder_layout }))
}
/// `struct band_ctx` and `struct split_ctx` (bands.c).
pub fn bands_layout() -> Layout {
    Layout(read_table(unsafe { &oracle_bands_layout }))
}
/// Private `struct OpusEncoder` (opus_encoder.c).
pub fn opus_encoder_layout() -> Layout {
    Layout(read_table(unsafe { &oracle_opus_encoder_layout }))
}
/// `sizeof` of `CELTMode`, `mdct_lookup`, `kiss_fft_state`, `PulseCache`.
pub fn mode_layout() -> Layout {
    Layout(read_table(unsafe { &oracle_mode_layout }))
}

/// The C 48 kHz / 960 `CELTMode *` (the static mode).
pub fn mode48000() -> *const c_void {
    unsafe { oracle_mode48000() }
}

pub fn mode_info(mode: *const c_void) -> ModeInfo {
    let mut mi = std::mem::MaybeUninit::<ModeInfo>::uninit();
    unsafe {
        oracle_mode_info(mode, mi.as_mut_ptr());
        mi.assume_init()
    }
}

// ---------------------------------------------------------------------------------------------
// Public C functions (not static in C).
// ---------------------------------------------------------------------------------------------
unsafe extern "C" {
    // Opus API
    pub fn opus_encoder_get_size(channels: c_int) -> c_int;
    pub fn opus_encoder_create(fs: i32, channels: c_int, application: c_int, error: *mut c_int) -> *mut OpusEncoder;
    pub fn opus_encoder_destroy(st: *mut OpusEncoder);
    pub fn opus_encode(st: *mut OpusEncoder, pcm: *const i16, frame_size: c_int, data: *mut c_uchar, max_data_bytes: i32) -> i32;
    pub fn opus_encode_float(st: *mut OpusEncoder, pcm: *const f32, frame_size: c_int, data: *mut c_uchar, max_data_bytes: i32) -> i32;

    // celt_encoder.c
    pub fn celt_encoder_get_size(channels: c_int) -> c_int;
    pub fn celt_encode_with_ec(st: *mut c_void, pcm: *const f32, frame_size: c_int, compressed: *mut c_uchar, nb_compressed_bytes: c_int, enc: *mut c_void) -> c_int;

    // entenc.c / entcode.c (`ec_enc *` is `*mut c_void`)
    pub fn ec_enc_init(this: *mut c_void, buf: *mut u8, size: u32);
    pub fn ec_encode(this: *mut c_void, fl: c_uint, fh: c_uint, ft: c_uint);
    pub fn ec_encode_bin(this: *mut c_void, fl: c_uint, fh: c_uint, bits: c_uint);
    pub fn ec_enc_bit_logp(this: *mut c_void, val: c_int, logp: c_uint);
    pub fn ec_enc_icdf(this: *mut c_void, s: c_int, icdf: *const u8, ftb: c_uint);
    pub fn ec_enc_icdf16(this: *mut c_void, s: c_int, icdf: *const u16, ftb: c_uint);
    pub fn ec_enc_uint(this: *mut c_void, fl: u32, ft: u32);
    pub fn ec_enc_bits(this: *mut c_void, fl: u32, ftb: c_uint);
    pub fn ec_enc_patch_initial_bits(this: *mut c_void, val: c_uint, nbits: c_uint);
    pub fn ec_enc_shrink(this: *mut c_void, size: u32);
    pub fn ec_enc_done(this: *mut c_void);
    pub fn ec_tell_frac(this: *mut c_void) -> u32;

    // cwrs.c
    pub fn log2_frac(val: u32, frac: c_int) -> c_int;
    pub fn get_required_bits(bits: *mut i16, n: c_int, k: c_int, frac: c_int);
    pub fn encode_pulses(y: *const c_int, n: c_int, k: c_int, enc: *mut c_void);

    // laplace.c
    pub fn ec_laplace_encode(enc: *mut c_void, value: *mut c_int, fs: c_uint, decay: c_int);

    // bands.c
    pub fn bitexact_cos(x: i16) -> i16;
    pub fn bitexact_log2tan(isin: c_int, icos: c_int) -> c_int;
    pub fn compute_band_energies(m: *const c_void, x: *const f32, band_e: *mut f32, end: c_int, c: c_int, lm: c_int, arch: c_int);
    pub fn normalise_bands(m: *const c_void, freq: *const f32, x: *mut f32, band_e: *const f32, end: c_int, c: c_int, mm: c_int);
    pub fn spreading_decision(m: *const c_void, x: *const f32, average: *mut c_int, last_decision: c_int, hf_average: *mut c_int, tapset_decision: *mut c_int, update_hf: c_int, end: c_int, c: c_int, mm: c_int, spread_weight: *const c_int) -> c_int;
    pub fn haar1(x: *mut f32, n0: c_int, stride: c_int);
    pub fn celt_lcg_rand(seed: u32) -> u32;
    pub fn hysteresis_decision(val: f32, thresholds: *const f32, hysteresis: *const f32, n: c_int, prev: c_int) -> c_int;
    pub fn quant_all_bands(encode: c_int, m: *const c_void, start: c_int, end: c_int, x: *mut f32, y: *mut f32, collapse_masks: *mut u8, band_e: *const f32, pulses: *mut c_int, short_blocks: c_int, spread: c_int, dual_stereo: c_int, intensity: c_int, tf_res: *mut c_int, total_bits: i32, balance: i32, ec: *mut c_void, lm: c_int, coded_bands: c_int, seed: *mut u32, complexity: c_int, arch: c_int, disable_inv: c_int);

    // vq.c
    pub fn exp_rotation(x: *mut f32, len: c_int, dir: c_int, stride: c_int, k: c_int, spread: c_int);
    pub fn op_pvq_search_c(x: *mut f32, iy: *mut c_int, k: c_int, n: c_int, arch: c_int) -> f32;
    pub fn alg_quant(x: *mut f32, n: c_int, k: c_int, spread: c_int, b: c_int, enc: *mut c_void, gain: f32, resynth: c_int, arch: c_int) -> c_uint;
    pub fn renormalise_vector(x: *mut f32, n: c_int, gain: f32, arch: c_int);
    pub fn stereo_itheta(x: *const f32, y: *const f32, stereo: c_int, n: c_int, arch: c_int) -> i32;

    // quant_bands.c
    pub fn amp2Log2(m: *const c_void, eff_end: c_int, end: c_int, band_e: *const f32, band_log_e: *mut f32, c: c_int);
    pub fn log2Amp(m: *const c_void, start: c_int, end: c_int, e_bands: *mut f32, old_e_bands: *const f32, c: c_int);
    pub fn quant_coarse_energy(m: *const c_void, start: c_int, end: c_int, eff_end: c_int, e_bands: *const f32, old_e_bands: *mut f32, budget: u32, error: *mut f32, enc: *mut c_void, c: c_int, lm: c_int, nb_available_bytes: i32, force_intra: c_int, delayed_intra: *mut f32, two_pass: c_int, loss_rate: c_int, lfe: c_int);
    pub fn quant_fine_energy(m: *const c_void, start: c_int, end: c_int, old_e_bands: *mut f32, error: *mut f32, fine_quant: *mut c_int, extra_quant: *mut c_int, enc: *mut c_void, c: c_int);
    pub fn quant_energy_finalise(m: *const c_void, start: c_int, end: c_int, old_e_bands: *mut f32, error: *mut f32, fine_quant: *mut c_int, fine_priority: *mut c_int, bits_left: c_int, enc: *mut c_void, c: c_int);

    // rate.c
    pub fn clt_compute_allocation(m: *const c_void, start: c_int, end: c_int, offsets: *const c_int, cap: *const c_int, alloc_trim: c_int, intensity: *mut c_int, dual_stereo: *mut c_int, total: i32, balance: *mut i32, pulses: *mut c_int, ebits: *mut c_int, fine_priority: *mut c_int, c: c_int, lm: c_int, ec: *mut c_void, encode: c_int, prev: c_int, signal_bandwidth: c_int) -> c_int;

    // celt.c
    pub fn comb_filter(y: *mut f32, x: *mut f32, t0: c_int, t1: c_int, n: c_int, g0: f32, g1: f32, tapset0: c_int, tapset1: c_int, window: *const f32, overlap: c_int, arch: c_int);
    pub fn init_caps(m: *const c_void, cap: *mut c_int, lm: c_int, c: c_int);
    pub static tf_select_table: [[i8; 8]; 4];

    // pitch.c, mathops.c, celt_lpc.c, mdct.c, kiss_fft.c (scalar C and the fork's WASM kernels)
    pub fn pitch_downsample(x: *const *mut f32, x_lp: *mut f32, len: c_int, c: c_int, factor: c_int, arch: c_int);
    pub fn pitch_search(x_lp: *const f32, y: *mut f32, len: c_int, max_pitch: c_int, pitch: *mut c_int, arch: c_int);
    pub fn remove_doubling(x: *mut f32, maxperiod: c_int, minperiod: c_int, n: c_int, t0: *mut c_int, prev_period: c_int, prev_gain: f32, arch: c_int) -> f32;
    pub fn celt_pitch_xcorr_c(x: *const f32, y: *const f32, xcorr: *mut f32, len: c_int, max_pitch: c_int, arch: c_int);
    pub fn celt_pitch_xcorr_wasm(x: *const f32, y: *const f32, xcorr: *mut f32, len: c_int, max_pitch: c_int, arch: c_int);
    pub fn celt_inner_prod_wasm(x: *const f32, y: *const f32, n: c_int) -> f32;
    pub fn dual_inner_prod_wasm(x: *const f32, y01: *const f32, y02: *const f32, n: c_int, xy1: *mut f32, xy2: *mut f32);
    pub fn xcorr_kernel_wasm(x: *const f32, y: *const f32, sum: *mut f32, len: c_int);
    pub fn comb_filter_const_wasm(y: *mut f32, x: *mut f32, t: c_int, n: c_int, g10: f32, g11: f32, g12: f32);
    pub fn op_pvq_search_wasm(x: *mut f32, iy: *mut c_int, k: c_int, n: c_int, arch: c_int) -> f32;
    pub fn celt_float2int16_wasm(input: *const f32, out: *mut i16, cnt: c_int);
    pub fn _celt_lpc(lpc: *mut f32, ac: *const f32, p: c_int);
    pub fn celt_fir_c(x: *const f32, num: *const f32, y: *mut f32, n: c_int, ord: c_int, arch: c_int);
    pub fn celt_iir(x: *const f32, den: *const f32, y: *mut f32, n: c_int, ord: c_int, mem: *mut f32, arch: c_int);
    pub fn _celt_autocorr(x: *const f32, ac: *mut f32, window: *const f32, overlap: c_int, lag: c_int, n: c_int, arch: c_int) -> c_int;
    pub fn clt_mdct_forward_c(l: *const c_void, input: *mut f32, out: *mut f32, window: *const f32, overlap: c_int, shift: c_int, stride: c_int, arch: c_int);
    pub fn clt_mdct_backward_c(l: *const c_void, input: *mut f32, out: *mut f32, window: *const f32, overlap: c_int, shift: c_int, stride: c_int, arch: c_int);
    pub fn opus_fft_c(cfg: *const c_void, fin: *const c_void, fout: *mut c_void);
    pub fn opus_ifft_c(cfg: *const c_void, fin: *const c_void, fout: *mut c_void);
    pub fn isqrt32(val: u32) -> c_uint;
    pub fn celt_sqrt(x: f32) -> f32;
}

// ---------------------------------------------------------------------------------------------
// Wrappers of static C functions and header inlines (csrc/*_x.c). Same argument order as C.
// ---------------------------------------------------------------------------------------------
unsafe extern "C" {
    pub fn oracle_mode48000() -> *const c_void;
    fn oracle_mode_info(mode: *const c_void, out: *mut ModeInfo);

    // celt_encoder_x.c
    pub fn oracle_opus_custom_encoder_init_arch(st: *mut c_void, mode: *const c_void, channels: c_int, arch: c_int) -> c_int;
    pub fn oracle_transient_analysis(input: *const f32, len: c_int, c: c_int, tf_estimate: *mut f32, tf_chan: *mut c_int, allow_weak_transients: c_int, weak_transient: *mut c_int, tone_freq: f32, toneishness: f32) -> c_int;
    pub fn oracle_patch_transient_decision(new_e: *mut f32, old_e: *mut f32, nb_ebands: c_int, start: c_int, end: c_int, c: c_int) -> c_int;
    pub fn oracle_compute_mdcts(mode: *const c_void, short_blocks: c_int, input: *mut f32, out: *mut f32, c: c_int, cc: c_int, lm: c_int, upsample: c_int, arch: c_int);
    pub fn oracle_l1_metric(tmp: *const f32, n: c_int, lm: c_int, bias: f32) -> f32;
    pub fn oracle_tf_analysis(m: *const c_void, len: c_int, is_transient: c_int, tf_res: *mut c_int, lambda: c_int, x: *mut f32, n0: c_int, lm: c_int, tf_estimate: f32, tf_chan: c_int, importance: *mut c_int) -> c_int;
    pub fn oracle_tf_encode(start: c_int, end: c_int, is_transient: c_int, tf_res: *mut c_int, lm: c_int, tf_select: c_int, enc: *mut c_void);
    pub fn oracle_alloc_trim_analysis(m: *const c_void, x: *const f32, band_log_e: *const f32, end: c_int, lm: c_int, c: c_int, n0: c_int, analysis: *mut c_void, stereo_saving: *mut f32, tf_estimate: f32, intensity: c_int, surround_trim: f32, equiv_rate: i32, arch: c_int) -> c_int;
    pub fn oracle_stereo_analysis(m: *const c_void, x: *const f32, lm: c_int, n0: c_int) -> c_int;
    pub fn oracle_median_of_5(x: *const f32) -> f32;
    pub fn oracle_median_of_3(x: *const f32) -> f32;
    pub fn oracle_dynalloc_analysis(band_log_e: *const f32, band_log_e2: *const f32, old_band_e: *const f32, nb_ebands: c_int, start: c_int, end: c_int, c: c_int, offsets: *mut c_int, lsb_depth: c_int, log_n: *const i16, is_transient: c_int, vbr: c_int, constrained_vbr: c_int, e_bands: *const i16, lm: c_int, effective_bytes: c_int, tot_boost: *mut i32, lfe: c_int, surround_dynalloc: *mut f32, analysis: *mut c_void, importance: *mut c_int, spread_weight: *mut c_int, tone_freq: f32, toneishness: f32) -> f32;
    pub fn oracle_tone_lpc(x: *const f32, len: c_int, delay: c_int, lpc: *mut f32) -> c_int;
    pub fn oracle_tone_detect(input: *const f32, cc: c_int, n: c_int, toneishness: *mut f32, fs: i32) -> f32;
    pub fn oracle_run_prefilter(st: *mut c_void, input: *mut f32, prefilter_mem: *mut f32, cc: c_int, n: c_int, prefilter_tapset: c_int, pitch: *mut c_int, gain: *mut f32, qgain: *mut c_int, enabled: c_int, complexity: c_int, tf_estimate: f32, nb_available_bytes: c_int, analysis: *mut c_void, tone_freq: f32, toneishness: f32) -> c_int;
    pub fn oracle_compute_vbr(mode: *const c_void, analysis: *mut c_void, base_target: i32, lm: c_int, bitrate: i32, last_coded_bands: c_int, c: c_int, intensity: c_int, constrained_vbr: c_int, stereo_saving: f32, tot_boost: c_int, tf_estimate: f32, pitch_change: c_int, max_depth: f32, lfe: c_int, has_surround_mask: c_int, surround_masking: f32, temporal_vbr: f32) -> c_int;
    pub fn oracle_celt_encoder_ctl_int(st: *mut c_void, request: c_int, value: c_int) -> c_int;

    // bands_x.c (`ctx` = struct band_ctx *, `sctx` = struct split_ctx *)
    pub fn oracle_compute_channel_weights(ex: f32, ey: f32, w: *mut f32);
    pub fn oracle_intensity_stereo(m: *const c_void, x: *mut f32, y: *const f32, band_e: *const f32, band_id: c_int, n: c_int);
    pub fn oracle_stereo_split(x: *mut f32, y: *mut f32, n: c_int);
    pub fn oracle_stereo_merge(x: *mut f32, y: *mut f32, mid: f32, n: c_int, arch: c_int);
    pub fn oracle_deinterleave_hadamard(x: *mut f32, n0: c_int, stride: c_int, hadamard: c_int);
    pub fn oracle_interleave_hadamard(x: *mut f32, n0: c_int, stride: c_int, hadamard: c_int);
    pub fn oracle_compute_qn(n: c_int, b: c_int, offset: c_int, pulse_cap: c_int, stereo: c_int) -> c_int;
    pub fn oracle_compute_theta(ctx: *mut c_void, sctx: *mut c_void, x: *mut f32, y: *mut f32, n: c_int, b: *mut c_int, bb: c_int, b0: c_int, lm: c_int, stereo: c_int, fill: *mut c_int);
    pub fn oracle_quant_band_n1(ctx: *mut c_void, x: *mut f32, y: *mut f32, lowband_out: *mut f32) -> c_uint;
    pub fn oracle_quant_partition(ctx: *mut c_void, x: *mut f32, n: c_int, b: c_int, bb: c_int, lowband: *mut f32, lm: c_int, gain: f32, fill: c_int) -> c_uint;
    pub fn oracle_quant_band(ctx: *mut c_void, x: *mut f32, n: c_int, b: c_int, bb: c_int, lowband: *mut f32, lm: c_int, lowband_out: *mut f32, gain: f32, lowband_scratch: *mut f32, fill: c_int) -> c_uint;
    pub fn oracle_quant_band_stereo(ctx: *mut c_void, x: *mut f32, y: *mut f32, n: c_int, b: c_int, bb: c_int, lowband: *mut f32, lm: c_int, lowband_out: *mut f32, lowband_scratch: *mut f32, fill: c_int) -> c_uint;
    pub fn oracle_special_hybrid_folding(m: *const c_void, norm: *mut f32, norm2: *mut f32, start: c_int, mm: c_int, dual_stereo: c_int);

    // vq_x.c
    pub fn oracle_exp_rotation1(x: *mut f32, len: c_int, stride: c_int, c: f32, s: f32);
    pub fn oracle_normalise_residual(iy: *mut c_int, x: *mut f32, n: c_int, ryy: f32, gain: f32, shift: c_int);
    pub fn oracle_extract_collapse_mask(iy: *mut c_int, n: c_int, b: c_int) -> c_uint;

    // quant_bands_x.c
    pub fn oracle_loss_distortion(e_bands: *const f32, old_e_bands: *mut f32, start: c_int, end: c_int, len: c_int, c: c_int) -> f32;
    pub fn oracle_quant_coarse_energy_impl(m: *const c_void, start: c_int, end: c_int, e_bands: *const f32, old_e_bands: *mut f32, budget: i32, tell: i32, prob_model: *const u8, error: *mut f32, enc: *mut c_void, c: c_int, lm: c_int, intra: c_int, max_decay: f32, lfe: c_int) -> c_int;
    /// `[[[u8; 42]; 2]; 4]`
    pub fn oracle_e_prob_model() -> *const u8;
    /// `[u8; 3]`
    pub fn oracle_small_energy_icdf() -> *const u8;
    /// `[f32; 4]`
    pub fn oracle_pred_coef() -> *const f32;
    /// `[f32; 4]`
    pub fn oracle_beta_coef() -> *const f32;
    pub fn oracle_beta_intra() -> f32;

    // rate_x.c
    pub fn oracle_interp_bits2pulses(m: *const c_void, start: c_int, end: c_int, skip_start: c_int, bits1: *const c_int, bits2: *const c_int, thresh: *const c_int, cap: *const c_int, total: i32, balance: *mut i32, skip_rsv: c_int, intensity: *mut c_int, intensity_rsv: c_int, dual_stereo: *mut c_int, dual_stereo_rsv: c_int, bits: *mut c_int, ebits: *mut c_int, fine_priority: *mut c_int, c: c_int, lm: c_int, ec: *mut c_void, encode: c_int, prev: c_int, signal_bandwidth: c_int) -> c_int;
    /// `[u8; 24]`
    pub fn oracle_LOG2_FRAC_TABLE() -> *const u8;

    // cwrs_x.c
    pub fn oracle_icwrs(n: c_int, y: *const c_int) -> u32;
    pub fn oracle_cwrsi(n: c_int, k: c_int, i: u32, y: *mut c_int) -> f32;
    /// `[u32; 1272]`
    pub fn oracle_CELT_PVQ_U_DATA() -> *const u32;

    // pitch_x.c
    pub fn oracle_find_best_pitch(xcorr: *mut f32, y: *mut f32, len: c_int, max_pitch: c_int, best_pitch: *mut c_int);
    pub fn oracle_celt_fir5(x: *mut f32, num: *const f32, n: c_int);
    pub fn oracle_compute_pitch_gain(xy: f32, xx: f32, yy: f32) -> f32;
    /// `[i32; 16]`
    pub fn oracle_second_check() -> *const c_int;

    // kiss_fft_x.c (`st` = kiss_fft_state *, `fout` = kiss_fft_cpx *)
    pub fn oracle_kf_bfly2(fout: *mut c_void, m: c_int, n: c_int);
    pub fn oracle_kf_bfly4(fout: *mut c_void, fstride: usize, st: *const c_void, m: c_int, n: c_int, mm: c_int);
    pub fn oracle_kf_bfly3(fout: *mut c_void, fstride: usize, st: *const c_void, m: c_int, n: c_int, mm: c_int);
    pub fn oracle_kf_bfly5(fout: *mut c_void, fstride: usize, st: *const c_void, m: c_int, n: c_int, mm: c_int);

    // inlines_x.c (header inlines/macros; `_c` = scalar C, otherwise the WASM kernel)
    pub fn oracle_fast_atan2f(y: f32, x: f32) -> f32;
    pub fn oracle_celt_maxabs16(x: *const f32, len: c_int) -> f32;
    pub fn oracle_celt_atan_norm(x: f32) -> f32;
    pub fn oracle_celt_atan2p_norm(y: f32, x: f32) -> f32;
    pub fn oracle_celt_cos_norm2(x: f32) -> f32;
    pub fn oracle_celt_log2(x: f32) -> f32;
    pub fn oracle_celt_exp2(x: f32) -> f32;
    pub fn oracle_get_pulses(i: c_int) -> c_int;
    pub fn oracle_bits2pulses(m: *const c_void, band: c_int, lm: c_int, bits: c_int) -> c_int;
    pub fn oracle_pulses2bits(m: *const c_void, band: c_int, lm: c_int, pulses: c_int) -> c_int;
    pub fn oracle_xcorr_kernel(x: *const f32, y: *const f32, sum: *mut f32, len: c_int);
    pub fn oracle_xcorr_kernel_c(x: *const f32, y: *const f32, sum: *mut f32, len: c_int);
    pub fn oracle_celt_inner_prod(x: *const f32, y: *const f32, n: c_int) -> f32;
    pub fn oracle_celt_inner_prod_c(x: *const f32, y: *const f32, n: c_int) -> f32;
    pub fn oracle_dual_inner_prod(x: *const f32, y01: *const f32, y02: *const f32, n: c_int, xy1: *mut f32, xy2: *mut f32);
    pub fn oracle_dual_inner_prod_c(x: *const f32, y01: *const f32, y02: *const f32, n: c_int, xy1: *mut f32, xy2: *mut f32);

    // opus_encoder_x.c
    pub fn oracle_opus_get_celt_encoder(st: *mut OpusEncoder) -> *mut c_void;
    pub fn oracle_gen_toc(mode: c_int, framerate: c_int, bandwidth: c_int, channels: c_int) -> c_uchar;
    pub fn oracle_silk_biquad_res(input: *const f32, b_q28: *const i32, a_q28: *const i32, s: *mut f32, out: *mut f32, len: i32, stride: c_int);
    pub fn oracle_hp_cutoff(input: *const f32, cutoff_hz: i32, out: *mut f32, hp_mem: *mut f32, len: c_int, channels: c_int, fs: i32, arch: c_int);
    pub fn oracle_dc_reject(input: *const f32, cutoff_hz: i32, out: *mut f32, hp_mem: *mut f32, len: c_int, channels: c_int, fs: i32);
    pub fn oracle_stereo_fade(input: *const f32, out: *mut f32, g1: f32, g2: f32, overlap48: c_int, frame_size: c_int, channels: c_int, window: *const f32, fs: i32);
    pub fn oracle_gain_fade(input: *const f32, out: *mut f32, g1: f32, g2: f32, overlap48: c_int, frame_size: c_int, channels: c_int, window: *const f32, fs: i32);
    pub fn oracle_user_bitrate_to_bitrate(st: *mut OpusEncoder, frame_size: c_int, max_data_bytes: c_int) -> i32;
    pub fn oracle_decide_fec(use_inband_fec: c_int, packet_loss_perc: c_int, last_fec: c_int, mode: c_int, bandwidth: *mut c_int, rate: i32) -> c_int;
    pub fn oracle_compute_silk_rate_for_hybrid(rate: c_int, bandwidth: c_int, frame20ms: c_int, vbr: c_int, fec: c_int, channels: c_int) -> c_int;
    pub fn oracle_compute_equiv_rate(bitrate: i32, channels: c_int, frame_rate: c_int, vbr: c_int, mode: c_int, complexity: c_int, loss: c_int) -> i32;
    pub fn oracle_compute_frame_energy(pcm: *const f32, frame_size: c_int, channels: c_int, arch: c_int) -> f32;
    pub fn oracle_decide_dtx_mode(activity: c_int, nb_no_activity_ms_q1: *mut c_int, frame_size_ms_q1: c_int) -> c_int;
    pub fn oracle_compute_redundancy_bytes(max_data_bytes: i32, bitrate_bps: i32, frame_rate: c_int, channels: c_int) -> c_int;
    pub fn oracle_opus_encode_frame_native(st: *mut OpusEncoder, pcm: *const f32, frame_size: c_int, data: *mut u8, max_data_bytes: i32, float_api: c_int, first_frame: c_int, analysis_info: *mut c_void, is_silence: c_int, redundancy: c_int, celt_to_silk: c_int, prefill: c_int, equiv_rate: i32, to_celt: c_int) -> i32;

    // shim.c
    fn oracle_enc_set_bitrate(st: *mut OpusEncoder, v: i32) -> c_int;
    fn oracle_enc_set_complexity(st: *mut OpusEncoder, v: i32) -> c_int;
    fn oracle_enc_set_vbr(st: *mut OpusEncoder, v: i32) -> c_int;
    fn oracle_enc_set_vbr_constraint(st: *mut OpusEncoder, v: i32) -> c_int;
    fn oracle_enc_set_dtx(st: *mut OpusEncoder, v: i32) -> c_int;
    fn oracle_enc_set_lsb_depth(st: *mut OpusEncoder, v: i32) -> c_int;
    fn oracle_enc_set_packet_loss(st: *mut OpusEncoder, v: i32) -> c_int;
    fn oracle_enc_reset(st: *mut OpusEncoder) -> c_int;
    fn oracle_enc_get_final_range(st: *mut OpusEncoder, v: *mut u32) -> c_int;
    fn oracle_enc_get_in_dtx(st: *mut OpusEncoder, v: *mut i32) -> c_int;
    fn oracle_enc_get_lookahead(st: *mut OpusEncoder, v: *mut i32) -> c_int;
    fn oracle_enc_get_bitrate(st: *mut OpusEncoder, v: *mut i32) -> c_int;
}

/// Safe wrapper over the reference `OpusEncoder` created with
/// `OPUS_APPLICATION_RESTRICTED_CELT` at 48 kHz.
pub struct RefEncoder {
    st: *mut OpusEncoder,
    channels: usize,
}

fn check(r: c_int) {
    assert_eq!(r, OPUS_OK, "opus_encoder_ctl failed: {r}");
}

impl RefEncoder {
    pub fn new(channels: usize) -> Self {
        let mut err = 0;
        let st = unsafe { opus_encoder_create(48000, channels as c_int, OPUS_APPLICATION_RESTRICTED_CELT, &mut err) };
        assert!(err == OPUS_OK && !st.is_null(), "opus_encoder_create failed: {err}");
        RefEncoder { st, channels }
    }
    pub fn channels(&self) -> usize {
        self.channels
    }
    /// The `OpusEncoder *`.
    pub fn as_ptr(&self) -> *mut OpusEncoder {
        self.st
    }
    /// The embedded `CELTEncoder *` (`(char*)st + st->celt_enc_offset`).
    pub fn celt_encoder_ptr(&self) -> *mut c_void {
        unsafe { oracle_opus_get_celt_encoder(self.st) }
    }
    /// Bytes of the embedded C `CELTEncoder` (`celt_encoder_get_size(channels)`), for comparing
    /// against the Rust state.
    pub fn celt_state_bytes(&self) -> &[u8] {
        let n = unsafe { celt_encoder_get_size(self.channels as c_int) } as usize;
        unsafe { std::slice::from_raw_parts(self.celt_encoder_ptr() as *const u8, n) }
    }
    pub fn set_bitrate(&mut self, bps: i32) {
        check(unsafe { oracle_enc_set_bitrate(self.st, bps) });
    }
    pub fn set_complexity(&mut self, c: i32) {
        check(unsafe { oracle_enc_set_complexity(self.st, c) });
    }
    pub fn set_vbr(&mut self, on: bool) {
        check(unsafe { oracle_enc_set_vbr(self.st, on as i32) });
    }
    pub fn set_vbr_constraint(&mut self, on: bool) {
        check(unsafe { oracle_enc_set_vbr_constraint(self.st, on as i32) });
    }
    pub fn set_dtx(&mut self, on: bool) {
        check(unsafe { oracle_enc_set_dtx(self.st, on as i32) });
    }
    pub fn set_lsb_depth(&mut self, bits: i32) {
        check(unsafe { oracle_enc_set_lsb_depth(self.st, bits) });
    }
    pub fn set_packet_loss(&mut self, perc: i32) {
        check(unsafe { oracle_enc_set_packet_loss(self.st, perc) });
    }
    pub fn reset(&mut self) {
        check(unsafe { oracle_enc_reset(self.st) });
    }
    pub fn bitrate(&self) -> i32 {
        let mut v = 0;
        check(unsafe { oracle_enc_get_bitrate(self.st, &mut v) });
        v
    }
    pub fn final_range(&self) -> u32 {
        let mut v = 0;
        check(unsafe { oracle_enc_get_final_range(self.st, &mut v) });
        v
    }
    pub fn in_dtx(&self) -> bool {
        let mut v = 0;
        check(unsafe { oracle_enc_get_in_dtx(self.st, &mut v) });
        v != 0
    }
    pub fn lookahead(&self) -> i32 {
        let mut v = 0;
        check(unsafe { oracle_enc_get_lookahead(self.st, &mut v) });
        v
    }
    /// `pcm` holds `frame_size * channels` interleaved samples. Returns the packet length
    /// (negative = error).
    pub fn encode_float(&mut self, pcm: &[f32], frame_size: usize, out: &mut [u8]) -> i32 {
        assert!(pcm.len() >= frame_size * self.channels);
        unsafe { opus_encode_float(self.st, pcm.as_ptr(), frame_size as c_int, out.as_mut_ptr(), out.len() as i32) }
    }
    pub fn encode(&mut self, pcm: &[i16], frame_size: usize, out: &mut [u8]) -> i32 {
        assert!(pcm.len() >= frame_size * self.channels);
        unsafe { opus_encode(self.st, pcm.as_ptr(), frame_size as c_int, out.as_mut_ptr(), out.len() as i32) }
    }
}

impl Drop for RefEncoder {
    fn drop(&mut self) {
        unsafe { opus_encoder_destroy(self.st) }
    }
}
