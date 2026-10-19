//! Port of celt/celt_encoder.c (48 kHz, 20 ms frames, mono/stereo, VBR / constrained VBR).

use super::celt::{AnalysisInfo, COMBFILTER_MAXPERIOD, SILKInfo};
use super::modes::{CELTMode, mode48000_960_120};

/// Maximum channel count; the trailing arrays are sized for it.
pub const MAX_CHANNELS: usize = 2;
/// mode48000_960_120.overlap
pub const OVERLAP: usize = 120;
/// mode48000_960_120.nbEBands
pub const NB_EBANDS: usize = 21;

/// OpusCustomEncoder / CELTEncoder. The C struct ends in variable-size arrays laid out after
/// `in_mem` (each `channels` times its per-channel size); here they are fixed-size fields
/// sized for `MAX_CHANNELS` and indexed with the same per-channel strides as in C.
#[repr(C)]
pub struct CELTEncoder {
    /// Mode used by the encoder
    pub mode: &'static CELTMode,
    pub channels: i32,
    pub stream_channels: i32,

    pub force_intra: i32,
    pub clip: i32,
    pub disable_pf: i32,
    pub complexity: i32,
    pub upsample: i32,
    pub start: i32,
    pub end: i32,

    pub bitrate: i32,
    pub vbr: i32,
    pub signalling: i32,
    /// If zero, VBR can do whatever it likes with the rate
    pub constrained_vbr: i32,
    pub loss_rate: i32,
    pub lsb_depth: i32,
    pub lfe: i32,
    pub disable_inv: i32,
    pub arch: i32,

    /* Everything beyond this point gets cleared on a reset */
    pub rng: u32,
    pub spread_decision: i32,
    pub delayedIntra: f32,
    pub tonal_average: i32,
    pub lastCodedBands: i32,
    pub hf_average: i32,
    pub tapset_decision: i32,

    pub prefilter_period: i32,
    pub prefilter_gain: f32,
    pub prefilter_tapset: i32,
    pub consec_transient: i32,
    pub analysis: AnalysisInfo,
    pub silk_info: SILKInfo,

    pub preemph_memE: [f32; 2],
    pub preemph_memD: [f32; 2],

    /* VBR-related parameters */
    pub vbr_reservoir: i32,
    pub vbr_drift: i32,
    pub vbr_offset: i32,
    pub vbr_count: i32,
    pub overlap_max: f32,
    pub stereo_saving: f32,
    pub intensity: i32,
    /// Always null (OPUS_SET_ENERGY_MASK is only used by the multistream encoder).
    pub energy_mask: *const f32,
    pub spec_avg: f32,

    /// Size = channels*mode->overlap
    pub in_mem: [f32; MAX_CHANNELS * OVERLAP],
    /// Size = channels*COMBFILTER_MAXPERIOD
    pub prefilter_mem: [f32; MAX_CHANNELS * COMBFILTER_MAXPERIOD as usize],
    /// Size = channels*mode->nbEBands
    pub oldBandE: [f32; MAX_CHANNELS * NB_EBANDS],
    /// Size = channels*mode->nbEBands
    pub oldLogE: [f32; MAX_CHANNELS * NB_EBANDS],
    /// Size = channels*mode->nbEBands
    pub oldLogE2: [f32; MAX_CHANNELS * NB_EBANDS],
    /// Size = channels*mode->nbEBands
    pub energyError: [f32; MAX_CHANNELS * NB_EBANDS],
}

impl CELTEncoder {
    /// All-zero state (as after the C memset), with the static mode.
    pub const fn new_zeroed() -> Self {
        CELTEncoder {
            mode: &mode48000_960_120,
            channels: 0,
            stream_channels: 0,
            force_intra: 0,
            clip: 0,
            disable_pf: 0,
            complexity: 0,
            upsample: 0,
            start: 0,
            end: 0,
            bitrate: 0,
            vbr: 0,
            signalling: 0,
            constrained_vbr: 0,
            loss_rate: 0,
            lsb_depth: 0,
            lfe: 0,
            disable_inv: 0,
            arch: 0,
            rng: 0,
            spread_decision: 0,
            delayedIntra: 0.0,
            tonal_average: 0,
            lastCodedBands: 0,
            hf_average: 0,
            tapset_decision: 0,
            prefilter_period: 0,
            prefilter_gain: 0.0,
            prefilter_tapset: 0,
            consec_transient: 0,
            analysis: AnalysisInfo::new_zeroed(),
            silk_info: SILKInfo { signalType: 0, offset: 0 },
            preemph_memE: [0.0; 2],
            preemph_memD: [0.0; 2],
            vbr_reservoir: 0,
            vbr_drift: 0,
            vbr_offset: 0,
            vbr_count: 0,
            overlap_max: 0.0,
            stereo_saving: 0.0,
            intensity: 0,
            energy_mask: core::ptr::null(),
            spec_avg: 0.0,
            in_mem: [0.0; MAX_CHANNELS * OVERLAP],
            prefilter_mem: [0.0; MAX_CHANNELS * COMBFILTER_MAXPERIOD as usize],
            oldBandE: [0.0; MAX_CHANNELS * NB_EBANDS],
            oldLogE: [0.0; MAX_CHANNELS * NB_EBANDS],
            oldLogE2: [0.0; MAX_CHANNELS * NB_EBANDS],
            energyError: [0.0; MAX_CHANNELS * NB_EBANDS],
        }
    }
}


// ---- analysis helpers (celt_encoder.c) ----
//
// Static helpers of celt_encoder.c, made `pub`. Conventions shared by all of them:
// - `upsample` is always 1 (debug_assert in the callers), `arch` is dropped.
// - `AnalysisInfo::valid` is always 0, so the `analysis` parameters and the code under
//   `analysis->valid` are removed (alloc_trim_analysis, dynalloc_analysis, run_prefilter,
//   compute_vbr).
// - LFE is always 0, `energy_mask` (surround) is always null: `surround_trim`,
//   `surround_dynalloc`, `surround_masking`, `has_surround_mask` and `lfe` are removed.
// - `normalize_tone_input` and `acos_approx` exist only under `FIXED_POINT` in C; the float
//   `tone_detect` calls `acos()` directly, so they are not ported.
// - M_PI is `mathops::PI` (the exact double constant).

use super::arch::{ABS16, ABS32, CELT_SIG_SCALE, EPSILON, IMAX, IMIN, MAX16, MAX32, MIN16, MIN32};
use super::bands::haar1;
use super::celt::{COMBFILTER_MINPERIOD, comb_filter, tf_select_table};
use super::entcode::{BITRES, ec_enc, ec_tell};
use super::entenc::ec_enc_bit_logp;
use super::mathops::{PI, celt_exp2_db, celt_log2};
use super::mdct::clt_mdct_forward;
use super::pitch::{celt_inner_prod, pitch_downsample, pitch_search, remove_doubling};
use super::quant_bands::eMeans;
use crate::stack;

/// Table of 6*64/x, trained on real data to minimize the average error
static inv_table: [u8; 128] = [
    255, 255, 156, 110, 86, 70, 59, 51, 45, 40, 37, 33, 31, 28, 26, 25, //
    23, 22, 21, 20, 19, 18, 17, 16, 16, 15, 15, 14, 13, 13, 12, 12, //
    12, 12, 11, 11, 11, 10, 10, 10, 9, 9, 9, 9, 9, 9, 8, 8, //
    8, 8, 8, 7, 7, 7, 7, 7, 7, 6, 6, 6, 6, 6, 6, 6, //
    6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5, 5, //
    5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, //
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, //
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, //
];

/// `in_` holds `C` channels of `len` samples each (`in_[c*len + i]`, i.e. the `in` buffer of
/// celt_encode_with_ec with `len = N+overlap`). `*tf_chan` is only written when a channel's
/// metric exceeds 0 (the caller initializes it); `*tf_estimate` and `*weak_transient` are
/// always written. Returns `is_transient`.
pub fn transient_analysis(
    in_: &[f32],
    len: i32,
    C: i32,
    tf_estimate: &mut f32,
    tf_chan: &mut i32,
    allow_weak_transients: i32,
    weak_transient: &mut i32,
    tone_freq: f32,
    toneishness: f32,
) -> i32 {
    let mut mask_metric: i32 = 0;
    /* Forward masking: 6.7 dB/ms. */
    let mut forward_decay: f32 = 0.0625;
    let sg = stack::save();
    let tmp = sg.alloc::<f32>(len as usize);

    *weak_transient = 0;
    /* For lower bitrates, let's be more conservative and have a forward masking
    decay of 3.3 dB/ms. This avoids having to code transients at very low
    bitrate (mostly for hybrid), which can result in unstable energy and/or
    partial collapse. */
    if allow_weak_transients != 0 {
        forward_decay = 0.03125;
    }
    let len2 = len / 2;
    for c in 0..C {
        let mut unmask: i32;
        let mut mem0: f32 = 0.0;
        let mut mem1: f32 = 0.0;
        /* High-pass filter: (1 - 2*z^-1 + z^-2) / (1 - z^-1 + .5*z^-2) */
        for i in 0..len as usize {
            let x = in_[i + (c * len) as usize];
            let y = mem0 + x;
            /* Original code:
            mem0 = mem1 + y - 2*x;
            mem1 = x - .5f*y;
            Modified code to shorten dependency chains: */
            let mem00 = mem0;
            mem0 = mem0 - x + 0.5 * mem1;
            mem1 = x - mem00;
            tmp[i] = y;
        }
        /* First few samples are bad because we don't propagate the memory */
        tmp[..12].fill(0.0);

        let mut mean: f32 = 0.0;
        mem0 = 0.0;
        /* Grouping by two to reduce complexity */
        /* Forward pass to compute the post-echo threshold*/
        for i in 0..len2 as usize {
            let x2 = tmp[2 * i] * tmp[2 * i] + tmp[2 * i + 1] * tmp[2 * i + 1];
            mean += x2;
            mem0 = x2 + (1.0 - forward_decay) * mem0;
            tmp[i] = forward_decay * mem0;
        }

        mem0 = 0.0;
        let mut maxE: f32 = 0.0;
        /* Backward pass to compute the pre-echo threshold */
        for i in (0..len2 as usize).rev() {
            /* Backward masking: 13.9 dB/ms. */
            mem0 = tmp[i] + 0.875 * mem0;
            tmp[i] = 0.125 * mem0;
            maxE = MAX16(maxE, 0.125 * mem0);
        }

        /* Compute the ratio of the "frame energy" over the harmonic mean of the energy.
        This essentially corresponds to a bitrate-normalized temporal noise-to-mask
        ratio */

        /* As a compromise with the old transient detector, frame energy is the
        geometric mean of the energy and half the max */
        /* `mean * maxE*.5*len2`: float product, then double (.5 is a double literal) */
        mean = libm::sqrt((mean * maxE) as f64 * 0.5 * len2 as f64) as f32;
        /* Inverse of the mean energy in Q15+6 */
        let norm: f32 = len2 as f32 / (EPSILON + mean);
        /* Compute harmonic mean discarding the unreliable boundaries
        The data is smooth, so we only take 1/4th of the samples */
        unmask = 0;
        /* We should never see NaNs here. If we find any, then something really bad happened and we better abort
        before it does any damage later on. If these asserts are disabled (no hardening), then the table
        lookup a few lines below (id = ...) is likely to crash dur to an out-of-bounds read. DO NOT FIX
        that crash on NaN since it could result in a worse issue later on. */
        debug_assert!(!tmp[0].is_nan());
        debug_assert!(!norm.is_nan());
        let mut i = 12;
        while i < len2 - 5 {
            /* Do not round to nearest. floor() is a double operation, so MIN32/MAX32 compare doubles. */
            let v: f64 = libm::floor((64.0 * norm * (tmp[i as usize] + EPSILON)) as f64);
            let v = if 127.0 < v { 127.0 } else { v };
            let v = if 0.0 > v { 0.0 } else { v };
            let id = v as i32;
            unmask += inv_table[id as usize] as i32;
            i += 4;
        }
        /* Normalize, compensate for the 1/4th of the sample and the factor of 6 in the inverse table */
        unmask = 64 * unmask * 4 / (6 * (len2 - 17));
        if unmask > mask_metric {
            *tf_chan = c;
            mask_metric = unmask;
        }
    }
    let mut is_transient = (mask_metric > 200) as i32;
    /* Prevent the transient detector from confusing the partial cycle of a
    very low frequency tone with a transient. */
    if toneishness > 0.98 && tone_freq < 0.026 {
        is_transient = 0;
        mask_metric = 0;
    }
    /* For low bitrates, define "weak transients" that need to be
    handled differently to avoid partial collapse. */
    if allow_weak_transients != 0 && is_transient != 0 && mask_metric < 600 {
        is_transient = 0;
        *weak_transient = 1;
    }
    /* Arbitrary metric for VBR boost */
    let tf_max: f32 = MAX16(0.0, libm::sqrt((27 * mask_metric) as f64) as f32 - 42.0);
    /* *tf_estimate = 1 + MIN16(1, sqrt(MAX16(0, tf_max-30))/20); */
    /* QCONST32(0.139,28) is a double literal, so the subtraction and MAX32 are in double. */
    let d: f64 = (0.0069f32 * MIN16(163.0, tf_max)) as f64 - 0.139;
    let d = if 0.0 > d { 0.0 } else { d };
    *tf_estimate = libm::sqrt(d) as f32;
    is_transient
}

