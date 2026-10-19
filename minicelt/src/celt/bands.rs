//! Port of celt/bands.c and celt/bands.h (encoder side, float build, no QEXT, upstream
//! libopus 1.6.1 with the RFC 8251 update draft, i.e. DISABLE_UPDATE_DRAFT undefined).
//!
//! `encode` is always 1: the decoder paths are removed and the shared functions lose their
//! `encode` parameter. `denormalise_bands` and `anti_collapse` (decoder only) are not ported.
//!
//! The band quantisation recursion (`quant_band`, `quant_partition`, `quant_band_stereo`,
//! `compute_theta`, ...) works on raw pointers, as in C: X and Y are halves of one buffer, the
//! folding source `lowband` and the output `lowband_out` point into the `norm` buffer, and
//! without resynthesis `lowband_scratch` points into X itself.

use super::arch::{IMAX, IMIN, MIN32, Q31ONE};
use super::entcode::{BITRES, EC_ILOG, celt_sudiv, celt_udiv, ec_ctx, ec_tell_frac};
use super::entenc::{ec_enc_bit_logp, ec_enc_bits, ec_enc_uint, ec_encode};
use super::mathops::celt_sqrt;
use super::modes::CELTMode;
use super::pitch::celt_inner_prod;
use super::rate::{QTHETA_OFFSET, QTHETA_OFFSET_TWOPHASE, bits2pulses, get_pulses, pulses2bits};
use super::vq::{alg_quant, renormalise_vector, stereo_itheta};
use crate::stack;
use core::ptr;

pub const SPREAD_NONE: i32 = 0;
pub const SPREAD_LIGHT: i32 = 1;
pub const SPREAD_NORMAL: i32 = 2;
pub const SPREAD_AGGRESSIVE: i32 = 3;

/// FRAC_MUL16 (mathops.h): `(16384+((opus_int32)(opus_int16)(a)*(opus_int16)(b)))>>15`
#[inline(always)]
fn FRAC_MUL16(a: i32, b: i32) -> i32 {
    (16384 + (a as i16 as i32) * (b as i16 as i32)) >> 15
}

#[inline(always)]
unsafe fn slice_mut<'a>(p: *mut f32, n: i32) -> &'a mut [f32] {
    unsafe { core::slice::from_raw_parts_mut(p, n as usize) }
}

#[inline(always)]
unsafe fn slice<'a>(p: *const f32, n: i32) -> &'a [f32] {
    unsafe { core::slice::from_raw_parts(p, n as usize) }
}

pub fn hysteresis_decision(val: f32, thresholds: &[f32], hysteresis: &[f32], N: i32, prev: i32) -> i32 {
    let mut i = 0;
    while i < N {
        if val < thresholds[i as usize] {
            break;
        }
        i += 1;
    }
    if i > prev && val < thresholds[prev as usize] + hysteresis[prev as usize] {
        i = prev;
    }
    if i < prev && val > thresholds[(prev - 1) as usize] - hysteresis[(prev - 1) as usize] {
        i = prev;
    }
    i
}

/// Linear congruential generator (relies on unsigned wraparound).
#[inline]
pub fn celt_lcg_rand(seed: u32) -> u32 {
    1664525u32.wrapping_mul(seed).wrapping_add(1013904223)
}

/* This is a cos() approximation designed to be bit-exact on any platform. Bit exactness
with this approximation is important because it has an impact on the bit allocation */
pub fn bitexact_cos(x: i16) -> i16 {
    let tmp: i32 = (4096 + (x as i32) * (x as i32)) >> 13;
    debug_assert!(tmp <= 32767);
    let mut x2: i16 = tmp as i16;
    x2 = ((32767 - x2 as i32)
        + FRAC_MUL16(x2 as i32, -7651 + FRAC_MUL16(x2 as i32, 8277 + FRAC_MUL16(-626, x2 as i32))))
        as i16;
    debug_assert!(x2 <= 32766);
    (1 + x2 as i32) as i16
}

pub fn bitexact_log2tan(mut isin: i32, mut icos: i32) -> i32 {
    let lc = EC_ILOG(icos as u32);
    let ls = EC_ILOG(isin as u32);
    icos <<= 15 - lc;
    isin <<= 15 - ls;
    (ls - lc) * (1 << 11) + FRAC_MUL16(isin, FRAC_MUL16(isin, -2597) + 7932)
        - FRAC_MUL16(icos, FRAC_MUL16(icos, -2597) + 7932)
}

/// Compute the amplitude (sqrt energy) in each of the bands
pub fn compute_band_energies(m: &CELTMode, X: &[f32], bandE: &mut [f32], end: i32, C: i32, LM: i32) {
    let eBands = m.eBands;
    let N = m.shortMdctSize << LM;
    for c in 0..C {
        for i in 0..end as usize {
            let off = (c * N + ((eBands[i] as i32) << LM)) as usize;
            let len = ((eBands[i + 1] as i32) - (eBands[i] as i32)) << LM;
            let sum: f32 = 1e-27f32 + celt_inner_prod(&X[off..], &X[off..], len);
            bandE[i + (c * m.nbEBands) as usize] = celt_sqrt(sum);
        }
    }
}

/// Normalise each band such that the energy is one.
pub fn normalise_bands(m: &CELTMode, freq: &[f32], X: &mut [f32], bandE: &[f32], end: i32, C: i32, M: i32) {
    let eBands = m.eBands;
    let N = M * m.shortMdctSize;
    for c in 0..C {
        for i in 0..end as usize {
            let g: f32 = 1.0f32 / (1e-27f32 + bandE[i + (c * m.nbEBands) as usize]);
            for j in M * eBands[i] as i32..M * eBands[i + 1] as i32 {
                let k = (j + c * N) as usize;
                X[k] = freq[k] * g;
            }
        }
    }
}

/* Compute the weights to use for optimizing normalized distortion across
channels. We use the amplitude to weight square distortion, which means
that we use the square root of the value we would have been using if we
wanted to minimize the MSE in the non-normalized domain. This roughly
corresponds to some quick-and-dirty perceptual experiments I ran to
measure inter-aural masking (there doesn't seem to be any published data
on the topic). */
fn compute_channel_weights(mut Ex: f32, mut Ey: f32, w: &mut [f32; 2]) {
    let minE = MIN32(Ex, Ey);
    /* Adjustment to make the weights a bit more conservative. */
    Ex = Ex + minE / 3.0;
    Ey = Ey + minE / 3.0;
    w[0] = Ex;
    w[1] = Ey;
}

fn intensity_stereo(m: &CELTMode, X: &mut [f32], Y: &[f32], bandE: &[f32], bandID: i32, N: i32) {
    let i = bandID as usize;
    let left = bandE[i];
    let right = bandE[i + m.nbEBands as usize];
    let norm: f32 = super::arch::EPSILON + celt_sqrt(super::arch::EPSILON + left * left + right * right);
    let a1 = left / norm;
    let a2 = right / norm;
    for j in 0..N as usize {
        X[j] = a1 * X[j] + a2 * Y[j];
        /* Side is not encoded, no need to calculate */
    }
}

fn stereo_split(X: &mut [f32], Y: &mut [f32], N: i32) {
    for j in 0..N as usize {
        let l = 0.70710678f32 * X[j];
        let r = 0.70710678f32 * Y[j];
        X[j] = l + r;
        Y[j] = r - l;
    }
}

fn stereo_merge(X: &mut [f32], Y: &mut [f32], mid: f32, N: i32) {
    /* Compute the norm of X+Y and X-Y as |X|^2 + |Y|^2 +/- sum(xy) */
    let mut xp = celt_inner_prod(Y, X, N);
    let side = celt_inner_prod(Y, Y, N);
    /* Compensating for the mid normalization */
    xp = mid * xp;
    /* mid and side are in Q15, not Q14 like X and Y */
    let El = mid * mid + side - 2.0 * xp;
    let Er = mid * mid + side + 2.0 * xp;
    if Er < 6e-4f32 || El < 6e-4f32 {
        Y[..N as usize].copy_from_slice(&X[..N as usize]);
        return;
    }

    let lgain = super::mathops::celt_rsqrt_norm32(El);
    let rgain = super::mathops::celt_rsqrt_norm32(Er);

    for j in 0..N as usize {
        /* Apply mid scaling (side is already scaled) */
        let l = mid * X[j];
        let r = Y[j];
        X[j] = lgain * (l - r);
        Y[j] = rgain * (l + r);
    }
}

/// Decide whether we should spread the pulses in the current frame
pub fn spreading_decision(
    m: &CELTMode,
    X: &[f32],
    average: &mut i32,
    last_decision: i32,
    hf_average: &mut i32,
    tapset_decision: &mut i32,
    update_hf: i32,
    end: i32,
    C: i32,
    M: i32,
    spread_weight: &[i32],
) -> i32 {
    let mut sum: i32 = 0;
    let mut nbBands: i32 = 0;
    let eBands = m.eBands;
    let mut hf_sum: i32 = 0;

    debug_assert!(end > 0);

    let N0 = M * m.shortMdctSize;

    if M * (eBands[end as usize] as i32 - eBands[(end - 1) as usize] as i32) <= 8 {
        return SPREAD_NONE;
    }
    for c in 0..C {
        for i in 0..end as usize {
            let mut tcount = [0i32; 3];
            let x = &X[(M * eBands[i] as i32 + c * N0) as usize..];
            let N = M * (eBands[i + 1] as i32 - eBands[i] as i32);
            if N <= 8 {
                continue;
            }
            /* Compute rough CDF of |x[j]| */
            for j in 0..N as usize {
                let x2N: f32 = (x[j] * x[j]) * N as f32; /* Q13 */
                if x2N < 0.25f32 {
                    tcount[0] += 1;
                }
                if x2N < 0.0625f32 {
                    tcount[1] += 1;
                }
                if x2N < 0.015625f32 {
                    tcount[2] += 1;
                }
            }

            /* Only include four last bands (8 kHz and up) */
            if i as i32 > m.nbEBands - 4 {
                hf_sum += celt_udiv((32 * (tcount[1] + tcount[0])) as u32, N as u32) as i32;
            }
            let tmp = (2 * tcount[2] >= N) as i32 + (2 * tcount[1] >= N) as i32 + (2 * tcount[0] >= N) as i32;
            sum += tmp * spread_weight[i];
            nbBands += spread_weight[i];
        }
    }

    if update_hf != 0 {
        if hf_sum != 0 {
            hf_sum = celt_udiv(hf_sum as u32, (C * (4 - m.nbEBands + end)) as u32) as i32;
        }
        *hf_average = (*hf_average + hf_sum) >> 1;
        hf_sum = *hf_average;
        if *tapset_decision == 2 {
            hf_sum += 4;
        } else if *tapset_decision == 0 {
            hf_sum -= 4;
        }
        if hf_sum > 22 {
            *tapset_decision = 2;
        } else if hf_sum > 18 {
            *tapset_decision = 1;
        } else {
            *tapset_decision = 0;
        }
    }
    debug_assert!(nbBands > 0); /* end has to be non-zero */
    debug_assert!(sum >= 0);
    sum = celt_udiv((sum << 8) as u32, nbBands as u32) as i32;
    /* Recursive averaging */
    sum = (sum + *average) >> 1;
    *average = sum;
    /* Hysteresis */
    sum = (3 * sum + (((3 - last_decision) << 7) + 64) + 2) >> 2;
    if sum < 80 {
        SPREAD_AGGRESSIVE
    } else if sum < 256 {
        SPREAD_NORMAL
    } else if sum < 384 {
        SPREAD_LIGHT
    } else {
        SPREAD_NONE
    }
}