/// Looks for sudden increases of energy to decide whether we need to patch
/// the transient decision. `newE`/`oldE` are the band log energies (`C` channels of `nbEBands`).
pub fn patch_transient_decision(newE: &[f32], oldE: &[f32], nbEBands: i32, start: i32, end: i32, C: i32) -> i32 {
    let mut mean_diff: f32 = 0.0;
    let mut spread_old = [0.0f32; 26];
    let nb = nbEBands as usize;
    let (start, end) = (start as usize, end as usize);
    /* Apply an aggressive (-6 dB/Bark) spreading function to the old frame to
    avoid false detection caused by irrelevant bands */
    if C == 1 {
        spread_old[start] = oldE[start];
        for i in start + 1..end {
            spread_old[i] = MAX32(spread_old[i - 1] - 1.0, oldE[i]);
        }
    } else {
        spread_old[start] = MAX32(oldE[start], oldE[start + nb]);
        for i in start + 1..end {
            spread_old[i] = MAX32(spread_old[i - 1] - 1.0, MAX32(oldE[i], oldE[i + nb]));
        }
    }
    for i in (start..end - 1).rev() {
        spread_old[i] = MAX32(spread_old[i], spread_old[i + 1] - 1.0);
    }
    /* Compute mean increase */
    for c in 0..C as usize {
        for i in IMAX(2, start as i32) as usize..end - 1 {
            let x1 = MAX32(0.0, newE[i + c * nb]);
            let x2 = MAX32(0.0, spread_old[i]);
            mean_diff = mean_diff + MAX32(0.0, x1 - x2);
        }
    }
    mean_diff = mean_diff / (C * (end as i32 - 1 - IMAX(2, start as i32))) as f32;
    (mean_diff > 1.0) as i32
}

/// Apply window and compute the MDCT for all sub-frames and all channels in a frame.
/// `in_` is the whole `in` buffer (`CC*(B*N+overlap)` samples, channel `c` at `c*(B*N+overlap)`),
/// `out` the `C*B*N` coefficients. (`upsample` is always 1.)
pub fn compute_mdcts(mode: &CELTMode, shortBlocks: i32, in_: &[f32], out: &mut [f32], C: i32, CC: i32, LM: i32) {
    let overlap = mode.overlap;
    let N: i32;
    let B: i32;
    let shift: i32;
    if shortBlocks != 0 {
        B = shortBlocks;
        N = mode.shortMdctSize;
        shift = mode.maxLM;
    } else {
        B = 1;
        N = mode.shortMdctSize << LM;
        shift = mode.maxLM - LM;
    }
    for c in 0..CC {
        for b in 0..B {
            /* Interleaving the sub-frames while doing the MDCTs */
            clt_mdct_forward(
                &mode.mdct,
                in_,
                (c * (B * N + overlap) + b * N) as usize,
                out,
                (b + c * N * B) as usize,
                mode.window,
                overlap,
                shift,
                B,
            );
        }
    }
    if CC == 2 && C == 1 {
        for i in 0..(B * N) as usize {
            out[i] = 0.5 * out[i] + 0.5 * out[(B * N) as usize + i];
        }
    }
}

/// `pcmp[CC*i]` for i in 0..N are the input samples (`pcm+c` of the caller, i.e. a slice
/// starting at channel `c`); `inp[0..N]` receives the pre-emphasized signal
/// (`in+c*(N+overlap)+overlap` of the caller); `*mem` is `preemph_memE[c]`. `coef` is
/// `mode.preemph` (`coef[1] == 0`; `upsample` is always 1).
pub fn celt_preemphasis(pcmp: &[f32], inp: &mut [f32], N: i32, CC: i32, coef: &[f32], mem: &mut f32, clip: i32) {
    debug_assert!(coef[1] == 0.0);
    let coef0 = coef[0];
    let mut m = *mem;
    let (N, CC) = (N as usize, CC as usize);

    /* Fast path for the normal 48kHz case and no clipping */
    if clip == 0 {
        for i in 0..N {
            let x = CELT_SIG_SCALE * pcmp[CC * i];
            /* Apply pre-emphasis */
            inp[i] = x - m;
            m = coef0 * x;
        }
        *mem = m;
        return;
    }

    for i in 0..N {
        inp[i] = CELT_SIG_SCALE * pcmp[CC * i];
    }
    /* Clip input to avoid encoding non-portable files */
    for i in 0..N {
        inp[i] = MAX32(-65536.0, MIN32(65536.0, inp[i]));
    }
    for i in 0..N {
        let x = inp[i];
        /* Apply pre-emphasis */
        inp[i] = x - m;
        m = coef0 * x;
    }
    *mem = m;
}

pub fn l1_metric(tmp: &[f32], N: i32, LM: i32, bias: f32) -> f32 {
    let mut L1: f32 = 0.0;
    for i in 0..N as usize {
        L1 += ABS16(tmp[i]);
    }
    /* When in doubt, prefer good freq resolution */
    L1 = L1 + (LM as f32 * bias) * L1;
    L1
}

/// `X` holds the channels of normalized spectrum (`N0` coefficients each); `tf_res[0..len]` and
/// `importance[0..len]` are indexed by band. Returns `tf_select`.
pub fn tf_analysis(
    m: &CELTMode,
    len: i32,
    isTransient: i32,
    tf_res: &mut [i32],
    lambda: i32,
    X: &[f32],
    N0: i32,
    LM: i32,
    tf_estimate: f32,
    tf_chan: i32,
    importance: &[i32],
) -> i32 {
    let mut tf_select: i32;
    let mut selcost = [0i32; 2];
    let sg = stack::save();
    let bias: f32 = 0.04 * MAX16(-0.25, 0.5 - tf_estimate);

    let lenu = len as usize;
    let eb = m.eBands;
    let nlast = ((eb[lenu] as i32 - eb[lenu - 1] as i32) << LM) as usize;
    let metric = sg.alloc::<i32>(lenu);
    let tmp = sg.alloc::<f32>(nlast);
    let tmp_1 = sg.alloc::<f32>(nlast);
    let path0 = sg.alloc::<i32>(lenu);
    let path1 = sg.alloc::<i32>(lenu);

    for i in 0..lenu {
        let mut best_level: i32 = 0;
        let N = (eb[i + 1] as i32 - eb[i] as i32) << LM;
        /* band is too narrow to be split down to LM=-1 */
        let narrow = (eb[i + 1] as i32 - eb[i] as i32) == 1;
        let off = (tf_chan * N0 + ((eb[i] as i32) << LM)) as usize;
        tmp[..N as usize].copy_from_slice(&X[off..off + N as usize]);
        /* Just add the right channel if we're in stereo */
        let mut L1 = l1_metric(tmp, N, if isTransient != 0 { LM } else { 0 }, bias);
        let mut best_L1 = L1;
        /* Check the -1 case for transients */
        if isTransient != 0 && !narrow {
            tmp_1[..N as usize].copy_from_slice(&tmp[..N as usize]);
            haar1(tmp_1, N >> LM, 1 << LM);
            L1 = l1_metric(tmp_1, N, LM + 1, bias);
            if L1 < best_L1 {
                best_L1 = L1;
                best_level = -1;
            }
        }
        for k in 0..LM + !(isTransient != 0 || narrow) as i32 {
            let B: i32;

            if isTransient != 0 {
                B = LM - k - 1;
            } else {
                B = k + 1;
            }

            haar1(tmp, N >> k, 1 << k);

            L1 = l1_metric(tmp, N, B, bias);

            if L1 < best_L1 {
                best_L1 = L1;
                best_level = k + 1;
            }
        }
        /* metric is in Q1 to be able to select the mid-point (-0.5) for narrower bands */
        if isTransient != 0 {
            metric[i] = 2 * best_level;
        } else {
            metric[i] = -2 * best_level;
        }
        /* For bands that can't be split to -1, set the metric to the half-way point to avoid
        biasing the decision */
        if narrow && (metric[i] == 0 || metric[i] == -2 * LM) {
            metric[i] -= 1;
        }
    }
    /* 2*tf_select_table[LM][4*isTransient+k] */
    let tfs = |k: i32| -> i32 { 2 * tf_select_table[LM as usize][(4 * isTransient + k) as usize] as i32 };
    /* Search for the optimal tf resolution, including tf_select */
    tf_select = 0;
    for sel in 0..2 {
        let mut cost0 = importance[0] * (metric[0] - tfs(2 * sel + 0)).abs();
        let mut cost1 =
            importance[0] * (metric[0] - tfs(2 * sel + 1)).abs() + if isTransient != 0 { 0 } else { lambda };
        for i in 1..lenu {
            let curr0 = IMIN(cost0, cost1 + lambda);
            let curr1 = IMIN(cost0 + lambda, cost1);
            cost0 = curr0 + importance[i] * (metric[i] - tfs(2 * sel + 0)).abs();
            cost1 = curr1 + importance[i] * (metric[i] - tfs(2 * sel + 1)).abs();
        }
        cost0 = IMIN(cost0, cost1);
        selcost[sel as usize] = cost0;
    }
    /* For now, we're conservative and only allow tf_select=1 for transients.
     * If tests confirm it's useful for non-transients, we could allow it. */
    if selcost[1] < selcost[0] && isTransient != 0 {
        tf_select = 1;
    }
    let mut cost0 = importance[0] * (metric[0] - tfs(2 * tf_select + 0)).abs();
    let mut cost1 =
        importance[0] * (metric[0] - tfs(2 * tf_select + 1)).abs() + if isTransient != 0 { 0 } else { lambda };
    /* Viterbi forward pass */
    for i in 1..lenu {
        let curr0: i32;
        let curr1: i32;

        let from0 = cost0;
        let from1 = cost1 + lambda;
        if from0 < from1 {
            curr0 = from0;
            path0[i] = 0;
        } else {
            curr0 = from1;
            path0[i] = 1;
        }

        let from0 = cost0 + lambda;
        let from1 = cost1;
        if from0 < from1 {
            curr1 = from0;
            path1[i] = 0;
        } else {
            curr1 = from1;
            path1[i] = 1;
        }
        cost0 = curr0 + importance[i] * (metric[i] - tfs(2 * tf_select + 0)).abs();
        cost1 = curr1 + importance[i] * (metric[i] - tfs(2 * tf_select + 1)).abs();
    }
    tf_res[lenu - 1] = if cost0 < cost1 { 0 } else { 1 };
    /* Viterbi backward pass to check the decisions */
    for i in (0..lenu - 1).rev() {
        if tf_res[i + 1] == 1 {
            tf_res[i] = path1[i + 1];
        } else {
            tf_res[i] = path0[i + 1];
        }
    }
    tf_select
}

/// Codes the tf_res flags of bands `start..end` and `tf_select`, then converts `tf_res[start..end]`
/// to the final per-band tf change via `tf_select_table`.
pub fn tf_encode(start: i32, end: i32, isTransient: i32, tf_res: &mut [i32], LM: i32, mut tf_select: i32, enc: &mut ec_enc) {
    let mut budget: u32 = enc.storage * 8;
    let mut tell: u32 = ec_tell(enc) as u32;
    let mut logp: i32 = if isTransient != 0 { 2 } else { 4 };
    /* Reserve space to code the tf_select decision. */
    let tf_select_rsv: u32 = (LM > 0 && tell + logp as u32 + 1 <= budget) as u32;
    budget -= tf_select_rsv;
    let mut curr: i32 = 0;
    let mut tf_changed: i32 = 0;
    for i in start as usize..end as usize {
        if tell + logp as u32 <= budget {
            ec_enc_bit_logp(enc, tf_res[i] ^ curr, logp as u32);
            tell = ec_tell(enc) as u32;
            curr = tf_res[i];
            tf_changed |= curr;
        } else {
            tf_res[i] = curr;
        }
        logp = if isTransient != 0 { 4 } else { 5 };
    }
    /* Only code tf_select if it would actually make a difference. */
    let t = &tf_select_table[LM as usize];
    if tf_select_rsv != 0
        && t[(4 * isTransient + 0 + tf_changed) as usize] != t[(4 * isTransient + 2 + tf_changed) as usize]
    {
        ec_enc_bit_logp(enc, tf_select, 1);
    } else {
        tf_select = 0;
    }
    for i in start as usize..end as usize {
        tf_res[i] = t[(4 * isTransient + 2 * tf_select + tf_res[i]) as usize] as i32;
    }
}

/// `X` holds the two channels of normalized spectrum (`N0` coefficients each) when `C == 2`.
/// `bandLogE` is `C*nbEBands`. `analysis` and `surround_trim` are dropped (see section header).
pub fn alloc_trim_analysis(
    m: &CELTMode,
    X: &[f32],
    bandLogE: &[f32],
    end: i32,
    LM: i32,
    C: i32,
    N0: i32,
    stereo_saving: &mut f32,
    tf_estimate: f32,
    intensity: i32,
    equiv_rate: i32,
) -> i32 {
    let mut diff: f32 = 0.0;
    let mut trim: f32 = 5.0;
    let eb = m.eBands;
    /* At low bitrate, reducing the trim seems to help. At higher bitrates, it's less
    clear what's best, so we're keeping it as it was before, at least for now. */
    if equiv_rate < 64000 {
        trim = 4.0;
    } else if equiv_rate < 80000 {
        let frac: i32 = (equiv_rate - 64000) >> 10;
        trim = 4.0 + (1.0f32 / 16.0) * frac as f32;
    }
    if C == 2 {
        let mut sum: f32 = 0.0; /* Q10 */
        let mut minXC: f32; /* Q10 */
        let n0 = N0 as usize;
        /* Compute inter-channel correlation for low frequencies */
        for i in 0..8usize {
            let a = (eb[i] as usize) << LM;
            let n = (eb[i + 1] as i32 - eb[i] as i32) << LM;
            let partial = celt_inner_prod(&X[a..], &X[n0 + a..], n);
            sum = sum + partial;
        }
        sum = (1.0f32 / 8.0) * sum;
        sum = MIN16(1.0, ABS16(sum));
        minXC = sum;
        for i in 8..intensity as usize {
            let a = (eb[i] as usize) << LM;
            let n = (eb[i + 1] as i32 - eb[i] as i32) << LM;
            let partial = celt_inner_prod(&X[a..], &X[n0 + a..], n);
            minXC = MIN16(minXC, ABS16(partial));
        }
        minXC = MIN16(1.0, ABS16(minXC));
        /* mid-side savings estimations based on the LF average*/
        let logXC = celt_log2(1.001 - sum * sum);
        /* mid-side savings estimations based on min correlation */
        let logXC2 = MAX16(0.5 * logXC, celt_log2(1.001 - minXC * minXC));

        trim += MAX16(-4.0, 0.75 * logXC);
        *stereo_saving = MIN16(*stereo_saving + 0.25, -(0.5 * logXC2));
    }

    /* Estimate spectral tilt */
    for c in 0..C {
        for i in 0..end - 1 {
            diff += bandLogE[(i + c * m.nbEBands) as usize] * (2 + 2 * i - end) as f32;
        }
    }
    diff /= (C * (end - 1)) as f32;
    trim -= MAX32(-2.0, MIN32(2.0, (diff + 1.0) / 6.0));
    trim -= 2.0 * tf_estimate;
    /* (analysis->valid is always 0; surround_trim is always 0) */

    let trim_index = libm::floor((0.5f32 + trim) as f64) as i32;
    IMAX(0, IMIN(10, trim_index))
}

/// Returns `dual_stereo` (0/1). `X` holds the two channels of normalized spectrum (`N0` each).
pub fn stereo_analysis(m: &CELTMode, X: &[f32], LM: i32, N0: i32) -> i32 {
    let mut sumLR: f32 = EPSILON;
    let mut sumMS: f32 = EPSILON;
    let eb = m.eBands;

    /* Use the L1 norm to model the entropy of the L/R signal vs the M/S signal */
    for i in 0..13usize {
        for j in (eb[i] as usize) << LM..(eb[i + 1] as usize) << LM {
            /* We cast to 32-bit first because of the -32768 case */
            let L = X[j];
            let R = X[N0 as usize + j];
            let M = L + R;
            let S = L - R;
            sumLR = sumLR + (ABS32(L) + ABS32(R));
            sumMS = sumMS + (ABS32(M) + ABS32(S));
        }
    }
    sumMS = 0.707107 * sumMS;
    let mut thetas: i32 = 13;
    /* We don't need thetas for lower bands with LM<=1 */
    if LM <= 1 {
        thetas -= 8;
    }
    (((((eb[13] as i32) << (LM + 1)) + thetas) as f32 * sumMS) > (((eb[13] as i32) << (LM + 1)) as f32 * sumLR)) as i32
}

/// Median of `x[0..5]`.
pub fn median_of_5(x: &[f32]) -> f32 {
    let (mut t0, mut t1, t2, mut t3, mut t4): (f32, f32, f32, f32, f32);
    t2 = x[2];
    if x[0] > x[1] {
        t0 = x[1];
        t1 = x[0];
    } else {
        t0 = x[0];
        t1 = x[1];
    }
    if x[3] > x[4] {
        t3 = x[4];
        t4 = x[3];
    } else {
        t3 = x[3];
        t4 = x[4];
    }
    if t0 > t3 {
        core::mem::swap(&mut t0, &mut t3);
        core::mem::swap(&mut t1, &mut t4);
    }
    if t2 > t1 {
        if t1 < t3 {
            MIN32(t2, t3)
        } else {
            MIN32(t4, t1)
        }
    } else {
        if t2 < t3 {
            MIN32(t1, t3)
        } else {
            MIN32(t2, t4)
        }
    }
}

/// Median of `x[0..3]`.
pub fn median_of_3(x: &[f32]) -> f32 {
    let (t0, t1): (f32, f32);
    if x[0] > x[1] {
        t0 = x[1];
        t1 = x[0];
    } else {
        t0 = x[0];
        t1 = x[1];
    }
    let t2 = x[2];
    if t1 < t2 {
        t1
    } else if t0 < t2 {
        t2
    } else {
        t0
    }
}