/* Indexing table for converting from natural Hadamard to ordery Hadamard
This is essentially a bit-reversed Gray, on top of which we've added
an inversion of the order because we want the DC at the end rather than
the beginning. The lines are for N=2, 4, 8, 16 */
static ordery_table: [i32; 30] = [
    1, 0, //
    3, 0, 2, 1, //
    7, 0, 4, 3, 6, 1, 5, 2, //
    15, 0, 8, 7, 12, 3, 11, 4, 14, 1, 9, 6, 13, 2, 10, 5,
];

fn deinterleave_hadamard(X: &mut [f32], N0: i32, stride: i32, hadamard: i32) {
    let st = stack::save();
    let N = (N0 * stride) as usize;
    let tmp = st.alloc::<f32>(N);
    debug_assert!(stride > 0);
    let (N0, stride) = (N0 as usize, stride as usize);
    if hadamard != 0 {
        let ordery = &ordery_table[stride - 2..];
        for i in 0..stride {
            for j in 0..N0 {
                tmp[ordery[i] as usize * N0 + j] = X[j * stride + i];
            }
        }
    } else {
        for i in 0..stride {
            for j in 0..N0 {
                tmp[i * N0 + j] = X[j * stride + i];
            }
        }
    }
    X[..N].copy_from_slice(tmp);
}

fn interleave_hadamard(X: &mut [f32], N0: i32, stride: i32, hadamard: i32) {
    let st = stack::save();
    let N = (N0 * stride) as usize;
    let tmp = st.alloc::<f32>(N);
    let (N0, stride) = (N0 as usize, stride as usize);
    if hadamard != 0 {
        let ordery = &ordery_table[stride - 2..];
        for i in 0..stride {
            for j in 0..N0 {
                tmp[j * stride + i] = X[ordery[i] as usize * N0 + j];
            }
        }
    } else {
        for i in 0..stride {
            for j in 0..N0 {
                tmp[j * stride + i] = X[i * N0 + j];
            }
        }
    }
    X[..N].copy_from_slice(tmp);
}

pub fn haar1(X: &mut [f32], mut N0: i32, stride: i32) {
    N0 >>= 1;
    let stride = stride as usize;
    for i in 0..stride {
        for j in 0..N0 as usize {
            let tmp1 = 0.70710678f32 * X[stride * 2 * j + i];
            let tmp2 = 0.70710678f32 * X[stride * (2 * j + 1) + i];
            X[stride * 2 * j + i] = tmp1 + tmp2;
            X[stride * (2 * j + 1) + i] = tmp1 - tmp2;
        }
    }
}

fn compute_qn(N: i32, b: i32, offset: i32, pulse_cap: i32, stereo: i32) -> i32 {
    static exp2_table8: [i16; 8] = [16384, 17866, 19483, 21247, 23170, 25267, 27554, 30048];
    let mut qn: i32;
    let mut qb: i32;
    let mut N2 = 2 * N - 1;
    if stereo != 0 && N == 2 {
        N2 -= 1;
    }
    /* The upper limit ensures that in a stereo split with itheta==16384, we'll
    always have enough bits left over to code at least one pulse in the
    side; otherwise it would collapse, since it doesn't get folded. */
    qb = celt_sudiv(b + N2 * offset, N2);
    qb = IMIN(b - pulse_cap - (4 << BITRES), qb);

    qb = IMIN(8 << BITRES, qb);

    if qb < (1 << BITRES >> 1) {
        qn = 1;
    } else {
        qn = exp2_table8[(qb & 0x7) as usize] as i32 >> (14 - (qb >> BITRES));
        qn = (qn + 1) >> 1 << 1;
    }
    debug_assert!(qn <= 256);
    qn
}

/// struct band_ctx (`arch` dropped; `encode` is always 1). Copied by value to save and
/// restore the state in the theta RDO.
#[derive(Clone, Copy)]
pub struct band_ctx<'a> {
    pub encode: i32,
    pub resynth: i32,
    pub m: &'a CELTMode,
    pub i: i32,
    pub intensity: i32,
    pub spread: i32,
    pub tf_change: i32,
    pub ec: *mut ec_ctx,
    pub remaining_bits: i32,
    pub bandE: &'a [f32],
    pub seed: u32,
    pub theta_round: i32,
    pub disable_inv: i32,
    pub avoid_split_noise: i32,
}

#[derive(Clone, Copy, Default)]
pub struct split_ctx {
    pub inv: i32,
    pub imid: i32,
    pub iside: i32,
    pub delta: i32,
    pub itheta: i32,
    pub qalloc: i32,
}

/// # Safety
/// `X` and `Y` must each be valid for `N` floats and not overlap; `ctx.ec` must be valid.
unsafe fn compute_theta(
    ctx: &mut band_ctx,
    sctx: &mut split_ctx,
    X: *mut f32,
    Y: *mut f32,
    N: i32,
    b: &mut i32,
    B: i32,
    B0: i32,
    LM: i32,
    stereo: i32,
    fill: &mut i32,
) {
    let mut itheta: i32;
    let delta: i32;
    let imid: i32;
    let iside: i32;
    let mut inv: i32 = 0;

    let m = ctx.m;
    let i = ctx.i;
    let intensity = ctx.intensity;
    let ec = unsafe { &mut *ctx.ec };
    let bandE = ctx.bandE;

    /* Decide on the resolution to give to the split parameter theta */
    let pulse_cap = m.logN[i as usize] as i32 + LM * (1 << BITRES);
    let offset =
        (pulse_cap >> 1) - if stereo != 0 && N == 2 { QTHETA_OFFSET_TWOPHASE } else { QTHETA_OFFSET };
    let mut qn = compute_qn(N, *b, offset, pulse_cap, stereo);
    if stereo != 0 && i >= intensity {
        qn = 1;
    }
    /* theta is the atan() of the ratio between the (normalized)
    side and mid. With just that parameter, we can re-scale both
    mid and side because we know that 1) they have unit norm and
    2) they are orthogonal. */
    let itheta_q30 = unsafe { stereo_itheta(slice(X, N), slice(Y, N), stereo, N) };
    itheta = itheta_q30 >> 16;
    let tell = ec_tell_frac(ec) as i32;
    if qn != 1 {
        if stereo == 0 || ctx.theta_round == 0 {
            itheta = (itheta * qn + 8192) >> 14;
            if stereo == 0 && ctx.avoid_split_noise != 0 && itheta > 0 && itheta < qn {
                /* Check if the selected value of theta will cause the bit allocation
                to inject noise on one side. If so, make sure the energy of that side
                is zero. */
                let unquantized = celt_udiv((itheta * 16384) as u32, qn as u32) as i32;
                let imid = bitexact_cos(unquantized as i16) as i32;
                let iside = bitexact_cos((16384 - unquantized) as i16) as i32;
                let delta = FRAC_MUL16((N - 1) << 7, bitexact_log2tan(iside, imid));
                if delta > *b {
                    itheta = qn;
                } else if delta < -*b {
                    itheta = 0;
                }
            }
        } else {
            /* Bias quantization towards itheta=0 and itheta=16384. */
            let bias = if itheta > 8192 { 32767 / qn } else { -32767 / qn };
            let down = IMIN(qn - 1, IMAX(0, (itheta * qn + bias) >> 14));
            if ctx.theta_round < 0 {
                itheta = down;
            } else {
                itheta = down + 1;
            }
        }
        /* Entropy coding of the angle. We use a uniform pdf for the
        time split, a step for stereo, and a triangular one for the rest. */
        if stereo != 0 && N > 2 {
            let p0 = 3;
            let x = itheta;
            let x0 = qn / 2;
            let ft = p0 * (x0 + 1) + x0;
            /* Use a probability of p0 up to itheta=8192 and then use 1 after */
            ec_encode(
                ec,
                (if x <= x0 { p0 * x } else { (x - 1 - x0) + (x0 + 1) * p0 }) as u32,
                (if x <= x0 { p0 * (x + 1) } else { (x - x0) + (x0 + 1) * p0 }) as u32,
                ft as u32,
            );
        } else if B0 > 1 || stereo != 0 {
            /* Uniform pdf */
            ec_enc_uint(ec, itheta as u32, (qn + 1) as u32);
        } else {
            let ft = ((qn >> 1) + 1) * ((qn >> 1) + 1);
            let fs = if itheta <= (qn >> 1) { itheta + 1 } else { qn + 1 - itheta };
            let fl = if itheta <= (qn >> 1) {
                itheta * (itheta + 1) >> 1
            } else {
                ft - ((qn + 1 - itheta) * (qn + 2 - itheta) >> 1)
            };
            ec_encode(ec, fl as u32, (fl + fs) as u32, ft as u32);
        }
        debug_assert!(itheta >= 0);
        itheta = celt_udiv((itheta * 16384) as u32, qn as u32) as i32;
        if stereo != 0 {
            unsafe {
                if itheta == 0 {
                    intensity_stereo(m, slice_mut(X, N), slice(Y, N), bandE, i, N);
                } else {
                    stereo_split(slice_mut(X, N), slice_mut(Y, N), N);
                }
            }
        }
        /* NOTE: Renormalising X and Y *may* help fixed-point a bit at very high rate.
        Let's do that at higher complexity */
    } else if stereo != 0 {
        inv = (itheta > 8192 && ctx.disable_inv == 0) as i32;
        if inv != 0 {
            for j in 0..N as usize {
                unsafe { *Y.add(j) = -*Y.add(j) };
            }
        }
        unsafe { intensity_stereo(m, slice_mut(X, N), slice(Y, N), bandE, i, N) };
        if *b > 2 << BITRES && ctx.remaining_bits > 2 << BITRES {
            ec_enc_bit_logp(ec, inv, 2);
        } else {
            inv = 0;
        }
        /* inv flag override to avoid problems with downmixing. */
        if ctx.disable_inv != 0 {
            inv = 0;
        }
        itheta = 0;
    }
    let qalloc = ec_tell_frac(ec) as i32 - tell;
    *b -= qalloc;

    if itheta == 0 {
        imid = 32767;
        iside = 0;
        *fill &= (1 << B) - 1;
        delta = -16384;
    } else if itheta == 16384 {
        imid = 0;
        iside = 32767;
        *fill &= ((1 << B) - 1) << B;
        delta = 16384;
    } else {
        imid = bitexact_cos(itheta as i16) as i32;
        iside = bitexact_cos((16384 - itheta) as i16) as i32;
        /* This is the mid vs side allocation that minimizes squared error
        in that band. */
        delta = FRAC_MUL16((N - 1) << 7, bitexact_log2tan(iside, imid));
    }

    sctx.inv = inv;
    sctx.imid = imid;
    sctx.iside = iside;
    sctx.delta = delta;
    sctx.itheta = itheta;
    sctx.qalloc = qalloc;
}