/// Dynamic allocation analysis. `bandLogE`/`bandLogE2` are `C*nbEBands`; `offsets`, `importance`,
/// `spread_weight` are indexed by band (`offsets` is cleared for `nbEBands`). Returns `maxDepth`.
/// Dropped parameters: `oldBandE` (only used for `LM == 0`), `vbr` (always 1: CBR removed),
/// `lfe`, `surround_dynalloc` (all-zero without energy mask, folded into a `MAXG(.., 0)`),
/// `analysis`, `qext_scale`.
pub fn dynalloc_analysis(
    bandLogE: &[f32],
    bandLogE2: &[f32],
    nbEBands: i32,
    start: i32,
    end: i32,
    C: i32,
    offsets: &mut [i32],
    lsb_depth: i32,
    logN: &[i16],
    isTransient: i32,
    constrained_vbr: i32,
    eBands: &[i16],
    LM: i32,
    effectiveBytes: i32,
    tot_boost_: &mut i32,
    importance: &mut [i32],
    spread_weight: &mut [i32],
    tone_freq: f32,
    toneishness: f32,
) -> f32 {
    debug_assert!(LM > 0);
    let mut tot_boost: i32 = 0;
    let sg = stack::save();
    let nb = nbEBands as usize;
    let endu = end as usize;
    let follower = sg.alloc::<f32>(C as usize * nb);
    let noise_floor = sg.alloc::<f32>(C as usize * nb);
    let bandLogE3 = sg.alloc::<f32>(nb);
    offsets[..nb].fill(0);
    /* Dynamic allocation code */
    let mut maxDepth: f32 = -31.9;
    for i in 0..endu {
        /* Noise floor must take into account eMeans, the depth, the width of the bands
        and the preemphasis filter (approx. square of bark band ID) */
        noise_floor[i] = 0.0625 * logN[i] as f32 + 0.5 + (9 - lsb_depth) as f32 - eMeans[i]
            + 0.0062 * (i as i32 + 5) as f32 * (i as i32 + 5) as f32;
    }
    for c in 0..C as usize {
        for i in 0..endu {
            maxDepth = MAX32(maxDepth, bandLogE[c * nb + i] - noise_floor[i]);
        }
    }
    {
        /* Compute a really simple masking model to avoid taking into account completely masked
        bands when computing the spreading decision. */
        let mask = sg.alloc::<f32>(nb);
        let sig = sg.alloc::<f32>(nb);
        for i in 0..endu {
            mask[i] = bandLogE[i] - noise_floor[i];
        }
        if C == 2 {
            for i in 0..endu {
                mask[i] = MAX32(mask[i], bandLogE[nb + i] - noise_floor[i]);
            }
        }
        sig[..endu].copy_from_slice(&mask[..endu]);
        for i in 1..endu {
            mask[i] = MAX32(mask[i], mask[i - 1] - 2.0);
        }
        for i in (0..endu - 1).rev() {
            mask[i] = MAX32(mask[i], mask[i + 1] - 3.0);
        }
        for i in 0..endu {
            /* Compute SMR: Mask is never more than 72 dB below the peak and never below the noise floor.*/
            let smr: f32 = sig[i] - MAX32(MAX32(0.0, maxDepth - 12.0), mask[i]);
            /* Clamp SMR to make sure we're not shifting by something negative or too large. */
            let shift: i32 = IMIN(5, IMAX(0, -(libm::floor((0.5f32 + smr) as f64) as i32)));
            spread_weight[i] = 32 >> shift;
        }
    }
    /* Make sure that dynamic allocation can't make us bust the budget.
    We enable the feature starting at 24 kb/s for 20-ms frames
    and 96 kb/s for 2.5 ms frames.  */
    if effectiveBytes >= (30 + 5 * LM) {
        let mut last: usize = 0;
        for c in 0..C as usize {
            bandLogE3[..endu].copy_from_slice(&bandLogE2[c * nb..c * nb + endu]);
            /* (LM == 0 special case removed: LM is always 3 here) */
            let f = &mut follower[c * nb..(c + 1) * nb];
            f[0] = bandLogE3[0];
            for i in 1..endu {
                /* The last band to be at least 3 dB higher than the previous one
                is the last we'll consider. Otherwise, we run into problems on
                bandlimited signals. */
                if bandLogE3[i] > bandLogE3[i - 1] + 0.5 {
                    last = i;
                }
                f[i] = MIN32(f[i - 1] + 1.5, bandLogE3[i]);
            }
            for i in (0..last).rev() {
                f[i] = MIN32(f[i], MIN32(f[i + 1] + 2.0, bandLogE3[i]));
            }

            /* Combine with a median filter to avoid dynalloc triggering unnecessarily.
            The "offset" value controls how conservative we are -- a higher offset
            reduces the impact of the median filter and makes dynalloc use more bits. */
            let offset: f32 = 1.0;
            for i in 2..endu - 2 {
                f[i] = MAX32(f[i], median_of_5(&bandLogE3[i - 2..]) - offset);
            }
            let tmp = median_of_3(&bandLogE3[0..]) - offset;
            f[0] = MAX32(f[0], tmp);
            f[1] = MAX32(f[1], tmp);
            let tmp = median_of_3(&bandLogE3[endu - 3..]) - offset;
            f[endu - 2] = MAX32(f[endu - 2], tmp);
            f[endu - 1] = MAX32(f[endu - 1], tmp);

            for i in 0..endu {
                f[i] = MAX32(f[i], noise_floor[i]);
            }
        }
        let (start, endu) = (start as usize, end as usize);
        if C == 2 {
            for i in start..endu {
                /* Consider 24 dB "cross-talk" */
                follower[nb + i] = MAX32(follower[nb + i], follower[i] - 4.0);
                follower[i] = MAX32(follower[i], follower[nb + i] - 4.0);
                follower[i] =
                    0.5 * (MAX32(0.0, bandLogE[i] - follower[i]) + MAX32(0.0, bandLogE[nb + i] - follower[nb + i]));
            }
        } else {
            for i in start..endu {
                follower[i] = MAX32(0.0, bandLogE[i] - follower[i]);
            }
        }
        for i in start..endu {
            /* surround_dynalloc[i] == 0 */
            follower[i] = MAX32(follower[i], 0.0);
        }
        for i in start..endu {
            importance[i] = libm::floor((0.5f32 + 13.0 * celt_exp2_db(MIN32(follower[i], 4.0))) as f64) as i32;
        }
        /* For non-transient CBR/CVBR frames, halve the dynalloc contribution */
        if constrained_vbr != 0 && isTransient == 0 {
            for i in start..endu {
                follower[i] = 0.5 * follower[i];
            }
        }
        for i in start..endu {
            if i < 8 {
                follower[i] *= 2.0;
            }
            if i >= 12 {
                follower[i] = 0.5 * follower[i];
            }
        }
        /* Compensate for Opus' under-allocation on tones. */
        if toneishness > 0.98 {
            /* `.5 + tone_freq*120/M_PI`: float product, then double */
            let freq_bin: i32 = libm::floor(0.5 + (tone_freq * 120.0) as f64 / PI) as i32;
            for i in start..endu {
                let (lo, hi) = (eBands[i] as i32, eBands[i + 1] as i32);
                if freq_bin >= lo && freq_bin <= hi {
                    follower[i] += 2.0;
                }
                if freq_bin >= lo - 1 && freq_bin <= hi + 1 {
                    follower[i] += 1.0;
                }
                if freq_bin >= lo - 2 && freq_bin <= hi + 2 {
                    follower[i] += 1.0;
                }
                if freq_bin >= lo - 3 && freq_bin <= hi + 3 {
                    follower[i] += 0.5;
                }
            }
            if freq_bin >= eBands[endu] as i32 {
                follower[endu - 1] += 2.0;
                follower[endu - 2] += 1.0;
            }
        }
        /* (analysis->valid is always 0: no leak_boost) */
        for i in start..endu {
            let width: i32;
            let boost: i32;
            let boost_bits: i32;

            follower[i] = MIN32(follower[i], 4.0);

            /* (SHR32 by 8 is the identity in the float build) */
            width = C * (eBands[i + 1] as i32 - eBands[i] as i32) << LM;
            if width < 6 {
                boost = follower[i] as i32;
                boost_bits = boost * width << BITRES;
            } else if width > 48 {
                boost = (follower[i] * 8.0) as i32;
                boost_bits = (boost * width << BITRES) / 8;
            } else {
                boost = (follower[i] * width as f32 / 6.0) as i32;
                boost_bits = boost * 6 << BITRES;
            }
            /* For CBR and non-transient CVBR frames, limit dynalloc to 2/3 of the bits */
            if (constrained_vbr != 0 && isTransient == 0)
                && (tot_boost + boost_bits) >> BITRES >> 3 > 2 * effectiveBytes / 3
            {
                let cap: i32 = (2 * effectiveBytes / 3) << BITRES << 3;
                offsets[i] = cap - tot_boost;
                tot_boost = cap;
                break;
            } else {
                offsets[i] = boost;
                tot_boost += boost_bits;
            }
        }
    } else {
        for i in start as usize..end as usize {
            importance[i] = 13;
        }
    }
    *tot_boost_ = tot_boost;
    maxDepth
}

/// Compute the LPC coefficients using a least-squares fit for both forward and backward
/// prediction. `x[0..len]`; returns 1 on failure (`lpc` untouched), else 0.
pub fn tone_lpc(x: &[f32], len: i32, delay: i32, lpc: &mut [f32; 2]) -> i32 {
    let mut r00: f32 = 0.0;
    let mut r01: f32 = 0.0;
    let mut r11: f32;
    let mut r02: f32 = 0.0;
    let r12: f32;
    let r22: f32;
    let mut edges: f32;
    debug_assert!(len > 2 * delay);
    let (len, delay) = (len as usize, delay as usize);
    /* Compute correlations as if using the forward prediction covariance method. */
    for i in 0..len - 2 * delay {
        r00 += x[i] * x[i];
        r01 += x[i] * x[i + delay];
        r02 += x[i] * x[i + 2 * delay];
    }
    edges = 0.0;
    for i in 0..delay {
        edges += x[len + i - 2 * delay] * x[len + i - 2 * delay] - x[i] * x[i];
    }
    r11 = r00 + edges;
    edges = 0.0;
    for i in 0..delay {
        edges += x[len + i - delay] * x[len + i - delay] - x[i + delay] * x[i + delay];
    }
    r22 = r11 + edges;
    edges = 0.0;
    for i in 0..delay {
        edges += x[len + i - 2 * delay] * x[len + i - delay] - x[i] * x[i + delay];
    }
    r12 = r01 + edges;
    /* Reverse and sum to get the backward contribution. */
    {
        let R00 = r00 + r22;
        let R01 = r01 + r12;
        let R11 = 2.0 * r11;
        let R02 = 2.0 * r02;
        let R12 = r12 + r01;
        r00 = R00;
        r01 = R01;
        r11 = R11;
        r02 = R02;
        /* R22 = r00 + r22 is never used afterwards */
        let r12 = R12;
        /* Solve A*x=b, where A=[r00, r01; r01, r11] and b=[r02; r12]. */
        let den: f32 = r00 * r11 - r01 * r01;
        if den < 0.001 * (r00 * r11) {
            return 1;
        }
        let num1: f32 = r02 * r11 - r01 * r12;
        if num1 >= den {
            lpc[1] = 1.0;
        } else if num1 <= -den {
            lpc[1] = -1.0;
        } else {
            lpc[1] = num1 / den;
        }
        let num0: f32 = r00 * r12 - r02 * r01;
        if 0.5 * num0 >= den {
            lpc[0] = 1.999999;
        } else if 0.5 * num0 <= -den {
            lpc[0] = -1.999999;
        } else {
            lpc[0] = num0 / den;
        }
    }
    0
}

/// Detects pure of nearly pure tones so we can prevent them from causing problems with the
/// encoder. `in_` holds `CC` channels of `N` samples (`in_[c*N + i]`, the caller passes `N+overlap`).
/// Returns the tone frequency (radians/sample, or -1) and writes `*toneishness`.
pub fn tone_detect(in_: &[f32], CC: i32, N: i32, toneishness: &mut f32, Fs: i32) -> f32 {
    let mut delay: i32 = 1;
    let mut lpc = [0.0f32; 2];
    let freq: f32;
    let sg = stack::save();
    let x = sg.alloc::<f32>(N as usize);
    let nu = N as usize;
    /* Shift by SIG_SHIFT+2 (+3 for stereo) to account for HF gain of the preemphasis filter
    (all shifts are the identity in the float build). */
    if CC == 2 {
        for i in 0..nu {
            x[i] = in_[i] + in_[i + nu];
        }
    } else {
        x[..nu].copy_from_slice(&in_[..nu]);
    }
    let mut fail = tone_lpc(x, N, delay, &mut lpc);
    /* If our LPC filter resonates too close to DC, retry the analysis with down-sampling. */
    while delay <= Fs / 3000 && (fail != 0 || (lpc[0] > 1.0 && lpc[1] < 0.0)) {
        delay *= 2;
        fail = tone_lpc(x, N, delay, &mut lpc);
    }
    /* Check that our filter has complex roots. (3.999999 is a double literal: double arithmetic.) */
    if fail == 0 && (lpc[0] * lpc[0]) as f64 + 3.999999 * (lpc[1] as f64) < 0.0 {
        /* Squared radius of the poles. */
        *toneishness = -lpc[1];
        freq = (libm::acos((0.5f32 * lpc[0]) as f64) / delay as f64) as f32;
    } else {
        freq = -1.0;
        *toneishness = 0.0;
    }
    freq
}

/// Pitch pre-filter. `in_` is the `in` buffer of celt_encode_with_ec: `CC*(N+overlap)` samples,
/// channel `c` at `c*(N+overlap)`, the `N` new (pre-emphasized) samples at `+overlap`; on return
/// the first `overlap` samples of each channel hold the old `in_mem` and the rest the filtered
/// signal. The C `prefilter_mem` argument is `st->in_mem + CC*overlap`, which is
/// `st.prefilter_mem` here (updated in place). Returns `pf_on`.
/// Dropped parameters: `analysis`, `qext_scale`; `st->arch`.
pub fn run_prefilter(
    st: &mut CELTEncoder,
    in_: &mut [f32],
    CC: i32,
    N: i32,
    prefilter_tapset: i32,
    pitch: &mut i32,
    gain: &mut f32,
    qgain: &mut i32,
    enabled: i32,
    complexity: i32,
    tf_estimate: f32,
    nbAvailableBytes: i32,
    mut tone_freq: f32,
    toneishness: f32,
) -> i32 {
    let sg = stack::save();
    let mode = st.mode;
    let overlap = mode.overlap;
    let max_period = COMBFILTER_MAXPERIOD;
    let min_period = COMBFILTER_MINPERIOD;
    let mut before = [0.0f32; 2];
    let mut after = [0.0f32; 2];
    let mut cancel_pitch = false;
    let pitch_index: i32;
    let mut gain1: f32;
    let pf_on: i32;
    let qg: i32;

    /* _pre: CC*(N+max_period); pre[c] = _pre + c*(N+max_period) */
    let ps = (N + max_period) as usize;
    let mp = max_period as usize;
    let nu = N as usize;
    let ovu = overlap as usize;
    let stride = nu + ovu;
    let _pre = sg.alloc::<f32>(CC as usize * ps);

    for c in 0..CC as usize {
        _pre[c * ps..c * ps + mp].copy_from_slice(&st.prefilter_mem[c * mp..(c + 1) * mp]);
        _pre[c * ps + mp..c * ps + mp + nu].copy_from_slice(&in_[c * stride + ovu..c * stride + ovu + nu]);
    }

    /* If we detect that the signal is dominated by a single tone, don't rely on the standard pitch
    estimator, as it can become unreliable. */
    if enabled != 0 && toneishness > 0.99 {
        let mut multiple: i32 = 1;
        /* Using aliased version of the postfilter above 24 kHz.
        First value is purposely slightly above pi to avoid triggering for Fs=48kHz. */
        if tone_freq >= 3.1416 {
            tone_freq = 3.141593 - tone_freq;
        }
        /* If the pitch is too high for our post-filter, apply pitch doubling until
        we can get something that fits (not ideal, but better than nothing). */
        while tone_freq >= multiple as f32 * 0.39 {
            multiple += 1;
        }
        if tone_freq > 0.006148 {
            /* `.5+2.f*M_PI*multiple/tone_freq` is evaluated in double */
            pitch_index = IMIN(
                libm::floor(0.5 + 2.0 * PI * multiple as f64 / tone_freq as f64) as i32,
                COMBFILTER_MAXPERIOD - 2,
            );
        } else {
            /* If the pitch is too low, using a very high pitch will actually give us an improvement
            due to the DC component of the filter that will be close to our tone. Again, not ideal,
            but if we only have a single tone, it's better than nothing. */
            pitch_index = COMBFILTER_MINPERIOD;
        }
        gain1 = 0.75;
    } else if enabled != 0 && complexity >= 5 {
        let pitch_buf = sg.alloc::<f32>(((max_period + N) >> 1) as usize);
        let mut pi: i32 = 0;

        {
            let (p0, p1) = (&*_pre).split_at(ps);
            pitch_downsample(&[p0, p1][..CC as usize], pitch_buf, (max_period + N) >> 1, CC, 2);
        }
        /* Don't search for the fir last 1.5 octave of the range because
        there's too many false-positives due to short-term correlation */
        pitch_search(&pitch_buf[(mp >> 1)..], pitch_buf, N, max_period - 3 * min_period, &mut pi);
        pi = max_period - pi;

        gain1 = remove_doubling(pitch_buf, max_period, min_period, N, &mut pi, st.prefilter_period, st.prefilter_gain);
        if pi > max_period - 2 {
            pi = max_period - 2;
        }
        pitch_index = pi;
        gain1 = 0.7 * gain1;
        if st.loss_rate > 2 {
            gain1 = 0.5 * gain1;
        }
        if st.loss_rate > 4 {
            gain1 = 0.5 * gain1;
        }
        if st.loss_rate > 8 {
            gain1 = 0.0;
        }
    } else {
        gain1 = 0.0;
        pitch_index = COMBFILTER_MINPERIOD;
    }
    /* (analysis->valid is always 0) */

    /* Gain threshold for enabling the prefilter/postfilter */
    let mut pf_threshold: f32 = 0.2;

    /* Adjusting the threshold based on rate and continuity */
    if (pitch_index - st.prefilter_period).abs() * 10 > pitch_index {
        pf_threshold += 0.2;
        /* Completely disable the prefilter on strong transients without continuity. */
        if tf_estimate > 0.98 {
            gain1 = 0.0;
        }
    }
    if nbAvailableBytes < 25 {
        pf_threshold += 0.1;
    }
    if nbAvailableBytes < 35 {
        pf_threshold += 0.1;
    }
    if st.prefilter_gain > 0.4 {
        pf_threshold -= 0.1;
    }
    if st.prefilter_gain > 0.55 {
        pf_threshold -= 0.1;
    }

    /* Hard threshold at 0.2 */
    pf_threshold = MAX16(pf_threshold, 0.2);
    if gain1 < pf_threshold {
        gain1 = 0.0;
        pf_on = 0;
        qg = 0;
    } else {
        /*This block is not gated by a total bits check only because
        of the nbAvailableBytes check above.*/
        if ABS16(gain1 - st.prefilter_gain) < 0.1 {
            gain1 = st.prefilter_gain;
        }

        let q = libm::floor((0.5f32 + gain1 * 32.0 / 3.0) as f64) as i32 - 1;
        qg = IMAX(0, IMIN(7, q));
        gain1 = 0.09375 * (qg + 1) as f32;
        pf_on = 1;
    }

    unsafe {
        let inp = in_.as_mut_ptr();
        let pre = _pre.as_mut_ptr();
        for c in 0..CC as usize {
            let offset = mode.shortMdctSize - overlap;
            st.prefilter_period = IMAX(st.prefilter_period, COMBFILTER_MINPERIOD);
            core::ptr::copy_nonoverlapping(st.in_mem.as_ptr().add(c * ovu), inp.add(c * stride), ovu);
            for i in 0..nu {
                before[c] += ABS32(*inp.add(c * stride + ovu + i));
            }
            if offset != 0 {
                comb_filter(
                    inp.add(c * stride + ovu),
                    pre.add(c * ps + mp),
                    st.prefilter_period,
                    st.prefilter_period,
                    offset,
                    -st.prefilter_gain,
                    -st.prefilter_gain,
                    st.prefilter_tapset,
                    st.prefilter_tapset,
                    &[],
                    0,
                );
            }

            comb_filter(
                inp.add(c * stride + ovu + offset as usize),
                pre.add(c * ps + mp + offset as usize),
                st.prefilter_period,
                pitch_index,
                N - offset,
                -st.prefilter_gain,
                -gain1,
                st.prefilter_tapset,
                prefilter_tapset,
                mode.window,
                overlap,
            );
            for i in 0..nu {
                after[c] += ABS32(*inp.add(c * stride + ovu + i));
            }
        }

        if CC == 2 {
            let mut thresh = [0.0f32; 2];
            thresh[0] = (0.25f32 * gain1) * before[0] + 0.01f32 * before[1];
            thresh[1] = (0.25f32 * gain1) * before[1] + 0.01f32 * before[0];
            /* Don't use the filter if one channel gets significantly worse. */
            if after[0] - before[0] > thresh[0] || after[1] - before[1] > thresh[1] {
                cancel_pitch = true;
            }
            /* Use the filter only if at least one channel gets significantly better. */
            if before[0] - after[0] < thresh[0] && before[1] - after[1] < thresh[1] {
                cancel_pitch = true;
            }
        } else {
            /* Check that the mono channel actually got better. */
            if after[0] > before[0] {
                cancel_pitch = true;
            }
        }
        /* If needed, revert to a gain of zero. */
        if cancel_pitch {
            for c in 0..CC as usize {
                let offset = mode.shortMdctSize - overlap;
                core::ptr::copy_nonoverlapping(pre.add(c * ps + mp), inp.add(c * stride + ovu), nu);
                comb_filter(
                    inp.add(c * stride + ovu + offset as usize),
                    pre.add(c * ps + mp + offset as usize),
                    st.prefilter_period,
                    pitch_index,
                    overlap,
                    -st.prefilter_gain,
                    0.0,
                    st.prefilter_tapset,
                    prefilter_tapset,
                    mode.window,
                    overlap,
                );
            }
            gain1 = 0.0;
        }
    }
    let (pf_on, qg) = if cancel_pitch { (0, 0) } else { (pf_on, qg) };

    for c in 0..CC as usize {
        st.in_mem[c * ovu..(c + 1) * ovu].copy_from_slice(&in_[c * stride + nu..c * stride + nu + ovu]);

        if N > max_period {
            st.prefilter_mem[c * mp..(c + 1) * mp].copy_from_slice(&_pre[c * ps + nu..c * ps + nu + mp]);
        } else {
            st.prefilter_mem.copy_within(c * mp + nu..c * mp + mp, c * mp);
            st.prefilter_mem[c * mp + mp - nu..(c + 1) * mp].copy_from_slice(&_pre[c * ps + mp..c * ps + mp + nu]);
        }
    }

    *gain = gain1;
    *pitch = pitch_index;
    *qgain = qg;
    pf_on
}