/// # Safety
/// `X`, and `Y` and `lowband_out` when non-null, must be valid for one float; `ctx.ec` valid.
unsafe fn quant_band_n1(ctx: &mut band_ctx, X: *mut f32, Y: *mut f32, lowband_out: *mut f32) -> u32 {
    let mut x = X;
    let ec = unsafe { &mut *ctx.ec };

    let stereo = !Y.is_null() as i32;
    for _c in 0..1 + stereo {
        let mut sign = 0;
        if ctx.remaining_bits >= 1 << BITRES {
            sign = unsafe { (*x < 0.0) as i32 };
            ec_enc_bits(ec, sign as u32, 1);
            ctx.remaining_bits -= 1 << BITRES;
        }
        if ctx.resynth != 0 {
            unsafe { *x = if sign != 0 { -1.0 } else { 1.0 } };
        }
        x = Y;
    }
    if !lowband_out.is_null() {
        unsafe { *lowband_out = *X };
    }
    1
}

/* This function is responsible for encoding and decoding a mono partition.
It can split the band in two and transmit the energy difference with
the two half-bands. It can be called recursively so bands can end up being
split in 8 parts. */
/// # Safety
/// `X` must be valid for `N` floats, `lowband` (if non-null) for `N` floats, not overlapping X.
unsafe fn quant_partition(
    ctx: &mut band_ctx,
    X: *mut f32,
    mut N: i32,
    mut b: i32,
    mut B: i32,
    lowband: *mut f32,
    mut LM: i32,
    gain: f32,
    mut fill: i32,
) -> u32 {
    let B0 = B;
    let mut cm: u32 = 0;

    let m = ctx.m;
    let i = ctx.i;
    let spread = ctx.spread;

    /* If we need 1.5 more bit than we can produce, split the band in two. */
    let cache_off = m.cache.index[((LM + 1) * m.nbEBands + i) as usize] as i32;
    if LM != -1 && {
        debug_assert!(cache_off >= 0);
        let cache = &m.cache.bits[cache_off as usize..];
        b > cache[cache[0] as usize] as i32 + 12
    } && N > 2
    {
        let mut sctx = split_ctx::default();
        let mut next_lowband2: *mut f32 = ptr::null_mut();

        N >>= 1;
        let Y = unsafe { X.add(N as usize) };
        LM -= 1;
        if B == 1 {
            fill = (fill & 1) | (fill << 1);
        }
        B = (B + 1) >> 1;

        unsafe { compute_theta(ctx, &mut sctx, X, Y, N, &mut b, B, B0, LM, 0, &mut fill) };
        let imid = sctx.imid;
        let iside = sctx.iside;
        let mut delta = sctx.delta;
        let itheta = sctx.itheta;
        let qalloc = sctx.qalloc;
        let mid: f32 = (1.0f32 / 32768.0) * imid as f32;
        let side: f32 = (1.0f32 / 32768.0) * iside as f32;

        /* Give more bits to low-energy MDCTs than they would otherwise deserve */
        if B0 > 1 && (itheta & 0x3fff) != 0 {
            if itheta > 8192 {
                /* Rough approximation for pre-echo masking */
                delta -= delta >> (4 - LM);
            } else {
                /* Corresponds to a forward-masking slope of 1.5 dB per 10 ms */
                delta = IMIN(0, delta + (N << BITRES >> (5 - LM)));
            }
        }
        let mut mbits = IMAX(0, IMIN(b, (b - delta) / 2));
        let mut sbits = b - mbits;
        ctx.remaining_bits -= qalloc;

        if !lowband.is_null() {
            next_lowband2 = unsafe { lowband.add(N as usize) }; /* >32-bit split case */
        }

        let mut rebalance = ctx.remaining_bits;
        unsafe {
            if mbits >= sbits {
                cm = quant_partition(ctx, X, N, mbits, B, lowband, LM, gain * mid, fill);
                rebalance = mbits - (rebalance - ctx.remaining_bits);
                if rebalance > 3 << BITRES && itheta != 0 {
                    sbits += rebalance - (3 << BITRES);
                }
                cm |= quant_partition(ctx, Y, N, sbits, B, next_lowband2, LM, gain * side, fill >> B) << (B0 >> 1);
            } else {
                cm = quant_partition(ctx, Y, N, sbits, B, next_lowband2, LM, gain * side, fill >> B) << (B0 >> 1);
                rebalance = sbits - (rebalance - ctx.remaining_bits);
                if rebalance > 3 << BITRES && itheta != 16384 {
                    mbits += rebalance - (3 << BITRES);
                }
                cm |= quant_partition(ctx, X, N, mbits, B, lowband, LM, gain * mid, fill);
            }
        }
    } else {
        /* This is the basic no-split case */
        let mut q = bits2pulses(m, i, LM, b);
        let mut curr_bits = pulses2bits(m, i, LM, q);
        ctx.remaining_bits -= curr_bits;

        /* Ensures we can never bust the budget */
        while ctx.remaining_bits < 0 && q > 0 {
            ctx.remaining_bits += curr_bits;
            q -= 1;
            curr_bits = pulses2bits(m, i, LM, q);
            ctx.remaining_bits -= curr_bits;
        }

        if q != 0 {
            let K = get_pulses(q);

            /* Finally do the actual quantization */
            cm = unsafe { alg_quant(slice_mut(X, N), N, K, spread, B, &mut *ctx.ec, gain, ctx.resynth) };
        } else {
            /* If there's no pulse, fill the band anyway */
            if ctx.resynth != 0 {
                /* B can be as large as 16, so this shift might overflow an int on a
                16-bit platform; use a long to get defined behavior.*/
                let cm_mask: u32 = (1u32 << B) - 1;
                fill = (fill as u32 & cm_mask) as i32;
                let x = unsafe { slice_mut(X, N) };
                if fill == 0 {
                    x.fill(0.0);
                } else {
                    if lowband.is_null() {
                        /* Noise */
                        for j in 0..N as usize {
                            ctx.seed = celt_lcg_rand(ctx.seed);
                            x[j] = ((ctx.seed as i32) >> 20) as f32;
                        }
                        cm = cm_mask;
                    } else {
                        /* Folded spectrum */
                        for j in 0..N as usize {
                            ctx.seed = celt_lcg_rand(ctx.seed);
                            /* About 48 dB below the "normal" folding level */
                            let mut tmp: f32 = 1.0f32 / 256.0;
                            tmp = if (ctx.seed) & 0x8000 != 0 { tmp } else { -tmp };
                            x[j] = unsafe { *lowband.add(j) } + tmp;
                        }
                        cm = fill as u32;
                    }
                    renormalise_vector(x, N, gain);
                }
            }
        }
    }

    cm
}