/// Target rate in 1/8 bits for the frame. Dropped parameters: `analysis` (valid is always 0, so
/// no activity/tonality terms), `pitch_change` (only used with analysis), `lfe`,
/// `has_surround_mask`, `surround_masking` (all 0), `enable_qext`. The CBR second call
/// (`!vbr_rate`, hybrid) does not exist.
pub fn compute_vbr(
    mode: &CELTMode,
    base_target: i32,
    LM: i32,
    bitrate: i32,
    lastCodedBands: i32,
    C: i32,
    intensity: i32,
    constrained_vbr: i32,
    mut stereo_saving: f32,
    tot_boost: i32,
    tf_estimate: f32,
    maxDepth: f32,
    temporal_vbr: f32,
) -> i32 {
    /* The target rate in 8th bits per frame */
    let mut target: i32;
    let nbEBands = mode.nbEBands;
    let eBands = mode.eBands;

    let coded_bands = if lastCodedBands != 0 { lastCodedBands } else { nbEBands };
    let mut coded_bins: i32 = (eBands[coded_bands as usize] as i32) << LM;
    if C == 2 {
        coded_bins += (eBands[IMIN(intensity, coded_bands) as usize] as i32) << LM;
    }

    target = base_target;

    /* (analysis->valid is always 0: no activity reduction) */
    /* Stereo savings */
    if C == 2 {
        let coded_stereo_bands = IMIN(intensity, coded_bands);
        let coded_stereo_dof: i32 = ((eBands[coded_stereo_bands as usize] as i32) << LM) - coded_stereo_bands;
        /* Maximum fraction of the bits we can save if the signal is mono. */
        let max_frac: f32 = (0.8f32 * coded_stereo_dof as f32) / coded_bins as f32;
        stereo_saving = MIN16(stereo_saving, 1.0);
        target -= MIN32(
            max_frac * target as f32,
            (stereo_saving - 0.1) * ((coded_stereo_dof << BITRES) as f32),
        ) as i32;
    }
    /* Boost the rate according to dynalloc (minus the dynalloc average for calibration). */
    target += tot_boost - (19 << LM);
    /* Apply transient boost, compensating for average boost. */
    let tf_calibration: f32 = 0.044;
    target += ((tf_estimate - tf_calibration) * target as f32) as i32;

    /* (analysis->valid and surround masks are always off) */

    {
        let bins: i32 = (eBands[nbEBands as usize - 2] as i32) << LM;
        let mut floor_depth: i32 = (((C * bins) << BITRES) as f32 * maxDepth) as i32;
        floor_depth = IMAX(floor_depth, target >> 2);
        target = IMIN(target, floor_depth);
    }

    /* Make VBR less aggressive for constrained VBR because we can't keep a higher bitrate
    for long. Needs tuning. */
    if constrained_vbr != 0 {
        target = base_target + (0.67f32 * (target - base_target) as f32) as i32;
    }

    if tf_estimate < 0.2 {
        let amount: f32 = 0.0000031f32 * IMAX(0, IMIN(32000, 96000 - bitrate)) as f32;
        let tvbr_factor: f32 = temporal_vbr * amount;
        target += (tvbr_factor * target as f32) as i32;
    }

    /* Don't allow more than doubling the rate */
    IMIN(2 * base_target, target)
}

#[cfg(test)]
mod helper_tests {
    use super::*;
    use crate::celt::celt::AnalysisInfo;
    use crate::celt::entenc::ec_enc_init;
    use crate::celt::modes::mode48000_960_120 as MODE;
    use crate::celt::quant_bands::amp2Log2;
    use crate::testutil::{Rng, music, noise, same_enc};
    use core::ffi::{c_int, c_void};
    use minicelt_oracle as c;
    use std::vec;
    use std::vec::Vec;

    unsafe extern "C" {
        fn celt_preemphasis(pcmp: *const f32, inp: *mut f32, n: c_int, cc: c_int, upsample: c_int, coef: *const f32, mem: *mut f32, clip: c_int);
    }

    const NB: usize = 21;
    const NAN: u32 = 0x7fc00001;

    fn bits(v: &[f32]) -> Vec<u32> {
        v.iter().map(|x| x.to_bits()).collect()
    }
    fn cm() -> *const c_void {
        c::mode48000()
    }
    /// Planar `CC*len` celt_sig-scaled signals of kinds: 0 music, 1 noise, 2 silence, 3 tone, 4 tone+noise.
    fn signal(rng: &mut Rng, kind: usize, cc: usize, len: usize) -> Vec<f32> {
        match kind {
            0 => {
                let f = music(rng.next_u64(), 4, len, cc).pop().unwrap();
                let mut o = vec![0.0f32; cc * len];
                for i in 0..len {
                    for ch in 0..cc {
                        o[ch * len + i] = f[i * cc + ch] * 32768.0;
                    }
                }
                o
            }
            1 => noise(rng.next_u64(), 1, len, cc, 8000.0).pop().unwrap(),
            2 => vec![0.0; cc * len],
            5 => {
                /* quiet noise with a decaying burst at a random position */
                let at = rng.range(200, len as i32 - 300) as usize;
                let mut o = vec![0.0f32; cc * len];
                for ch in 0..cc {
                    for i in 0..len {
                        let burst = if i >= at { 20000.0 * libm::expf(-((i - at) as f32) / 80.0) } else { 0.0 };
                        o[ch * len + i] = rng.f32_unit() * (30.0 + burst);
                    }
                }
                o
            }
            _ => {
                let w = 0.005 + 0.2 * (rng.f32_unit().abs() as f64);
                let a = 3000.0 + 8000.0 * rng.f32_unit().abs() as f64;
                let ph = rng.f32_unit() as f64 * 3.0;
                let nz = if kind == 4 { 300.0 } else { 0.0 };
                let mut o = vec![0.0f32; cc * len];
                for ch in 0..cc {
                    for i in 0..len {
                        o[ch * len + i] = (a * libm::sin(w * i as f64 * (1.0 + 0.1 * ch as f64) + ph)) as f32 + nz * rng.f32_unit();
                    }
                }
                o
            }
        }
    }
    fn tone_params(rng: &mut Rng) -> (f32, f32) {
        match rng.range(0, 3) {
            0 => (0.0, 0.0),
            1 => (0.005 + rng.f32_unit().abs() * 3.0, 0.97 + rng.f32_unit().abs() * 0.03),
            2 => (0.02 + rng.f32_unit().abs() * 0.01, 0.995),
            _ => (rng.f32_unit().abs() * 3.0, rng.f32_unit().abs()),
        }
    }
    /// Per-band normalized MDCT spectrum (2 channels, 960 each) of a music/noise frame.
    fn norm_spec(rng: &mut Rng, short: i32, kind: usize) -> Vec<f32> {
        let inp = signal(rng, kind, 2, 1080);
        let mut out = vec![0.0f32; 2 * 960];
        compute_mdcts(&MODE, short, &inp, &mut out, 2, 2, 3);
        for ch in 0..2 {
            for i in 0..NB {
                let (a, b) = ((MODE.eBands[i] as usize) << 3, (MODE.eBands[i + 1] as usize) << 3);
                let e: f32 = out[ch * 960 + a..ch * 960 + b].iter().map(|x| x * x).sum();
                let g = 1.0 / libm::sqrtf(1e-27 + e);
                for x in &mut out[ch * 960 + a..ch * 960 + b] {
                    *x *= g;
                }
            }
        }
        out
    }
    fn band_loge(rng: &mut Rng, short: i32, kind: usize) -> Vec<f32> {
        let inp = signal(rng, kind, 2, 1080);
        let mut spec = vec![0.0f32; 2 * 960];
        compute_mdcts(&MODE, short, &inp, &mut spec, 2, 2, 3);
        let mut bande = vec![0.0f32; 2 * NB];
        for ch in 0..2 {
            for i in 0..NB {
                let (a, b) = ((MODE.eBands[i] as usize) << 3, (MODE.eBands[i + 1] as usize) << 3);
                let e: f32 = spec[ch * 960 + a..ch * 960 + b].iter().map(|x| x * x).sum();
                bande[ch * NB + i] = libm::sqrtf(1e-27 + e);
            }
        }
        let mut l = vec![0.0f32; 2 * NB];
        amp2Log2(&MODE, 21, 21, &bande, &mut l, 2);
        l
    }

    #[test]
    fn transient_analysis_matches_c() {
        let mut rng = Rng::new(101);
        let mut cnt = [0; 2];
        for iter in 0..400 {
            let cc = 1 + iter % 2;
            let x = signal(&mut rng, (iter / 2) % 6, cc, 1080);
            let (tf, ts) = tone_params(&mut rng);
            let weak = rng.range(0, 1);
            let (mut e1, mut e2) = (f32::from_bits(NAN), f32::from_bits(NAN));
            let (mut ch1, mut ch2, mut w1, mut w2) = (-1, -1, 7, 7);
            let r1 = transient_analysis(&x, 1080, cc as i32, &mut e1, &mut ch1, weak, &mut w1, tf, ts);
            let r2 = unsafe { c::oracle_transient_analysis(x.as_ptr(), 1080, cc as i32, &mut e2, &mut ch2, weak, &mut w2, tf, ts) };
            assert_eq!((r1, ch1, w1, e1.to_bits()), (r2, ch2, w2, e2.to_bits()), "iter {iter}");
            cnt[r1 as usize] += 1;
        }
        assert!(cnt[0] > 20 && cnt[1] > 20, "transient coverage {cnt:?}");
    }

    #[test]
    fn patch_transient_decision_matches_c() {
        let mut rng = Rng::new(102);
        for iter in 0..400 {
            let cc = 1 + iter % 2;
            let mut n = band_loge(&mut rng, 0, iter % 5);
            let mut o = band_loge(&mut rng, 0, (iter + 1) % 3);
            if iter % 7 == 0 {
                for v in &mut o {
                    *v -= 8.0;
                }
            }
            let start = if iter % 5 == 0 { rng.range(0, 3) } else { 0 };
            let r1 = patch_transient_decision(&n, &o, NB as i32, start, 21, cc as i32);
            let r2 = unsafe { c::oracle_patch_transient_decision(n.as_mut_ptr(), o.as_mut_ptr(), NB as i32, start, 21, cc as i32) };
            assert_eq!(r1, r2, "iter {iter}");
        }
    }

    #[test]
    fn compute_mdcts_matches_c() {
        let mut rng = Rng::new(103);
        for iter in 0..80 {
            let (c_, cc) = match iter % 3 { 0 => (1, 1), 1 => (2, 2), _ => (1, 2) };
            let short = if iter % 2 == 0 { 0 } else { 8 };
            let x = signal(&mut rng, iter % 5, cc, 1080);
            let mut a = vec![f32::from_bits(NAN); cc * 960];
            let mut b = a.clone();
            compute_mdcts(&MODE, short, &x, &mut a, c_ as i32, cc as i32, 3);
            let mut xc = x.clone();
            unsafe { c::oracle_compute_mdcts(cm(), short, xc.as_mut_ptr(), b.as_mut_ptr(), c_ as i32, cc as i32, 3, 1, 0) };
            assert_eq!(bits(&a), bits(&b), "iter {iter}");
        }
    }

    #[test]
    fn celt_preemphasis_matches_c() {
        let mut rng = Rng::new(104);
        for iter in 0..100 {
            let cc = 1 + iter % 2;
            let scale = if iter % 4 < 2 { 0.5 } else { 4.0 };
            let pcm: Vec<f32> = rng.f32_vec(960 * cc, scale);
            let clip = (iter / 2) % 2;
            let mut m1 = rng.f32_unit() * 1000.0;
            let mut m2 = m1;
            let mut a = vec![f32::from_bits(NAN); 960];
            let mut b = a.clone();
            celt_preemphasis_rs(&pcm, &mut a, cc, &mut m1, clip as i32);
            unsafe { celt_preemphasis(pcm.as_ptr(), b.as_mut_ptr(), 960, cc as i32, 1, MODE.preemph.as_ptr(), &mut m2, clip as i32) };
            assert_eq!((bits(&a), m1.to_bits()), (bits(&b), m2.to_bits()), "iter {iter}");
        }
    }
    fn celt_preemphasis_rs(pcm: &[f32], inp: &mut [f32], cc: usize, mem: &mut f32, clip: i32) {
        super::celt_preemphasis(pcm, inp, 960, cc as i32, &MODE.preemph, mem, clip);
    }

    #[test]
    fn l1_metric_matches_c() {
        let mut rng = Rng::new(105);
        for _ in 0..300 {
            let n = rng.range(1, 200);
            let x = rng.f32_vec(n as usize, 3.0);
            let (lm, bias) = (rng.range(0, 4), rng.f32_unit() * 0.1);
            let a = l1_metric(&x, n, lm, bias);
            let b = unsafe { c::oracle_l1_metric(x.as_ptr(), n, lm, bias) };
            assert_eq!(a.to_bits(), b.to_bits());
        }
    }