/* This function is responsible for encoding and decoding a band for the mono case. */
/// # Safety
/// `X` valid for `N` floats; `lowband`, `lowband_out`, `lowband_scratch` (each nullable) valid
/// for `N` floats; `lowband_scratch` must not overlap `X` or `lowband`.
unsafe fn quant_band(
    ctx: &mut band_ctx,
    X: *mut f32,
    N: i32,
    b: i32,
    mut B: i32,
    mut lowband: *mut f32,
    LM: i32,
    lowband_out: *mut f32,
    gain: f32,
    lowband_scratch: *mut f32,
    mut fill: i32,
) -> u32 {
    let N0 = N;
    let mut N_B = N;
    let N_B0: i32;
    let mut B0 = B;
    let mut time_divide = 0;
    let mut recombine = 0;
    let mut cm: u32;

    let mut tf_change = ctx.tf_change;

    let longBlocks = (B0 == 1) as i32;

    N_B = celt_udiv(N_B as u32, B as u32) as i32;

    /* Special case for one sample */
    if N == 1 {
        return unsafe { quant_band_n1(ctx, X, ptr::null_mut(), lowband_out) };
    }

    if tf_change > 0 {
        recombine = tf_change;
    }
    /* Band recombining to increase frequency resolution */

    if !lowband_scratch.is_null()
        && !lowband.is_null()
        && (recombine != 0 || ((N_B & 1) == 0 && tf_change < 0) || B0 > 1)
    {
        unsafe { ptr::copy(lowband, lowband_scratch, N as usize) };
        lowband = lowband_scratch;
    }

    for k in 0..recombine {
        static bit_interleave_table: [u8; 16] = [0, 1, 1, 1, 2, 3, 3, 3, 2, 3, 3, 3, 2, 3, 3, 3];
        unsafe {
            haar1(slice_mut(X, N), N >> k, 1 << k);
            if !lowband.is_null() {
                haar1(slice_mut(lowband, N), N >> k, 1 << k);
            }
        }
        fill = bit_interleave_table[(fill & 0xF) as usize] as i32
            | (bit_interleave_table[(fill >> 4) as usize] as i32) << 2;
    }
    B >>= recombine;
    N_B <<= recombine;

    /* Increasing the time resolution */
    while (N_B & 1) == 0 && tf_change < 0 {
        unsafe {
            haar1(slice_mut(X, N), N_B, B);
            if !lowband.is_null() {
                haar1(slice_mut(lowband, N), N_B, B);
            }
        }
        fill |= fill << B;
        B <<= 1;
        N_B >>= 1;
        time_divide += 1;
        tf_change += 1;
    }
    B0 = B;
    N_B0 = N_B;

    /* Reorganize the samples in time order instead of frequency order */
    if B0 > 1 {
        unsafe {
            deinterleave_hadamard(slice_mut(X, N), N_B >> recombine, B0 << recombine, longBlocks);
            if !lowband.is_null() {
                deinterleave_hadamard(slice_mut(lowband, N), N_B >> recombine, B0 << recombine, longBlocks);
            }
        }
    }

    cm = unsafe { quant_partition(ctx, X, N, b, B, lowband, LM, gain, fill) };

    /* This code is used by the decoder and by the resynthesis-enabled encoder */
    if ctx.resynth != 0 {
        let x = unsafe { slice_mut(X, N) };
        /* Undo the sample reorganization going from time order to frequency order */
        if B0 > 1 {
            interleave_hadamard(x, N_B >> recombine, B0 << recombine, longBlocks);
        }

        /* Undo time-freq changes that we did earlier */
        N_B = N_B0;
        B = B0;
        for _k in 0..time_divide {
            B >>= 1;
            N_B <<= 1;
            cm |= cm >> B;
            haar1(x, N_B, B);
        }

        for k in 0..recombine {
            static bit_deinterleave_table: [u8; 16] =
                [0x00, 0x03, 0x0C, 0x0F, 0x30, 0x33, 0x3C, 0x3F, 0xC0, 0xC3, 0xCC, 0xCF, 0xF0, 0xF3, 0xFC, 0xFF];
            cm = bit_deinterleave_table[cm as usize] as u32;
            haar1(x, N0 >> k, 1 << k);
        }
        B <<= recombine;

        /* Scale output for later folding */
        if !lowband_out.is_null() {
            let n: f32 = libm::sqrt(N0 as f64) as f32;
            for j in 0..N0 as usize {
                unsafe { *lowband_out.add(j) = n * x[j] };
            }
        }
        cm &= ((1 << B) - 1) as u32;
    }
    cm
}

const MIN_STEREO_ENERGY: f32 = 1e-10;

/* This function is responsible for encoding and decoding a band for the stereo case. */
/// # Safety
/// As `quant_band`, plus `Y` valid for `N` floats and disjoint from `X`.
unsafe fn quant_band_stereo(
    ctx: &mut band_ctx,
    X: *mut f32,
    Y: *mut f32,
    N: i32,
    mut b: i32,
    B: i32,
    lowband: *mut f32,
    LM: i32,
    lowband_out: *mut f32,
    lowband_scratch: *mut f32,
    mut fill: i32,
) -> u32 {
    let mut cm: u32;
    let mut mbits: i32;
    let mut sbits: i32;
    let mut sctx = split_ctx::default();

    /* Special case for one sample */
    if N == 1 {
        return unsafe { quant_band_n1(ctx, X, Y, lowband_out) };
    }

    let orig_fill = fill;

    {
        let (bi, bs) = (ctx.bandE[ctx.i as usize], ctx.bandE[(ctx.m.nbEBands + ctx.i) as usize]);
        if bi < MIN_STEREO_ENERGY || bs < MIN_STEREO_ENERGY {
            unsafe {
                if bi > bs {
                    ptr::copy(X, Y, N as usize);
                } else {
                    ptr::copy(Y, X, N as usize);
                }
            }
        }
    }
    unsafe { compute_theta(ctx, &mut sctx, X, Y, N, &mut b, B, B, LM, 1, &mut fill) };
    let inv = sctx.inv;
    let imid = sctx.imid;
    let iside = sctx.iside;
    let delta = sctx.delta;
    let itheta = sctx.itheta;
    let qalloc = sctx.qalloc;
    let mid: f32 = (1.0f32 / 32768.0) * imid as f32;
    let side: f32 = (1.0f32 / 32768.0) * iside as f32;

    /* This is a special case for N=2 that only works for stereo and takes
    advantage of the fact that mid and side are orthogonal to encode
    the side with just one bit. */
    if N == 2 {
        let mut sign = 0;
        mbits = b;
        sbits = 0;
        /* Only need one bit for the side. */
        if itheta != 0 && itheta != 16384 {
            sbits = 1 << BITRES;
        }
        mbits -= sbits;
        let c = itheta > 8192;
        ctx.remaining_bits -= qalloc + sbits;

        let x2 = if c { Y } else { X };
        let y2 = if c { X } else { Y };
        unsafe {
            if sbits != 0 {
                /* Here we only need to encode a sign for the side. */
                /* FIXME: Need to increase fixed-point precision? */
                sign = (*x2 * *y2.add(1) - *x2.add(1) * *y2 < 0.0) as i32;
                ec_enc_bits(&mut *ctx.ec, sign as u32, 1);
            }
            sign = 1 - 2 * sign;
            /* We use orig_fill here because we want to fold the side, but if
            itheta==16384, we'll have cleared the low bits of fill. */
            cm = quant_band(ctx, x2, N, mbits, B, lowband, LM, lowband_out, Q31ONE, lowband_scratch, orig_fill);
            /* We don't split N=2 bands, so cm is either 1 or 0 (for a fold-collapse),
            and there's no need to worry about mixing with the other channel. */
            *y2 = (-sign) as f32 * *x2.add(1);
            *y2.add(1) = sign as f32 * *x2;
            if ctx.resynth != 0 {
                *X = mid * *X;
                *X.add(1) = mid * *X.add(1);
                *Y = side * *Y;
                *Y.add(1) = side * *Y.add(1);
                let mut tmp = *X;
                *X = tmp - *Y;
                *Y = tmp + *Y;
                tmp = *X.add(1);
                *X.add(1) = tmp - *Y.add(1);
                *Y.add(1) = tmp + *Y.add(1);
            }
        }
    } else {
        /* "Normal" split code */
        mbits = IMAX(0, IMIN(b, (b - delta) / 2));
        sbits = b - mbits;
        ctx.remaining_bits -= qalloc;

        let mut rebalance = ctx.remaining_bits;
        let null = ptr::null_mut();
        unsafe {
            if mbits >= sbits {
                /* In stereo mode, we do not apply a scaling to the mid because we need the normalized
                mid for folding later. */
                cm = quant_band(ctx, X, N, mbits, B, lowband, LM, lowband_out, Q31ONE, lowband_scratch, fill);
                rebalance = mbits - (rebalance - ctx.remaining_bits);
                if rebalance > 3 << BITRES && itheta != 0 {
                    sbits += rebalance - (3 << BITRES);
                }
                /* For a stereo split, the high bits of fill are always zero, so no
                folding will be done to the side. */
                cm |= quant_band(ctx, Y, N, sbits, B, null, LM, null, side, null, fill >> B);
            } else {
                /* For a stereo split, the high bits of fill are always zero, so no
                folding will be done to the side. */
                cm = quant_band(ctx, Y, N, sbits, B, null, LM, null, side, null, fill >> B);
                rebalance = sbits - (rebalance - ctx.remaining_bits);
                if rebalance > 3 << BITRES && itheta != 16384 {
                    mbits += rebalance - (3 << BITRES);
                }
                /* In stereo mode, we do not apply a scaling to the mid because we need the normalized
                mid for folding later. */
                cm |= quant_band(ctx, X, N, mbits, B, lowband, LM, lowband_out, Q31ONE, lowband_scratch, fill);
            }
        }
    }

    /* This code is used by the decoder and by the resynthesis-enabled encoder */
    if ctx.resynth != 0 {
        unsafe {
            if N != 2 {
                stereo_merge(slice_mut(X, N), slice_mut(Y, N), mid, N);
            }
            if inv != 0 {
                for j in 0..N as usize {
                    *Y.add(j) = -*Y.add(j);
                }
            }
        }
    }
    cm
}

/// # Safety
/// `norm` (and `norm2` if `dual_stereo`) valid for `M*eBands[start+2]` floats.
unsafe fn special_hybrid_folding(m: &CELTMode, norm: *mut f32, norm2: *mut f32, start: i32, M: i32, dual_stereo: i32) {
    let eBands = m.eBands;
    let s = start as usize;
    let n1 = M * (eBands[s + 1] as i32 - eBands[s] as i32);
    let n2 = M * (eBands[s + 2] as i32 - eBands[s + 1] as i32);
    /* Duplicate enough of the first band folding data to be able to fold the second band.
    Copies no data for CELT-only mode. */
    debug_assert!(n2 - n1 >= 0);
    unsafe {
        ptr::copy(norm.add((2 * n1 - n2) as usize), norm.add(n1 as usize), (n2 - n1) as usize);
        if dual_stereo != 0 {
            ptr::copy(norm2.add((2 * n1 - n2) as usize), norm2.add(n1 as usize), (n2 - n1) as usize);
        }
    }
}