    #[test]
    fn tf_analysis_matches_c() {
        let mut rng = Rng::new(106);
        for iter in 0..300 {
            let trans = (iter % 2) as i32;
            let mut x = norm_spec(&mut rng, if trans != 0 { 8 } else { 0 }, iter % 5);
            let len = if iter % 4 == 0 { rng.range(5, 21) } else { 21 };
            let lambda = rng.range(2, 200);
            let est = rng.f32_unit().abs() * 1.5;
            let chan = rng.range(0, 1);
            let mut imp: Vec<i32> = (0..NB).map(|_| rng.range(1, 60)).collect();
            let mut r1 = vec![-5; NB];
            let mut r2 = r1.clone();
            let s1 = tf_analysis(&MODE, len, trans, &mut r1, lambda, &x, 960, 3, est, chan, &imp);
            let s2 = unsafe { c::oracle_tf_analysis(cm(), len, trans, r2.as_mut_ptr(), lambda, x.as_mut_ptr(), 960, 3, est, chan, imp.as_mut_ptr()) };
            assert_eq!((s1, r1), (s2, r2), "iter {iter}");
        }
    }

    #[test]
    fn tf_encode_matches_c() {
        let mut rng = Rng::new(107);
        for iter in 0..500 {
            let size = rng.range(2, 40) as usize;
            let mut b1 = vec![0u8; size];
            let mut b2 = vec![0u8; size];
            let mut e1: ec_enc = unsafe { core::mem::zeroed() };
            let mut e2: ec_enc = unsafe { core::mem::zeroed() };
            ec_enc_init(&mut e1, b1.as_mut_ptr(), size as u32);
            unsafe { c::ec_enc_init(&mut e2 as *mut ec_enc as *mut c_void, b2.as_mut_ptr(), size as u32) };
            for _ in 0..rng.range(0, size as i32 * 3) {
                let v = rng.range(0, 1);
                ec_enc_bit_logp(&mut e1, v, 1);
                unsafe { c::ec_enc_bit_logp(&mut e2 as *mut ec_enc as *mut c_void, v, 1) };
            }
            let trans = iter % 2;
            let lm = if iter % 3 == 0 { rng.range(0, 3) } else { 3 };
            let (start, end) = (0, rng.range(1, 21));
            let mut r1: Vec<i32> = (0..NB).map(|_| rng.range(0, 1)).collect();
            let mut r2 = r1.clone();
            let sel = rng.range(0, 1);
            tf_encode(start, end, trans, &mut r1, lm, sel, &mut e1);
            unsafe { c::oracle_tf_encode(start, end, trans, r2.as_mut_ptr(), lm, sel, &mut e2 as *mut ec_enc as *mut c_void) };
            assert_eq!(r1, r2, "iter {iter}");
            same_enc(&e1, &e2);
            assert_eq!(b1, b2);
        }
    }

    #[test]
    fn alloc_trim_analysis_matches_c() {
        let mut rng = Rng::new(108);
        let an = AnalysisInfo::new_zeroed();
        for iter in 0..400 {
            let cc = 1 + (iter % 2) as i32;
            let x = norm_spec(&mut rng, 0, iter % 5);
            let ble = band_loge(&mut rng, 0, iter % 5);
            let end = if iter % 4 == 0 { rng.range(8, 21) } else { 21 };
            let inten = rng.range(8, 21);
            let tfe = rng.f32_unit().abs() * 1.2;
            let rate = rng.range(20000, 130000);
            let mut s1 = rng.f32_unit() * 2.0;
            let mut s2 = s1;
            let r1 = alloc_trim_analysis(&MODE, &x, &ble, end, 3, cc, 960, &mut s1, tfe, inten, rate);
            let r2 = unsafe {
                c::oracle_alloc_trim_analysis(cm(), x.as_ptr(), ble.as_ptr(), end, 3, cc, 960, &an as *const _ as *mut c_void, &mut s2, tfe, inten, 0.0, rate, 0)
            };
            assert_eq!((r1, s1.to_bits()), (r2, s2.to_bits()), "iter {iter}");
        }
    }

    #[test]
    fn stereo_analysis_matches_c() {
        let mut rng = Rng::new(109);
        for iter in 0..300 {
            let x = norm_spec(&mut rng, 0, iter % 5);
            let a = stereo_analysis(&MODE, &x, 3, 960);
            let b = unsafe { c::oracle_stereo_analysis(cm(), x.as_ptr(), 3, 960) };
            assert_eq!(a, b);
            let lm = rng.range(0, 2);
            let n0 = 120 << lm;
            let y = rng.f32_vec(2 * n0 as usize, 1.0);
            let a = stereo_analysis(&MODE, &y, lm, n0);
            let b = unsafe { c::oracle_stereo_analysis(cm(), y.as_ptr(), lm, n0) };
            assert_eq!(a, b);
        }
    }

    #[test]
    fn medians_match_c() {
        let mut rng = Rng::new(110);
        for _ in 0..2000 {
            let x: Vec<f32> = (0..5).map(|_| rng.range(-3, 3) as f32 * 0.5).collect();
            assert_eq!(median_of_5(&x).to_bits(), unsafe { c::oracle_median_of_5(x.as_ptr()) }.to_bits());
            assert_eq!(median_of_3(&x).to_bits(), unsafe { c::oracle_median_of_3(x.as_ptr()) }.to_bits());
        }
    }

    #[test]
    fn dynalloc_analysis_matches_c() {
        let mut rng = Rng::new(111);
        let an = AnalysisInfo::new_zeroed();
        for iter in 0..500 {
            let cc = 1 + (iter % 2) as i32;
            let short = if iter % 3 == 0 { 8 } else { 0 };
            let b1 = band_loge(&mut rng, short, iter % 5);
            let b2 = band_loge(&mut rng, short, (iter + 1) % 5);
            let end = if iter % 5 == 0 { rng.range(8, 21) } else { 21 };
            let lsb = rng.range(12, 24);
            let trans = (iter / 2 % 2) as i32;
            let cvbr = (iter / 4 % 2) as i32;
            let bytes = if iter % 6 == 0 { rng.range(3, 50) } else { rng.range(40, 400) };
            let (tf, ts) = tone_params(&mut rng);
            let mut o1 = vec![99; NB];
            let mut o2 = o1.clone();
            let mut imp1 = vec![-7; NB];
            let mut imp2 = imp1.clone();
            let mut sw1 = vec![-9; NB];
            let mut sw2 = sw1.clone();
            let (mut t1, mut t2) = (-1, -1);
            let r1 = dynalloc_analysis(&b1, &b2, NB as i32, 0, end, cc, &mut o1, lsb, MODE.logN, trans, cvbr, MODE.eBands, 3, bytes, &mut t1, &mut imp1, &mut sw1, tf, ts);
            let mut sd = vec![0.0f32; 2 * NB];
            let r2 = unsafe {
                c::oracle_dynalloc_analysis(b1.as_ptr(), b2.as_ptr(), b1.as_ptr(), NB as i32, 0, end, cc, o2.as_mut_ptr(), lsb, MODE.logN.as_ptr(), trans, 1, cvbr, MODE.eBands.as_ptr(), 3, bytes, &mut t2, 0, sd.as_mut_ptr(), &an as *const _ as *mut c_void, imp2.as_mut_ptr(), sw2.as_mut_ptr(), tf, ts)
            };
            assert_eq!((r1.to_bits(), o1, t1, imp1, sw1), (r2.to_bits(), o2, t2, imp2, sw2), "iter {iter}");
        }
    }

    #[test]
    fn tone_lpc_matches_c() {
        let mut rng = Rng::new(112);
        for iter in 0..300 {
            let x = signal(&mut rng, 2 + iter % 3 + (iter % 2) * 0, 1, 1080);
            let x = if iter % 7 == 0 { signal(&mut rng, 1, 1, 1080) } else { x };
            let delay = 1 << rng.range(0, 5);
            let mut l1 = [f32::from_bits(NAN); 2];
            let mut l2 = l1;
            let r1 = tone_lpc(&x, 1080, delay, &mut l1);
            let r2 = unsafe { c::oracle_tone_lpc(x.as_ptr(), 1080, delay, l2.as_mut_ptr()) };
            assert_eq!((r1, bits(&l1)), (r2, bits(&l2)), "iter {iter}");
        }
    }

    #[test]
    fn tone_detect_matches_c() {
        let mut rng = Rng::new(113);
        for iter in 0..400 {
            let cc = 1 + iter % 2;
            let x = signal(&mut rng, iter / 2 % 5, cc, 1080);
            let (mut t1, mut t2) = (f32::from_bits(NAN), f32::from_bits(NAN));
            let f1 = tone_detect(&x, cc as i32, 1080, &mut t1, 48000);
            let f2 = unsafe { c::oracle_tone_detect(x.as_ptr(), cc as i32, 1080, &mut t2, 48000) };
            assert_eq!((f1.to_bits(), t1.to_bits()), (f2.to_bits(), t2.to_bits()), "iter {iter}");
        }
    }

    #[test]
    fn run_prefilter_matches_c() {
        let mut rng = Rng::new(114);
        let in_off = core::mem::offset_of!(CELTEncoder, in_mem);
        let sz = core::mem::size_of::<CELTEncoder>();
        let (mut on, mut off) = (0, 0);
        for iter in 0..60 {
            let cc = 1 + iter % 2;
            let mut st = CELTEncoder::new_zeroed();
            celt_encoder_init(&mut st, 48000, cc as i32);
            st.loss_rate = if iter % 5 == 0 { rng.range(0, 10) } else { 0 };
            st.prefilter_period = rng.range(0, 1000);
            st.prefilter_gain = if iter % 3 == 0 { 0.0 } else { rng.f32_unit().abs() * 0.75 };
            st.prefilter_tapset = rng.range(0, 2);
            let mut cbuf = vec![0u64; sz / 8 + 2];
            let cst = cbuf.as_mut_ptr() as *mut u8;
            assert_eq!(unsafe { c::oracle_opus_custom_encoder_init_arch(cst as *mut c_void, cm(), cc as i32, 0) }, 0);
            let mut cpre = vec![0.0f32; 2 * 1024];
            let src = signal(&mut rng, iter / 2 % 3, cc, 1024);
            for ch in 0..cc {
                st.prefilter_mem[ch * 1024..(ch + 1) * 1024].copy_from_slice(&src[ch * 1024..(ch + 1) * 1024]);
            }
            for ch in 0..cc * 120 {
                st.in_mem[ch] = rng.f32_unit() * 1000.0;
            }
            let cst_bytes_cmp = |st: &CELTEncoder, cpre: &Vec<f32>, what: &str| unsafe {
                let rb = core::slice::from_raw_parts(st as *const CELTEncoder as *const u8, in_off);
                let cb = core::slice::from_raw_parts(cst, in_off);
                assert_eq!(&rb[4..], &cb[4..], "{what}: header");
                let ci = core::slice::from_raw_parts(cst.add(in_off) as *const f32, cc * 120);
                assert_eq!(bits(&st.in_mem[..cc * 120]), bits(ci), "{what}: in_mem");
                assert_eq!(bits(&st.prefilter_mem[..cc * 1024]), bits(&cpre[..cc * 1024]), "{what}: prefilter_mem");
            };
            for frame in 0..6 {
                let sig = signal(&mut rng, (iter / 2 + frame) % 5, cc, 960);
                let mut inr = vec![f32::from_bits(NAN); cc * 1080];
                for ch in 0..cc {
                    inr[ch * 1080 + 120..(ch + 1) * 1080].copy_from_slice(&sig[ch * 960..(ch + 1) * 960]);
                }
                let mut inc = inr.clone();
                // sync C state from Rust (all but the mode pointer)
                unsafe {
                    core::ptr::copy_nonoverlapping((&st as *const CELTEncoder as *const u8).add(4), cst.add(4), in_off - 4);
                    core::ptr::copy_nonoverlapping(st.in_mem.as_ptr(), cst.add(in_off) as *mut f32, cc * 120);
                }
                cpre[..cc * 1024].copy_from_slice(&st.prefilter_mem[..cc * 1024]);
                let tapset = rng.range(0, 2);
                let enabled = if iter % 7 == 0 { 0 } else { 1 };
                let cplx = if iter % 9 == 0 { rng.range(0, 4) } else { 5 + rng.range(0, 5) };
                let tfe = rng.f32_unit().abs() * 1.2;
                let bytes = rng.range(10, 200);
                let (tf, ts) = if iter % 4 == 0 { tone_params(&mut rng) } else { (0.0, 0.0) };
                let (mut p1, mut g1, mut q1) = (-1, -1.0f32, -1);
                let (mut p2, mut g2, mut q2) = (-1, -1.0f32, -1);
                let r1 = run_prefilter(&mut st, &mut inr, cc as i32, 960, tapset, &mut p1, &mut g1, &mut q1, enabled, cplx, tfe, bytes, tf, ts);
                let an = AnalysisInfo::new_zeroed();
                let r2 = unsafe {
                    c::oracle_run_prefilter(cst as *mut c_void, inc.as_mut_ptr(), cpre.as_mut_ptr(), cc as i32, 960, tapset, &mut p2, &mut g2, &mut q2, enabled, cplx, tfe, bytes, &an as *const _ as *mut c_void, tf, ts)
                };
                assert_eq!((r1, p1, g1.to_bits(), q1), (r2, p2, g2.to_bits(), q2), "iter {iter} frame {frame}");
                assert_eq!(bits(&inr), bits(&inc), "in iter {iter} frame {frame}");
                cst_bytes_cmp(&st, &cpre, "state");
                if r1 != 0 { on += 1 } else { off += 1 }
                // as celt_encode_with_ec does after the prefilter
                if r1 != 0 {
                    st.prefilter_period = p1;
                    st.prefilter_gain = g1;
                    st.prefilter_tapset = tapset;
                } else {
                    st.prefilter_gain = 0.0;
                }
            }
        }
        assert!(on > 10 && off > 10, "prefilter coverage on={on} off={off}");
    }

    #[test]
    fn compute_vbr_matches_c() {
        let mut rng = Rng::new(115);
        let an = AnalysisInfo::new_zeroed();
        for iter in 0..5000 {
            let cc = 1 + (iter % 2) as i32;
            let base = rng.range(300, 40000);
            let br = rng.range(6000, 510000);
            let lcb = if iter % 3 == 0 { 0 } else { rng.range(1, 21) };
            let inten = rng.range(0, 21);
            let cvbr = rng.range(0, 1);
            let ss = rng.f32_unit() * 2.0;
            let tb = rng.range(0, 2000);
            let tfe = if iter % 2 == 0 { rng.f32_unit().abs() * 0.3 } else { rng.f32_unit().abs() * 1.3 };
            let md = rng.f32_unit() * 20.0 + 5.0;
            let tv = rng.f32_unit() * 3.0;
            let a = compute_vbr(&MODE, base, 3, br, lcb, cc, inten, cvbr, ss, tb, tfe, md, tv);
            let b = unsafe { c::oracle_compute_vbr(cm(), &an as *const _ as *mut c_void, base, 3, br, lcb, cc, inten, cvbr, ss, tb, tfe, 0, md, 0, 0, 0.0, tv) };
            assert_eq!(a, b, "iter {iter}");
        }
    }
}

// group E: everything else.

/* ------------------------------------------------------------------------------------------
 * group G: encoder API used by src/opus_encoder.c (CELT-only).
 *
 * celt_encoder_init / opus_custom_encoder_init_arch and the subset of opus_custom_encoder_ctl
 * that the Opus layer uses, one function per request. Not ported: CELT_SET_ANALYSIS (the
 * analysis is never valid, st.analysis stays zeroed from the reset), CELT_SET_SILK_INFO
 * (hybrid only), OPUS_SET_ENERGY_MASK, OPUS_SET_LFE, OPUS_SET_QEXT, CELT_GET_MODE (always
 * `st.mode`), CELT_SET_INPUT_CLIPPING (custom modes only).
 * ---------------------------------------------------------------------------------------- */

/* Paths are spelled out in this section (no `use`) so it cannot clash with the imports of
the encoder body above. */

/// opus_custom_encoder_init_arch(st, mode48000_960_120, channels) followed by the
/// `upsample = resampling_factor(sampling_rate)` of celt_encoder_init. Only 48 kHz is
/// supported (upsample == 1).
pub fn celt_encoder_init(st: &mut CELTEncoder, sampling_rate: i32, channels: i32) -> i32 {
    debug_assert!(sampling_rate == 48000);
    if sampling_rate != 48000 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    /* opus_custom_encoder_init_arch() */
    if channels < 0 || channels > 2 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }

    *st = CELTEncoder::new_zeroed();

    st.mode = &mode48000_960_120;
    st.channels = channels;
    st.stream_channels = channels;

    st.upsample = 1;
    st.start = 0;
    st.end = st.mode.effEBands;
    st.signalling = 1;
    st.arch = 0;

    st.constrained_vbr = 1;
    st.clip = 1;

    st.bitrate = crate::opus::defines::OPUS_BITRATE_MAX;
    st.vbr = 0;
    st.force_intra = 0;
    st.complexity = 5;
    st.lsb_depth = 24;

    celt_encoder_reset_state(st);

    /* celt_encoder_init(): resampling_factor(48000) */
    st.upsample = 1;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_COMPLEXITY
pub fn celt_encoder_set_complexity(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 0 || value > 10 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.complexity = value;
    crate::opus::defines::OPUS_OK
}

/// CELT_SET_START_BAND
pub fn celt_encoder_set_start_band(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 0 || value >= st.mode.nbEBands {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.start = value;
    crate::opus::defines::OPUS_OK
}

/// CELT_SET_END_BAND
pub fn celt_encoder_set_end_band(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 1 || value > st.mode.nbEBands {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.end = value;
    crate::opus::defines::OPUS_OK
}

/// CELT_SET_PREDICTION
pub fn celt_encoder_set_prediction(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 0 || value > 2 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.disable_pf = (value <= 1) as i32;
    st.force_intra = (value == 0) as i32;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_PACKET_LOSS_PERC
pub fn celt_encoder_set_packet_loss_perc(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 0 || value > 100 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.loss_rate = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_VBR_CONSTRAINT (no validation, as in C)
pub fn celt_encoder_set_vbr_constraint(st: &mut CELTEncoder, value: i32) -> i32 {
    st.constrained_vbr = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_VBR (no validation, as in C). minicelt only supports VBR (`value == 1`) when
/// encoding.
pub fn celt_encoder_set_vbr(st: &mut CELTEncoder, value: i32) -> i32 {
    st.vbr = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_BITRATE
pub fn celt_encoder_set_bitrate(st: &mut CELTEncoder, value: i32) -> i32 {
    if value <= 500 && value != crate::opus::defines::OPUS_BITRATE_MAX {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    let value = super::arch::IMIN(value, 750000 * st.channels);
    st.bitrate = value;
    crate::opus::defines::OPUS_OK
}

/// CELT_SET_CHANNELS
pub fn celt_encoder_set_channels(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 1 || value > 2 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.stream_channels = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_LSB_DEPTH
pub fn celt_encoder_set_lsb_depth(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 8 || value > 24 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.lsb_depth = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_PHASE_INVERSION_DISABLED
pub fn celt_encoder_set_phase_inversion_disabled(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 0 || value > 1 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.disable_inv = value;
    crate::opus::defines::OPUS_OK
}

/// CELT_SET_SIGNALLING (no validation, as in C). The Opus layer sets 0; minicelt does not
/// support the Opus custom header (`signalling != 0`) when encoding.
pub fn celt_encoder_set_signalling(st: &mut CELTEncoder, value: i32) -> i32 {
    st.signalling = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_RESET_STATE
pub fn celt_encoder_reset_state(st: &mut CELTEncoder) {
    /* Clears everything from ENCODER_RESET_START (rng) to the end of the struct, including
    the trailing arrays (here sized for MAX_CHANNELS; C clears channels' worth). */
    let start = core::mem::offset_of!(CELTEncoder, rng);
    let size = core::mem::size_of::<CELTEncoder>();
    // SAFETY: every field from rng on is an integer, a float, an array of those, a struct of
    // those (AnalysisInfo, SILKInfo) or a raw pointer (energy_mask), for all of which the
    // all-zero bit pattern is valid (null for the pointer); `mode` lies before `rng`.
    unsafe {
        core::ptr::write_bytes((st as *mut CELTEncoder as *mut u8).add(start), 0, size - start);
    }
    let n = (st.channels * st.mode.nbEBands) as usize;
    for i in 0..n {
        st.oldLogE2[i] = -28.0f32;
        st.oldLogE[i] = st.oldLogE2[i];
    }
    st.vbr_offset = 0;
    st.delayedIntra = 1.0;
    st.spread_decision = 2; /* SPREAD_NORMAL */
    st.tonal_average = 256;
    st.hf_average = 0;
    st.tapset_decision = 0;
}

/// OPUS_GET_FINAL_RANGE
pub fn celt_encoder_get_final_range(st: &CELTEncoder) -> u32 {
    st.rng
}

/// Encodes one frame (celt/celt_encoder.c, implemented by the CELT port).
///
/// Contract: `pcm` holds `frame_size` interleaved samples of `st.channels` channels
/// (`pcm.len() >= frame_size * st.channels`, float scale +-1 i.e. opus_res); `frame_size`
/// is 960 here. If `enc` is `None`, the function creates its own range coder over
/// `compressed[0..nbCompressedBytes]`; otherwise it continues coding into `enc` (which the
/// caller initialised, e.g. on `data + 1` after the TOC byte) and `compressed` may be null.
/// Returns the number of bytes written (`nbCompressedBytes` after ec_enc_shrink in VBR)
/// or a negative Opus error code; on return `st.rng` holds the final range.
pub fn celt_encode_with_ec(
    st: &mut CELTEncoder,
    pcm: &[f32],
    frame_size: i32,
    compressed: *mut u8,
    nbCompressedBytes: i32,
    enc: Option<&mut crate::celt::entcode::ec_enc>,
) -> i32 {
    let _ = (st, pcm, frame_size, compressed, nbCompressedBytes, enc);
    todo!("celt_encode_with_ec: ported by the CELT encoder group")
}