/// Quantisation/encoding of the residual spectrum (`encode` = 1).
///
/// `X_` and `Y_` are the two channels of the normalised spectrum (in C, `X` and `X+N` of one
/// buffer); each must hold at least `M*eBands[end]` values. `Y_` is `None` for mono.
pub fn quant_all_bands(
    m: &CELTMode,
    start: i32,
    end: i32,
    X_: &mut [f32],
    Y_: Option<&mut [f32]>,
    collapse_masks: &mut [u8],
    bandE: &[f32],
    pulses: &[i32],
    shortBlocks: i32,
    spread: i32,
    mut dual_stereo: i32,
    intensity: i32,
    tf_res: &[i32],
    total_bits: i32,
    mut balance: i32,
    ec: &mut ec_ctx,
    LM: i32,
    codedBands: i32,
    seed: &mut u32,
    complexity: i32,
    disable_inv: i32,
) {
    let eBands = m.eBands;
    let eb = |k: i32| eBands[k as usize] as i32;
    let nb = m.nbEBands;
    let mut update_lowband = 1;
    let C: i32 = if Y_.is_some() { 2 } else { 1 };
    let theta_rdo = Y_.is_some() && dual_stereo == 0 && complexity >= 8;
    let resynth = theta_rdo;

    let M = 1 << LM;
    assert!(X_.len() >= (M * eb(end)) as usize);
    assert!(collapse_masks.len() >= (C * end) as usize);
    let X_p: *mut f32 = X_.as_mut_ptr();
    let Y_p: *mut f32 = match Y_ {
        Some(y) => {
            assert!(y.len() >= (M * eb(end)) as usize);
            y.as_mut_ptr()
        }
        None => ptr::null_mut(),
    };
    // Only the raw pointer is used from here on (ctx holds a copy).
    let ec: *mut ec_ctx = ec;

    let st = stack::save();
    let B = if shortBlocks != 0 { M } else { 1 };
    let norm_offset = M * eb(start);
    /* No need to allocate norm for the last band because we don't need an
    output in that band. */
    let _norm = st.alloc::<f32>((C * (M * eb(nb - 1) - norm_offset)) as usize);
    let norm: *mut f32 = _norm.as_mut_ptr();
    let norm2: *mut f32 = norm.wrapping_add((M * eb(nb - 1) - norm_offset) as usize);

    /* For decoding, we can use the last band as scratch space because we don't need that
    scratch space for the last band and we don't care about the data there until we're
    decoding the last band. */
    let resynth_alloc = if resynth { (M * (eb(nb) - eb(nb - 1))) as usize } else { 0 };
    let _lowband_scratch = st.alloc::<f32>(resynth_alloc);
    let mut lowband_scratch: *mut f32 = if resynth {
        _lowband_scratch.as_mut_ptr()
    } else {
        X_p.wrapping_add((M * eb(m.effEBands - 1)) as usize)
    };
    let X_save = st.alloc::<f32>(resynth_alloc);
    let Y_save = st.alloc::<f32>(resynth_alloc);
    let X_save2 = st.alloc::<f32>(resynth_alloc);
    let Y_save2 = st.alloc::<f32>(resynth_alloc);
    let norm_save2 = st.alloc::<f32>(resynth_alloc);

    let mut lowband_offset = 0;
    let mut ctx = band_ctx {
        encode: 1,
        resynth: resynth as i32,
        m,
        i: 0,
        intensity,
        spread,
        tf_change: 0,
        ec,
        remaining_bits: 0,
        bandE,
        seed: *seed,
        theta_round: 0,
        disable_inv,
        /* Avoid injecting noise in the first band on transients. */
        avoid_split_noise: (B > 1) as i32,
    };
    let bytes_save = st.alloc::<u8>(if theta_rdo { 1275 } else { 0 });

    for i in start..end {
        let mut effective_lowband: i32 = -1;
        let mut x_cm: u32;
        let mut y_cm: u32;

        ctx.i = i;
        let last = i == end - 1;

        let mut X = X_p.wrapping_add((M * eb(i)) as usize);
        let mut Y = if !Y_p.is_null() { Y_p.wrapping_add((M * eb(i)) as usize) } else { ptr::null_mut() };
        let N = M * eb(i + 1) - M * eb(i);
        debug_assert!(N > 0);
        let tell = unsafe { ec_tell_frac(&*ec) } as i32;

        /* Compute how many bits we want to allocate to this band */
        if i != start {
            balance -= tell;
        }
        let remaining_bits = total_bits - tell - 1;
        ctx.remaining_bits = remaining_bits;
        let b = if i <= codedBands - 1 {
            let curr_balance = celt_sudiv(balance, IMIN(3, codedBands - i));
            IMAX(0, IMIN(16383, IMIN(remaining_bits + 1, pulses[i as usize] + curr_balance)))
        } else {
            0
        };

        if resynth && (M * eb(i) - N >= M * eb(start) || i == start + 1) && (update_lowband != 0 || lowband_offset == 0)
        {
            lowband_offset = i;
        }
        if i == start + 1 {
            unsafe { special_hybrid_folding(m, norm, norm2, start, M, dual_stereo) };
        }

        let tf_change = tf_res[i as usize];
        ctx.tf_change = tf_change;
        if i >= m.effEBands {
            X = norm;
            if !Y_p.is_null() {
                Y = norm;
            }
            lowband_scratch = ptr::null_mut();
        }
        if last && !theta_rdo {
            lowband_scratch = ptr::null_mut();
        }

        /* Get a conservative estimate of the collapse_mask's for the bands we're
        going to be folding from. */
        if lowband_offset != 0 && (spread != SPREAD_AGGRESSIVE || B > 1 || tf_change < 0) {
            /* This ensures we never repeat spectral content within one band */
            effective_lowband = IMAX(0, M * eb(lowband_offset) - norm_offset - N);
            let mut fold_start = lowband_offset;
            loop {
                fold_start -= 1;
                if !(M * eb(fold_start) > effective_lowband + norm_offset) {
                    break;
                }
            }
            let mut fold_end = lowband_offset - 1;
            loop {
                fold_end += 1;
                if !(fold_end < i && M * eb(fold_end) < effective_lowband + norm_offset + N) {
                    break;
                }
            }
            x_cm = 0;
            y_cm = 0;
            let mut fold_i = fold_start;
            loop {
                x_cm |= collapse_masks[(fold_i * C + 0) as usize] as u32;
                y_cm |= collapse_masks[(fold_i * C + C - 1) as usize] as u32;
                fold_i += 1;
                if fold_i >= fold_end {
                    break;
                }
            }
        }
        /* Otherwise, we'll be using the LCG to fold, so all blocks will (almost
        always) be non-zero. */
        else {
            x_cm = ((1 << B) - 1) as u32;
            y_cm = x_cm;
        }

        if dual_stereo != 0 && i == intensity {
            /* Switch off dual stereo to do intensity. */
            dual_stereo = 0;
            if resynth {
                for j in 0..(M * eb(i) - norm_offset) as usize {
                    unsafe { *norm.add(j) = 0.5f32 * (*norm.add(j) + *norm2.add(j)) };
                }
            }
        }
        let lowband = |n: *mut f32| {
            if effective_lowband != -1 { n.wrapping_add(effective_lowband as usize) } else { ptr::null_mut() }
        };
        let lowband_out = |n: *mut f32| {
            if last { ptr::null_mut() } else { n.wrapping_add((M * eb(i) - norm_offset) as usize) }
        };
        unsafe {
            if dual_stereo != 0 {
                x_cm = quant_band(&mut ctx, X, N, b / 2, B, lowband(norm), LM, lowband_out(norm), Q31ONE,
                    lowband_scratch, x_cm as i32);
                y_cm = quant_band(&mut ctx, Y, N, b / 2, B, lowband(norm2), LM, lowband_out(norm2), Q31ONE,
                    lowband_scratch, y_cm as i32);
            } else {
                if !Y.is_null() {
                    if theta_rdo && i < intensity {
                        let mut w = [0.0f32; 2];
                        compute_channel_weights(bandE[i as usize], bandE[(i + nb) as usize], &mut w);
                        /* Make a copy. */
                        let cm = x_cm | y_cm;
                        let ec_save: ec_ctx = *ec;
                        let ctx_save = ctx;
                        let n = N as usize;
                        X_save[..n].copy_from_slice(slice(X, N));
                        Y_save[..n].copy_from_slice(slice(Y, N));
                        /* Encode and round down. */
                        ctx.theta_round = -1;
                        x_cm = quant_band_stereo(&mut ctx, X, Y, N, b, B, lowband(norm), LM, lowband_out(norm),
                            lowband_scratch, cm as i32);
                        let dist0: f32 = w[0] * celt_inner_prod(X_save, slice(X, N), N)
                            + w[1] * celt_inner_prod(Y_save, slice(Y, N), N);

                        /* Save first result. */
                        let cm2 = x_cm;
                        let ec_save2: ec_ctx = *ec;
                        let ctx_save2 = ctx;
                        X_save2[..n].copy_from_slice(slice(X, N));
                        Y_save2[..n].copy_from_slice(slice(Y, N));
                        if !last {
                            norm_save2[..n].copy_from_slice(slice(lowband_out(norm), N));
                        }
                        let nstart_bytes = ec_save.offs as i32;
                        let nend_bytes = ec_save.storage as i32;
                        let bytes_buf = ec_save.buf.wrapping_add(nstart_bytes as usize);
                        let save_bytes = (nend_bytes - nstart_bytes) as usize;
                        ptr::copy_nonoverlapping(bytes_buf, bytes_save.as_mut_ptr(), save_bytes);
                        /* Restore */
                        *ec = ec_save;
                        ctx = ctx_save;
                        slice_mut(X, N).copy_from_slice(&X_save[..n]);
                        slice_mut(Y, N).copy_from_slice(&Y_save[..n]);
                        if i == start + 1 {
                            special_hybrid_folding(m, norm, norm2, start, M, dual_stereo);
                        }
                        /* Encode and round up. */
                        ctx.theta_round = 1;
                        x_cm = quant_band_stereo(&mut ctx, X, Y, N, b, B, lowband(norm), LM, lowband_out(norm),
                            lowband_scratch, cm as i32);
                        let dist1: f32 = w[0] * celt_inner_prod(X_save, slice(X, N), N)
                            + w[1] * celt_inner_prod(Y_save, slice(Y, N), N);
                        if dist0 >= dist1 {
                            x_cm = cm2;
                            *ec = ec_save2;
                            ctx = ctx_save2;
                            slice_mut(X, N).copy_from_slice(&X_save2[..n]);
                            slice_mut(Y, N).copy_from_slice(&Y_save2[..n]);
                            if !last {
                                slice_mut(lowband_out(norm), N).copy_from_slice(&norm_save2[..n]);
                            }
                            ptr::copy_nonoverlapping(bytes_save.as_ptr(), bytes_buf, save_bytes);
                        }
                    } else {
                        ctx.theta_round = 0;
                        x_cm = quant_band_stereo(&mut ctx, X, Y, N, b, B, lowband(norm), LM, lowband_out(norm),
                            lowband_scratch, (x_cm | y_cm) as i32);
                    }
                } else {
                    x_cm = quant_band(&mut ctx, X, N, b, B, lowband(norm), LM, lowband_out(norm), Q31ONE,
                        lowband_scratch, (x_cm | y_cm) as i32);
                }
                y_cm = x_cm;
            }
        }
        collapse_masks[(i * C + 0) as usize] = x_cm as u8;
        collapse_masks[(i * C + C - 1) as usize] = y_cm as u8;
        balance += pulses[i as usize] + tell;

        /* Update the folding position only as long as we have 1 bit/sample depth. */
        update_lowband = (b > (N << BITRES)) as i32;
        /* We only need to avoid noise on a split for the first band. After that, we
        have folding. */
        ctx.avoid_split_noise = 0;
    }
    *seed = ctx.seed;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::celt::celt::init_caps;
    use crate::celt::entcode::ec_enc;
    use crate::celt::entenc::{ec_enc_done, ec_enc_init};
    use crate::celt::modes::mode48000_960_120 as MODE;
    use crate::celt::rate::clt_compute_allocation;
    use crate::testutil::{Rng, music, same_enc};
    use core::ffi::c_void;
    use minicelt_oracle as c;
    use std::vec;
    use std::vec::Vec;

    const NB: usize = 21;

    fn bits(v: &[f32]) -> Vec<u32> {
        v.iter().map(|x| x.to_bits()).collect()
    }

    fn eb(i: i32) -> i32 {
        MODE.eBands[i as usize] as i32
    }

    fn unit_vec(rng: &mut Rng, n: usize) -> Vec<f32> {
        let mut v = rng.f32_vec(n, 1.0);
        if rng.range(0, 4) == 0 {
            for x in v.iter_mut() {
                if rng.range(0, 3) != 0 {
                    *x = 0.0;
                }
            }
            v[0] += 0.01;
        }
        let e: f32 = v.iter().map(|x| x * x).sum::<f32>();
        let g = 1.0 / libm::sqrtf(e);
        v.iter_mut().for_each(|x| *x *= g);
        v
    }

    /// `struct band_ctx` as laid out by the C build (with `arch`; C mode and pointers).
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CBandCtx {
        encode: i32,
        resynth: i32,
        m: *const c_void,
        i: i32,
        intensity: i32,
        spread: i32,
        tf_change: i32,
        ec: *mut c_void,
        remaining_bits: i32,
        bandE: *const f32,
        seed: u32,
        arch: i32,
        theta_round: i32,
        disable_inv: i32,
        avoid_split_noise: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct CSplitCtx {
        inv: i32,
        imid: i32,
        iside: i32,
        delta: i32,
        itheta: i32,
        qalloc: i32,
    }

    #[test]
    fn c_band_ctx_layout() {
        let l = c::bands_layout();
        assert_eq!(l.get("struct band_ctx"), core::mem::size_of::<CBandCtx>());
        assert_eq!(l.get("struct band_ctx.ec"), core::mem::offset_of!(CBandCtx, ec));
        assert_eq!(l.get("struct band_ctx.seed"), core::mem::offset_of!(CBandCtx, seed));
        assert_eq!(l.get("struct band_ctx.avoid_split_noise"), core::mem::offset_of!(CBandCtx, avoid_split_noise));
        assert_eq!(l.get("struct split_ctx"), core::mem::size_of::<CSplitCtx>());
        assert_eq!(l.get("struct split_ctx.qalloc"), core::mem::offset_of!(CSplitCtx, qalloc));
    }

    /// Two range coders (Rust, C) on separate buffers of the same size and the same prefix.
    struct Coders {
        er: ec_enc,
        ec: ec_enc,
        br: Vec<u8>,
        bc: Vec<u8>,
    }

    impl Coders {
        fn new(rng: &mut Rng, size: usize) -> Box<Coders> {
            let mut k = Box::new(Coders {
                er: unsafe { core::mem::zeroed() },
                ec: unsafe { core::mem::zeroed() },
                br: vec![0; size],
                bc: vec![0; size],
            });
            ec_enc_init(&mut k.er, k.br.as_mut_ptr(), size as u32);
            unsafe { c::ec_enc_init(k.cptr(), k.bc.as_mut_ptr(), size as u32) };
            for _ in 0..rng.range(0, 6) {
                let ft = rng.range(2, 1000) as u32;
                let fl = rng.next_u32() % ft;
                crate::celt::entenc::ec_enc_uint(&mut k.er, fl, ft);
                unsafe { c::ec_enc_uint(k.cptr(), fl, ft) };
            }
            k
        }
        fn cptr(&mut self) -> *mut c_void {
            &mut self.ec as *mut ec_enc as *mut c_void
        }
        fn check(&mut self) {
            same_enc(&self.er, &self.ec);
            assert_eq!(self.br, self.bc);
            ec_enc_done(&mut self.er);
            unsafe { c::ec_enc_done(self.cptr()) };
            same_enc(&self.er, &self.ec);
            assert_eq!(self.br, self.bc);
        }
    }
    use std::boxed::Box;

    #[test]
    fn small_functions_match_c() {
        // celt_lcg_rand, bitexact_cos (whole valid domain), bitexact_log2tan (as used, plus random).
        let mut rng = Rng::new(10);
        for _ in 0..10000 {
            let s = rng.next_u32();
            assert_eq!(celt_lcg_rand(s), unsafe { c::celt_lcg_rand(s) });
        }
        // Domain: compute_theta passes 16384*k/qn with 0 < k < qn <= 256, i.e. [64, 16320]
        // (below 64, x2 would be 32767, which the C celt_sig_assert also rejects).
        for x in 64..=16383i32 {
            assert_eq!(bitexact_cos(x as i16), unsafe { c::bitexact_cos(x as i16) }, "{x}");
        }
        for x in 64..=16320i32 {
            let imid = bitexact_cos(x as i16) as i32;
            let iside = bitexact_cos((16384 - x) as i16) as i32;
            assert_eq!(bitexact_log2tan(iside, imid), unsafe { c::bitexact_log2tan(iside, imid) });
        }
        for _ in 0..200000 {
            let (a, b) = (rng.range(1, 32767), rng.range(1, 32767));
            assert_eq!(bitexact_log2tan(a, b), unsafe { c::bitexact_log2tan(a, b) });
        }
        // hysteresis_decision
        for _ in 0..20000 {
            let n = rng.range(1, 8);
            let mut th: Vec<f32> = (0..n).map(|_| rng.f32_unit() * 100.0).collect();
            th.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let hy: Vec<f32> = (0..n).map(|_| rng.f32_unit().abs() * 5.0).collect();
            let prev = rng.range(0, n);
            let val = rng.f32_unit() * 120.0;
            assert_eq!(hysteresis_decision(val, &th, &hy, n, prev), unsafe {
                c::hysteresis_decision(val, th.as_ptr(), hy.as_ptr(), n, prev)
            });
        }
        // compute_qn
        for _ in 0..100000 {
            let (n, b, off, cap, st) =
                (rng.range(1, 176), rng.range(0, 16383), rng.range(-40, 200), rng.range(0, 300), rng.range(0, 1));
            assert_eq!(compute_qn(n, b, off, cap, st), unsafe { c::oracle_compute_qn(n, b, off, cap, st) });
        }
        // compute_channel_weights
        for _ in 0..10000 {
            let (x, y) = (rng.f32_unit().abs() * 1e4, rng.f32_unit().abs() * 1e4);
            let mut w = [0.0f32; 2];
            let mut wc = [0.0f32; 2];
            compute_channel_weights(x, y, &mut w);
            unsafe { c::oracle_compute_channel_weights(x, y, wc.as_mut_ptr()) };
            assert_eq!(bits(&w), bits(&wc));
        }
    }

    #[test]
    fn vector_helpers_match_c() {
        let mut rng = Rng::new(11);
        let cm = crate::testutil::c_mode();
        for _ in 0..5000 {
            let n = rng.range(1, 176);
            let x = unit_vec(&mut rng, n as usize);
            let y = unit_vec(&mut rng, n as usize);
            let bande: Vec<f32> = (0..2 * NB).map(|_| rng.f32_unit().abs() * 1000.0).collect();
            let band = rng.range(0, 20);
            // intensity_stereo
            let (mut a, mut b) = (x.clone(), x.clone());
            intensity_stereo(&MODE, &mut a, &y, &bande, band, n);
            unsafe { c::oracle_intensity_stereo(cm, b.as_mut_ptr(), y.as_ptr(), bande.as_ptr(), band, n) };
            assert_eq!(bits(&a), bits(&b));
            // stereo_split
            let (mut a, mut ay, mut b, mut by) = (x.clone(), y.clone(), x.clone(), y.clone());
            stereo_split(&mut a, &mut ay, n);
            unsafe { c::oracle_stereo_split(b.as_mut_ptr(), by.as_mut_ptr(), n) };
            assert_eq!((bits(&a), bits(&ay)), (bits(&b), bits(&by)));
            // stereo_merge (sometimes nearly collinear so the early return triggers)
            let mid = if rng.range(0, 4) == 0 { 1.0 } else { rng.f32_unit().abs() };
            let mut yy = y.clone();
            if rng.range(0, 3) == 0 {
                yy = x.iter().map(|v| v * mid).collect();
            }
            let (mut a, mut ay, mut b, mut by) = (x.clone(), yy.clone(), x.clone(), yy.clone());
            stereo_merge(&mut a, &mut ay, mid, n);
            unsafe { c::oracle_stereo_merge(b.as_mut_ptr(), by.as_mut_ptr(), mid, n, 0) };
            assert_eq!((bits(&a), bits(&ay)), (bits(&b), bits(&by)));
            // haar1
            let stride = [1, 2, 4, 8][rng.range(0, 3) as usize];
            let n0 = 2 * rng.range(1, 20);
            let v = rng.f32_vec((n0 * stride) as usize, 1.0);
            let (mut a, mut b) = (v.clone(), v.clone());
            haar1(&mut a, n0, stride);
            unsafe { c::haar1(b.as_mut_ptr(), n0, stride) };
            assert_eq!(bits(&a), bits(&b));
            // (de)interleave_hadamard
            let stride = [2, 4, 8, 16][rng.range(0, 3) as usize];
            let n0 = rng.range(1, 20);
            let had = rng.range(0, 1);
            let v = rng.f32_vec((n0 * stride) as usize, 1.0);
            let (mut a, mut b) = (v.clone(), v.clone());
            deinterleave_hadamard(&mut a, n0, stride, had);
            unsafe { c::oracle_deinterleave_hadamard(b.as_mut_ptr(), n0, stride, had) };
            assert_eq!(bits(&a), bits(&b));
            interleave_hadamard(&mut a, n0, stride, had);
            unsafe { c::oracle_interleave_hadamard(b.as_mut_ptr(), n0, stride, had) };
            assert_eq!(bits(&a), bits(&b));
            assert_eq!(bits(&a), bits(&v));
        }
        // special_hybrid_folding (start values where the second band is not narrower)
        for start in 0..19 {
            for lm in 0..4 {
                let m = 1 << lm;
                if eb(start + 2) - eb(start + 1) < eb(start + 1) - eb(start) {
                    continue;
                }
                for dual in 0..2 {
                    let len = (2 * m * eb(21)) as usize;
                    let v = rng.f32_vec(len, 1.0);
                    let (mut a, mut b) = (v.clone(), v.clone());
                    let h = (m * eb(21)) as usize;
                    unsafe {
                        special_hybrid_folding(&MODE, a.as_mut_ptr(), a.as_mut_ptr().add(h), start, m, dual);
                        c::oracle_special_hybrid_folding(cm, b.as_mut_ptr(), b.as_mut_ptr().add(h), start, m, dual);
                    }
                    assert_eq!(bits(&a), bits(&b));
                }
            }
        }
    }

    /// MDCT spectrum (C*N, channel-major) of a music frame, from the C compute_mdcts.
    fn spectrum(frame: &[f32], ch: usize, lm: i32, short_blocks: i32) -> Vec<f32> {
        let n = (120 << lm) as usize;
        let mut inp = vec![0.0f32; ch * (n + 120)];
        for c in 0..ch {
            for j in 0..n + 120 {
                inp[c * (n + 120) + j] = frame[2 * j + c] * 32768.0;
            }
        }
        let mut out = vec![0.0f32; ch * n];
        unsafe {
            c::oracle_compute_mdcts(
                crate::testutil::c_mode(), short_blocks, inp.as_mut_ptr(), out.as_mut_ptr(), ch as i32, ch as i32, lm, 1, 0,
            )
        };
        out
    }

    fn music_frames() -> Vec<Vec<f32>> {
        let mut f = music(77, 24, 960 + 120, 2);
        let mut g = crate::testutil::MusicGen::new(78);
        g.gain = 0.002;
        g.hit_period = 3000;
        f.extend((0..8).map(|_| g.next_frame(960 + 120, 2)));
        f.extend(crate::testutil::noise(79, 4, 960 + 120, 2, 0.5));
        f
    }

    #[test]
    fn band_energies_and_spreading_match_c() {
        let cm = crate::testutil::c_mode();
        let frames = music_frames();
        let mut rng = Rng::new(12);
        for (k, f) in frames.iter().enumerate() {
            for lm in 0..4 {
                for ch in 1..=2usize {
                    let sb = if lm > 0 && k % 2 == 1 { 1 << lm } else { 0 };
                    let m = 1 << lm;
                    let freq = spectrum(f, ch, lm, sb);
                    let end = if k % 3 == 0 { rng.range(1, 21) } else { 21 };
                    let mut be = vec![0.0f32; ch * NB];
                    let mut bec = vec![0.0f32; ch * NB];
                    compute_band_energies(&MODE, &freq, &mut be, end, ch as i32, lm);
                    unsafe { c::compute_band_energies(cm, freq.as_ptr(), bec.as_mut_ptr(), end, ch as i32, lm, 0) };
                    assert_eq!(bits(&be), bits(&bec));
                    let mut x = vec![0.0f32; freq.len()];
                    let mut xc = x.clone();
                    normalise_bands(&MODE, &freq, &mut x, &be, end, ch as i32, m);
                    unsafe { c::normalise_bands(cm, freq.as_ptr(), xc.as_mut_ptr(), be.as_ptr(), end, ch as i32, m) };
                    assert_eq!(bits(&x), bits(&xc));
                    for _ in 0..4 {
                        let sw: Vec<i32> = (0..NB).map(|_| rng.range(1, 32)).collect();
                        let (mut avg, mut hf, mut tap) = (rng.range(0, 400), rng.range(0, 40), rng.range(0, 2));
                        let (mut avgc, mut hfc, mut tapc) = (avg, hf, tap);
                        let last = rng.range(0, 3);
                        let upd = rng.range(0, 1);
                        let r = spreading_decision(&MODE, &x, &mut avg, last, &mut hf, &mut tap, upd, end, ch as i32, m, &sw);
                        let rc = unsafe {
                            c::spreading_decision(cm, x.as_ptr(), &mut avgc, last, &mut hfc, &mut tapc, upd, end, ch as i32, m, sw.as_ptr())
                        };
                        assert_eq!((r, avg, hf, tap), (rc, avgc, hfc, tapc));
                    }
                }
            }
        }
    }

    /// Shared random setup for the band-level functions (quant_band, quant_partition, ...).
    struct BandCase {
        k: Box<Coders>,
        bande: Vec<f32>,
        rctx_seed: u32,
    }

    fn make_ctx<'a>(
        case: &'a mut BandCase, i: i32, resynth: i32, intensity: i32, spread: i32, tf_change: i32, remaining_bits: i32,
        theta_round: i32, disable_inv: i32, avoid: i32,
    ) -> (band_ctx<'a>, CBandCtx) {
        let cptr = case.k.cptr();
        let r = band_ctx {
            encode: 1,
            resynth,
            m: &MODE,
            i,
            intensity,
            spread,
            tf_change,
            ec: &mut case.k.er,
            remaining_bits,
            bandE: &case.bande,
            seed: case.rctx_seed,
            theta_round,
            disable_inv,
            avoid_split_noise: avoid,
        };
        let cc = CBandCtx {
            encode: 1,
            resynth,
            m: crate::testutil::c_mode(),
            i,
            intensity,
            spread,
            tf_change,
            ec: cptr,
            remaining_bits,
            bandE: case.bande.as_ptr(),
            seed: case.rctx_seed,
            arch: 0,
            theta_round,
            disable_inv,
            avoid_split_noise: avoid,
        };
        (r, cc)
    }

    fn tf_sel(lm: i32, idx: usize) -> i32 {
        unsafe { c::tf_select_table[lm as usize][idx] as i32 }
    }

    #[test]
    fn quant_band_functions_match_c() {
        let mut rng = Rng::new(13);
        for it in 0..20000 {
            let lm = if it % 4 == 0 { rng.range(0, 2) } else { 3 };
            let m = 1 << lm;
            let i = rng.range(0, 20);
            let n = m * (eb(i + 1) - eb(i));
            let transient = lm > 0 && rng.range(0, 1) == 0;
            let bb = if transient { m } else { 1 };
            let tf_change = tf_sel(lm, (4 * transient as i32 + rng.range(0, 3)) as usize);
            let stereo = rng.range(0, 1) == 1;
            let resynth = if stereo { rng.range(0, 1) } else { rng.range(0, 1) };
            let mut bande: Vec<f32> = (0..2 * NB).map(|_| rng.f32_unit().abs() * 1000.0).collect();
            if rng.range(0, 5) == 0 {
                bande[(i + rng.range(0, 1) * 21) as usize] = 1e-12;
            }
            let size = rng.range(20, 1275) as usize;
            let mut case = BandCase { k: Coders::new(&mut rng, size), bande, rctx_seed: rng.next_u32() };
            let b = match rng.range(0, 3) {
                0 => rng.range(0, 64),
                1 => rng.range(0, n * 16),
                _ => rng.range(0, (n * 64).min(16383)),
            };
            let remaining = b + rng.range(-20, 400);
            let fill = if rng.range(0, 2) == 0 { (1 << bb) - 1 } else { rng.range(0, (1 << bb) - 1) };
            let x = unit_vec(&mut rng, n as usize);
            let y = unit_vec(&mut rng, n as usize);
            let has_low = rng.range(0, 2) != 0;
            let low = unit_vec(&mut rng, n as usize);
            let intensity = rng.range(0, 21);
            let spread = rng.range(0, 3);
            let theta_round = rng.range(-1, 1);
            let disable_inv = rng.range(0, 1);
            let avoid = rng.range(0, 1);
            let gain = if rng.range(0, 1) == 0 { 1.0 } else { rng.f32_unit().abs() };
            let mut which = rng.range(0, 3);
            if n < 2 && which >= 2 {
                which = 0;
            }

            let (mut xr, mut yr, mut xc, mut yc) = (x.clone(), y.clone(), x.clone(), y.clone());
            let (mut lr, mut lc) = (low.clone(), low.clone());
            let (mut outr, mut outc) = (vec![0.0f32; n as usize], vec![0.0f32; n as usize]);
            let (mut scr, mut scc) = (vec![0.0f32; n as usize], vec![0.0f32; n as usize]);
            let lowr = if has_low { lr.as_mut_ptr() } else { ptr::null_mut() };
            let lowc = if has_low { lc.as_mut_ptr() } else { ptr::null_mut() };
            let (mut rc, mut cc) =
                make_ctx(&mut case, i, resynth, intensity, spread, tf_change, remaining, theta_round, disable_inv, avoid);
            let ccp = &mut cc as *mut CBandCtx as *mut c_void;
            let (cmr, cmc);
            unsafe {
                match which {
                    0 => {
                        cmr = quant_band(&mut rc, xr.as_mut_ptr(), n, b, bb, lowr, lm, outr.as_mut_ptr(), gain, scr.as_mut_ptr(), fill);
                        cmc = c::oracle_quant_band(ccp, xc.as_mut_ptr(), n, b, bb, lowc, lm, outc.as_mut_ptr(), gain, scc.as_mut_ptr(), fill);
                    }
                    1 => {
                        cmr = quant_band_stereo(&mut rc, xr.as_mut_ptr(), yr.as_mut_ptr(), n, b, bb, lowr, lm, outr.as_mut_ptr(), scr.as_mut_ptr(), fill);
                        cmc = c::oracle_quant_band_stereo(ccp, xc.as_mut_ptr(), yc.as_mut_ptr(), n, b, bb, lowc, lm, outc.as_mut_ptr(), scc.as_mut_ptr(), fill);
                    }
                    2 => {
                        cmr = quant_partition(&mut rc, xr.as_mut_ptr(), n, b, bb, lowr, lm, gain, fill);
                        cmc = c::oracle_quant_partition(ccp, xc.as_mut_ptr(), n, b, bb, lowc, lm, gain, fill);
                    }
                    _ => {
                        let st = rng.range(0, 1) == 1;
                        let mut sr = split_ctx::default();
                        let mut sc = CSplitCtx::default();
                        let (mut br_, mut bc_) = (b, b);
                        let (mut fr, mut fc) = (fill, fill);
                        let nn = if st { n } else { (n / 2).max(1) };
                        // Mono with qn == 1 leaves itheta unquantized (out of bitexact_cos's
                        // domain, UB in C's bitexact_log2tan); quant_partition never gets there.
                        let pulse_cap = MODE.logN[i as usize] as i32 + lm * 8;
                        let off = (pulse_cap >> 1) - if st && nn == 2 { 16 } else { 4 };
                        if !st && compute_qn(nn, b, off, pulse_cap, 0) == 1 {
                            continue;
                        }
                        let (pyr, pyc) = if st { (yr.as_mut_ptr(), yc.as_mut_ptr()) } else { (xr.as_mut_ptr().add(nn as usize), xc.as_mut_ptr().add(nn as usize)) };
                        compute_theta(&mut rc, &mut sr, xr.as_mut_ptr(), pyr, nn, &mut br_, bb, bb, lm, st as i32, &mut fr);
                        c::oracle_compute_theta(ccp, &mut sc as *mut CSplitCtx as *mut c_void, xc.as_mut_ptr(), pyc, nn, &mut bc_, bb, bb, lm, st as i32, &mut fc);
                        assert_eq!(
                            (sr.inv, sr.imid, sr.iside, sr.delta, sr.itheta, sr.qalloc, br_, fr),
                            (sc.inv, sc.imid, sc.iside, sc.delta, sc.itheta, sc.qalloc, bc_, fc)
                        );
                        cmr = 0;
                        cmc = 0;
                    }
                }
            }
            let ctx_info = (rc.remaining_bits, rc.seed);
            let msg = format_args!("it {it} which {which} i {i} lm {lm} n {n} b {b} B {bb} tf {tf_change} resynth {resynth}").to_string();
            assert_eq!(cmr, cmc, "{msg}");
            assert_eq!(ctx_info, (cc.remaining_bits, cc.seed), "{msg}");
            assert_eq!(bits(&xr), bits(&xc), "{msg}");
            assert_eq!(bits(&yr), bits(&yc), "{msg}");
            assert_eq!(bits(&lr), bits(&lc), "{msg}");
            assert_eq!(bits(&outr), bits(&outc), "{msg}");
            assert_eq!(bits(&scr), bits(&scc), "{msg}");
            case.k.check();
        }
    }

    #[test]
    fn quant_band_n1_matches_c() {
        let mut rng = Rng::new(14);
        for _ in 0..2000 {
            let mut case = BandCase { k: Coders::new(&mut rng, 50), bande: vec![1.0; 2 * NB], rctx_seed: 1 };
            let rem = rng.range(-5, 20);
            let resynth = rng.range(0, 1);
            let stereo = rng.range(0, 1) == 1;
            let (mut x, mut y) = ([rng.f32_unit()], [rng.f32_unit()]);
            let (mut xc, mut yc) = (x, y);
            let (mut o, mut oc) = ([0.0f32], [0.0f32]);
            let (mut rc, mut cc) = make_ctx(&mut case, 0, resynth, 0, 0, 0, rem, 0, 0, 0);
            let (a, b) = unsafe {
                (
                    quant_band_n1(&mut rc, x.as_mut_ptr(), if stereo { y.as_mut_ptr() } else { ptr::null_mut() }, o.as_mut_ptr()),
                    c::oracle_quant_band_n1(&mut cc as *mut CBandCtx as *mut c_void, xc.as_mut_ptr(),
                        if stereo { yc.as_mut_ptr() } else { ptr::null_mut() }, oc.as_mut_ptr()),
                )
            };
            assert_eq!((a, rc.remaining_bits), (b, cc.remaining_bits));
            assert_eq!(bits(&[x[0], y[0], o[0]]), bits(&[xc[0], yc[0], oc[0]]));
            case.k.check();
        }
    }

    #[test]
    fn quant_all_bands_matches_c() {
        let cm = crate::testutil::c_mode();
        let frames = music_frames();
        let mut rng = Rng::new(15);
        let mut theta_rdo_runs = 0;
        let (mut resynth_changed, mut coded_bytes) = (0, 0usize);
        for it in 0..3000 {
            let lm = if it % 5 == 0 { rng.range(0, 2) } else { 3 };
            let m = 1 << lm;
            let n = (120 << lm) as usize;
            let ch = rng.range(1, 2) as usize;
            let transient = lm > 0 && rng.range(0, 2) == 0;
            let short_blocks = if transient { m } else { 0 };
            let f = &frames[rng.range(0, frames.len() as i32 - 1) as usize];
            let freq = spectrum(f, ch, lm, short_blocks);
            let end = if rng.range(0, 5) == 0 { rng.range(2, 21) } else { 21 };
            let mut be = vec![0.0f32; ch * NB];
            compute_band_energies(&MODE, &freq, &mut be, 21, ch as i32, lm);
            let mut x = vec![0.0f32; ch * n];
            normalise_bands(&MODE, &freq, &mut x, &be, 21, ch as i32, m);

            let nbytes = match rng.range(0, 3) {
                0 => rng.range(8, 60),
                1 => rng.range(60, 300),
                _ => rng.range(300, 1275),
            } as usize;
            let mut k = Coders::new(&mut rng, nbytes);
            let mut bits_ = ((nbytes as i32 * 8) << BITRES) - ec_tell_frac(&k.er) as i32 - 1;
            let anti_collapse_rsv = if transient && lm >= 2 && bits_ >= (lm + 2) << BITRES { 1 << BITRES } else { 0 };
            bits_ -= anti_collapse_rsv;

            // Allocation, on both coders.
            let mut cap = [0i32; NB];
            init_caps(&MODE, &mut cap, lm, ch as i32);
            let mut offsets = [0i32; NB];
            if rng.range(0, 2) == 0 {
                for _ in 0..rng.range(1, 4) {
                    offsets[rng.range(0, end - 1) as usize] = rng.range(0, 40) << 3;
                }
            }
            let alloc_trim = rng.range(0, 10);
            let mut intensity = rng.range(0, end);
            let mut dual_stereo = if ch == 2 { rng.range(0, 1) } else { 0 };
            let (mut ic, mut dc) = (intensity, dual_stereo);
            let prev = rng.range(0, end);
            let (mut balance, mut balc) = (0, 0);
            let (mut pulses, mut pc) = ([0i32; NB], [0i32; NB]);
            let (mut eb_, mut ebc) = ([0i32; NB], [0i32; NB]);
            let (mut fp, mut fpc) = ([0i32; NB], [0i32; NB]);
            let coded = clt_compute_allocation(&MODE, 0, end, &offsets, &cap, alloc_trim, &mut intensity, &mut dual_stereo,
                bits_, &mut balance, &mut pulses, &mut eb_, &mut fp, ch as i32, lm, &mut k.er, prev, end);
            let codedc = unsafe {
                c::clt_compute_allocation(cm, 0, end, offsets.as_ptr(), cap.as_ptr(), alloc_trim, &mut ic, &mut dc, bits_,
                    &mut balc, pc.as_mut_ptr(), ebc.as_mut_ptr(), fpc.as_mut_ptr(), ch as i32, lm, k.cptr(), 1, prev, end)
            };
            assert_eq!((coded, intensity, dual_stereo, balance, pulses), (codedc, ic, dc, balc, pc));
            if ch == 2 && rng.range(0, 3) == 0 {
                intensity = rng.range(0, end);
                dual_stereo = rng.range(0, 1);
            }

            let tf_select = rng.range(0, 1);
            let mut tf_res = [0i32; NB];
            for t in tf_res.iter_mut() {
                *t = tf_sel(lm, (4 * transient as i32 + 2 * tf_select + rng.range(0, 1)) as usize);
            }
            let spread = rng.range(0, 3);
            let complexity = rng.range(0, 10);
            let disable_inv = rng.range(0, 1);
            let seed0 = rng.next_u32();
            let total_bits = nbytes as i32 * (8 << BITRES) - anti_collapse_rsv;
            if ch == 2 && dual_stereo == 0 && complexity >= 8 {
                theta_rdo_runs += 1;
            }

            let mut xr = x.clone();
            let mut xc = x.clone();
            let (mut cmr, mut cmc) = (vec![0u8; ch * NB], vec![0u8; ch * NB]);
            let (mut sr, mut sc) = (seed0, seed0);
            {
                let (a, bpart) = xr.split_at_mut(n);
                quant_all_bands(&MODE, 0, end, a, if ch == 2 { Some(bpart) } else { None }, &mut cmr, &be, &pulses,
                    short_blocks, spread, dual_stereo, intensity, &tf_res, total_bits, balance, &mut k.er, lm, coded,
                    &mut sr, complexity, disable_inv);
            }
            unsafe {
                let y = if ch == 2 { xc.as_mut_ptr().add(n) } else { ptr::null_mut() };
                c::quant_all_bands(1, cm, 0, end, xc.as_mut_ptr(), y, cmc.as_mut_ptr(), be.as_ptr(), pc.as_mut_ptr(),
                    short_blocks, spread, dual_stereo, intensity, tf_res.as_mut_ptr(), total_bits, balance, k.cptr(), lm,
                    coded, &mut sc, complexity, 0, disable_inv);
            }
            let msg = format_args!("it {it} ch {ch} lm {lm} sb {short_blocks} end {end} bytes {nbytes} cx {complexity} ds {dual_stereo} int {intensity}").to_string();
            assert_eq!(cmr, cmc, "{msg}");
            assert_eq!(sr, sc, "{msg}");
            assert_eq!(bits(&xr), bits(&xc), "{msg}");
            if bits(&xr) != bits(&x) {
                resynth_changed += 1;
            }
            coded_bytes += k.er.offs as usize;
            k.check();
        }
        assert!(theta_rdo_runs > 100 && resynth_changed > 100 && coded_bytes > 100000, "{theta_rdo_runs} {resynth_changed} {coded_bytes}");
    }
}
