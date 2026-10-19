//! Port of celt/vq.c (encoder side, float build, no QEXT) and the fork's celt/wasm/vq_wasm.c
//! (`op_pvq_search_wasm`, which replaces `op_pvq_search_c`).
//!
//! In the float build `celt_inner_prod_norm` and `celt_inner_prod_norm_shift` are
//! `celt_inner_prod`, and `norm_scaleup`/`norm_scaledown` are no-ops.

use core::arch::wasm32::*;

use super::arch::EPSILON;
use super::bands::SPREAD_NONE;
use super::cwrs::encode_pulses;
use super::entcode::{celt_udiv, ec_enc};
use super::mathops::{celt_cos_norm, celt_atan2p_norm, celt_rcp, celt_rsqrt_norm, celt_rsqrt_norm32, celt_sqrt32};
use super::pitch::celt_inner_prod;
use crate::stack;

fn exp_rotation1(X: &mut [f32], len: i32, stride: i32, c: f32, s: f32) {
    let ms = -s;
    let stride = stride as usize;
    let mut i = 0usize;
    while (i as i32) < len - stride as i32 {
        let x1 = X[i];
        let x2 = X[i + stride];
        X[i + stride] = c * x2 + s * x1;
        X[i] = c * x1 + ms * x2;
        i += 1;
    }
    let mut i = len - 2 * stride as i32 - 1;
    while i >= 0 {
        let p = i as usize;
        let x1 = X[p];
        let x2 = X[p + stride];
        X[p + stride] = c * x2 + s * x1;
        X[p] = c * x1 + ms * x2;
        i -= 1;
    }
}

pub fn exp_rotation(X: &mut [f32], mut len: i32, dir: i32, stride: i32, K: i32, spread: i32) {
    const SPREAD_FACTOR: [i32; 3] = [15, 10, 5];
    let mut stride2: i32 = 0;

    if 2 * K >= len || spread == SPREAD_NONE {
        return;
    }
    let factor = SPREAD_FACTOR[(spread - 1) as usize];

    let gain: f32 = (1.0f32 * len as f32) / ((len + factor * K) as f32);
    let theta: f32 = 0.5f32 * (gain * gain);

    let c = celt_cos_norm(theta);
    let s = celt_cos_norm(1.0f32 - theta); /*  sin(theta) */

    if len >= 8 * stride {
        stride2 = 1;
        /* This is just a simple (equivalent) way of computing sqrt(len/stride) with rounding.
        It's basically incrementing long as (stride2+0.5)^2 < len/stride. */
        while (stride2 * stride2 + stride2) * stride + (stride >> 2) < len {
            stride2 += 1;
        }
    }
    /*NOTE: As a minor optimization, we could be passing around log2(B), not B, for both this and for
    extract_collapse_mask().*/
    len = celt_udiv(len as u32, stride as u32) as i32;
    for i in 0..stride {
        let x = &mut X[(i * len) as usize..];
        if dir < 0 {
            if stride2 != 0 {
                exp_rotation1(x, len, stride2, s, c);
            }
            exp_rotation1(x, len, 1, c, s);
        } else {
            exp_rotation1(x, len, 1, c, -s);
            if stride2 != 0 {
                exp_rotation1(x, len, stride2, s, -c);
            }
        }
    }
}

/// Normalizes the decoded integer pvq codeword to unit norm.
fn normalise_residual(iy: &[i32], X: &mut [f32], N: i32, Ryy: f32, gain: f32) {
    let t = Ryy;
    let g = celt_rsqrt_norm32(t) * gain;
    for i in 0..N as usize {
        X[i] = iy[i] as f32 * g;
    }
}

fn extract_collapse_mask(iy: &[i32], N: i32, B: i32) -> u32 {
    if B <= 1 {
        return 1;
    }
    /*NOTE: As a minor optimization, we could be passing around log2(B), not B, for both this and for
    exp_rotation().*/
    let N0 = celt_udiv(N as u32, B as u32) as usize;
    let mut collapse_mask: u32 = 0;
    for i in 0..B as usize {
        let mut tmp: u32 = 0;
        for j in 0..N0 {
            tmp |= iy[i * N0 + j] as u32;
        }
        collapse_mask |= ((tmp != 0) as u32) << i;
    }
    collapse_mask
}

/* With relaxed SIMD, use the single-instruction lane select (e.g. blendvps
on x86). Every mask passed to it is a comparison result, i.e. all-ones or
all-zeros per lane, for which relaxed_laneselect is fully defined. */
#[cfg(target_feature = "relaxed-simd")]
#[inline(always)]
fn WASM_LANESELECT(a: v128, b: v128, m: v128) -> v128 {
    i32x4_relaxed_laneselect(a, b, m)
}
#[cfg(not(target_feature = "relaxed-simd"))]
#[inline(always)]
fn WASM_LANESELECT(a: v128, b: v128, m: v128) -> v128 {
    v128_bitselect(a, b, m)
}

#[inline(always)]
fn wasm_f32x4_hsum(a: v128) -> f32 {
    let a = f32x4_add(a, i64x2_shuffle::<1, 0>(a, a));
    let a = f32x4_add(a, i32x4_shuffle::<1, 0, 3, 2>(a, a));
    f32x4_extract_lane::<0>(a)
}

#[inline(always)]
fn wasm_i32x4_hsum(a: v128) -> i32 {
    let a = i32x4_add(a, i64x2_shuffle::<1, 0>(a, a));
    let a = i32x4_add(a, i32x4_shuffle::<1, 0, 3, 2>(a, a));
    i32x4_extract_lane::<0>(a)
}

/// op_pvq_search_wasm. `_X` is not modified (unlike `op_pvq_search_c`). Like the C kernel,
/// `iy` needs room for N+3 entries (whole vectors of 4 are stored).
pub fn op_pvq_search(_X: &[f32], iy: &mut [i32], K: i32, N: i32) -> f32 {
    let n = N as usize;
    assert!(N > 0 && _X.len() >= n && iy.len() >= (n + 3) & !3);
    let st = stack::save();
    /* X and y are padded with (at least) 8 entries for the search loop. */
    let y = st.alloc::<f32>(n + 8);
    let X = st.alloc::<f32>(n + 8);
    let signy = st.alloc::<i32>(n + 3);
    let (py, pX, ps, piy, p_X) =
        (y.as_mut_ptr(), X.as_mut_ptr(), signy.as_mut_ptr(), iy.as_mut_ptr(), _X.as_ptr());
    let mut xy: f32;
    let mut yy: f32;
    let mut pulsesLeft: i32;
    // SAFETY: all vector accesses stay within y[0..N+8], X[0..N+8], signy/iy[0..(N+3)&~3]
    // and _X[0..N], as in the C kernel.
    unsafe {
        /* Copy the last partial vector of _X into a zero-padded X; the full
        vectors are read from _X directly below. */
        let j0 = n & !3;
        v128_store(pX.add(j0) as *mut v128, f32x4_splat(0.0));
        v128_store(pX.add(j0 + 4) as *mut v128, f32x4_splat(0.0));
        for i in j0..n {
            *pX.add(i) = *p_X.add(i);
        }
        let mut sums = f32x4_splat(0.0);
        let mut j = 0usize;
        while j < n {
            let mut x4 = v128_load(if j + 4 <= n { p_X.add(j) } else { pX.add(j) } as *const v128);
            let s4 = f32x4_lt(x4, f32x4_splat(0.0));
            /* Get rid of the sign */
            x4 = f32x4_abs(x4);
            sums = f32x4_add(sums, x4);
            /* Clear y and iy in case we don't do the projection. */
            v128_store(py.add(j) as *mut v128, f32x4_splat(0.0));
            v128_store(piy.add(j) as *mut v128, i32x4_splat(0));
            v128_store(pX.add(j) as *mut v128, x4);
            v128_store(ps.add(j) as *mut v128, s4);
            j += 4;
        }

        xy = 0.0;
        yy = 0.0;

        pulsesLeft = K;

        /* Do a pre-search by projecting on the pyramid */
        if K > (N >> 1) {
            let mut sum: f32 = wasm_f32x4_hsum(sums);
            /* If X is too small, just replace it with a pulse at 0 */
            /* Prevents infinities and NaNs from causing too many pulses
            to be allocated. 64 is an approximation of infinity here. */
            if !(sum > EPSILON && sum < 64.0) {
                *pX = 1.0;
                let mut j = 1usize;
                loop {
                    *pX.add(j) = 0.0;
                    j += 1;
                    if j >= n {
                        break;
                    }
                }
                sum = 1.0;
            }
            /* Using K+e with e < 1 guarantees we cannot get more than K pulses. */
            let rcp4 = f32x4_splat((K as f32 + 0.8f32) * celt_rcp(sum));
            let mut xy4 = f32x4_splat(0.0);
            let mut yy4 = f32x4_splat(0.0);
            let mut pulses_sum = i32x4_splat(0);
            let mut j = 0usize;
            while j < n {
                let x4 = v128_load(pX.add(j) as *const v128);
                /* x4 >= 0 here, so truncation is the same as the floor() in the C
                code. x4*rcp4 is finite, not NaN and at most K+.8, so the
                relaxed truncation is exact too. */
                #[cfg(target_feature = "relaxed-simd")]
                let iy4 = i32x4_relaxed_trunc_f32x4(f32x4_mul(x4, rcp4));
                #[cfg(not(target_feature = "relaxed-simd"))]
                let iy4 = i32x4_trunc_sat_f32x4(f32x4_mul(x4, rcp4));
                pulses_sum = i32x4_add(pulses_sum, iy4);
                v128_store(piy.add(j) as *mut v128, iy4);
                let y4 = f32x4_convert_i32x4(iy4);
                xy4 = f32x4_add(xy4, f32x4_mul(x4, y4));
                yy4 = f32x4_add(yy4, f32x4_mul(y4, y4));
                /* double the y[] vector so we don't have to do it in the search loop. */
                v128_store(py.add(j) as *mut v128, f32x4_add(y4, y4));
                j += 4;
            }
            pulsesLeft -= wasm_i32x4_hsum(pulses_sum);
            xy = wasm_f32x4_hsum(xy4);
            yy = wasm_f32x4_hsum(yy4);
        }
        /* The padding lanes get X=0 and a huge y, so their score is either 0
        (never selected, as only scores strictly above 0 are) or far below
        the score of any real position. */
        v128_store(py.add(n) as *mut v128, f32x4_splat(1e15));
        v128_store(py.add(n + 4) as *mut v128, f32x4_splat(1e15));
        debug_assert!(pulsesLeft >= 0);

        /* This should never happen, but just in case it does (e.g. on silence)
        we fill the first bin with pulses. */
        if pulsesLeft > N + 3 {
            let tmp = pulsesLeft as f32;
            yy = yy + tmp * tmp;
            yy = yy + tmp * *py;
            *piy += pulsesLeft;
            pulsesLeft = 0;
        }

        for _ in 0..pulsesLeft {
            /* The squared magnitude term gets added anyway, so we might as well
            add it outside the loop */
            yy = yy + 1.0;
            let xy4 = f32x4_splat(xy);
            let yy4 = f32x4_splat(yy);
            /* Two independent sets of per-lane maxima, to halve the length of the
            loop-carried dependency chain. */
            let mut best0 = f32x4_splat(0.0);
            let mut best1 = best0;
            let mut pos0 = i32x4_splat(0);
            let mut pos1 = pos0;
            let mut count = i32x4(0, 1, 2, 3);
            let mut j = 0usize;
            while j < n {
                /* Temporary sums of the new pulse(s) */
                let rxy0 = f32x4_add(v128_load(pX.add(j) as *const v128), xy4);
                let rxy1 = f32x4_add(v128_load(pX.add(j + 4) as *const v128), xy4);
                /* We're multiplying y[j] by two so we don't have to do it here */
                let ryy0 = f32x4_add(v128_load(py.add(j) as *const v128), yy4);
                let ryy1 = f32x4_add(v128_load(py.add(j + 4) as *const v128), yy4);
                /* We maximise Rxy/sqrt(Ryy), i.e. Rxy^2/Ryy since Rxy >= 0.
                WebAssembly has no reciprocal (square root) estimate, and one
                division is cheaper than a square root plus a division. */
                let r0 = f32x4_div(f32x4_mul(rxy0, rxy0), ryy0);
                let r1 = f32x4_div(f32x4_mul(rxy1, rxy1), ryy1);
                /* Keep the first index of each per-lane maximum. */
                pos0 = WASM_LANESELECT(count, pos0, f32x4_gt(r0, best0));
                count = i32x4_add(count, i32x4_splat(4));
                pos1 = WASM_LANESELECT(count, pos1, f32x4_gt(r1, best1));
                count = i32x4_add(count, i32x4_splat(4));
                best0 = f32x4_pmax(best0, r0);
                best1 = f32x4_pmax(best1, r1);
                j += 8;
            }
            /* Merge the two sets, keeping the lowest index on ties. */
            pos0 = WASM_LANESELECT(pos1, pos0, f32x4_gt(best1, best0));
            best0 = f32x4_pmax(best0, best1);
            /* Horizontal max */
            let mut max = f32x4_pmax(best0, i64x2_shuffle::<1, 0>(best0, best0));
            max = f32x4_pmax(max, i32x4_shuffle::<1, 0, 3, 2>(max, max));
            /* Among the lanes that reach the global max, pick the lowest index,
            like the C code does. */
            pos0 = WASM_LANESELECT(pos0, i32x4_splat(0x7fffffff), f32x4_eq(best0, max));
            pos0 = i32x4_min(pos0, i64x2_shuffle::<1, 0>(pos0, pos0));
            pos0 = i32x4_min(pos0, i32x4_shuffle::<1, 0, 3, 2>(pos0, pos0));
            let best_id = i32x4_extract_lane::<0>(pos0) as usize;

            /* Updating the sums of the new pulse(s) */
            xy = xy + *pX.add(best_id);
            /* We're multiplying y[j] by two so we don't have to do it here */
            yy = yy + *py.add(best_id);

            /* Only now that we've made the final choice, update y/iy */
            /* Multiplying y[j] by 2 so we don't have to do it everywhere else */
            *py.add(best_id) += 2.0;
            *piy.add(best_id) += 1;
        }

        /* Put the original sign back */
        let mut j = 0usize;
        while j < n {
            let mut y4 = v128_load(piy.add(j) as *const v128);
            let s4 = v128_load(ps.add(j) as *const v128);
            y4 = v128_xor(i32x4_add(y4, s4), s4);
            v128_store(piy.add(j) as *mut v128, y4);
            j += 4;
        }
    }
    yy
}

/// Algebraic pulse-vector quantiser. The signal x is replaced by the sum of
/// the pitch and a combination of pulses such that its norm is still equal
/// to 1. This is the function that will typically require the most CPU.
/// Returns a mask indicating which blocks in the band received pulses.
pub fn alg_quant(X: &mut [f32], N: i32, K: i32, spread: i32, B: i32, enc: &mut ec_enc, gain: f32, resynth: i32) -> u32 {
    let st = stack::save();

    debug_assert!(K > 0, "alg_quant() needs at least one pulse");
    debug_assert!(N > 1, "alg_quant() needs at least two dimensions");

    /* Covers vectorization by up to 4. */
    let iy = st.alloc::<i32>((N + 3) as usize);

    exp_rotation(X, N, 1, B, K, spread);

    let yy = op_pvq_search(X, iy, K, N);
    let collapse_mask = extract_collapse_mask(iy, N, B);
    encode_pulses(&iy[..N as usize], N, K, enc);
    if resynth != 0 {
        normalise_residual(iy, X, N, yy, gain);
    }

    if resynth != 0 {
        exp_rotation(X, N, -1, B, K, spread);
    }

    collapse_mask
}

pub fn renormalise_vector(X: &mut [f32], N: i32, gain: f32) {
    let E: f32 = EPSILON + celt_inner_prod(X, X, N);
    let t = E;
    let g: f32 = celt_rsqrt_norm(t) * gain;

    for i in 0..N as usize {
        X[i] = g * X[i];
    }
    /*return celt_sqrt(E);*/
}

pub fn stereo_itheta(X: &[f32], Y: &[f32], stereo: i32, N: i32) -> i32 {
    let mut Emid: f32 = 0.0;
    let mut Eside: f32 = 0.0;
    if stereo != 0 {
        for i in 0..N as usize {
            let m = X[i] + Y[i];
            let s = X[i] - Y[i];
            Emid = Emid + m * m;
            Eside = Eside + s * s;
        }
    } else {
        Emid += celt_inner_prod(X, X, N);
        Eside += celt_inner_prod(Y, Y, N);
    }
    let mid = celt_sqrt32(Emid);
    let side = celt_sqrt32(Eside);
    libm::floor((0.5f32 + 65536.0f32 * 16384.0 * celt_atan2p_norm(side, mid)) as f64) as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::celt::entenc::{ec_enc_done, ec_enc_init};
    use crate::testutil::{Rng, same_enc};
    use core::ffi::c_void;
    use minicelt_oracle as c;
    use std::vec;
    use std::vec::Vec;

    fn bits(v: &[f32]) -> Vec<u32> {
        v.iter().map(|x| x.to_bits()).collect()
    }

    /// Random vector: mostly unit-norm, sometimes sparse, tiny, zero or huge.
    fn rand_vec(rng: &mut Rng, n: usize) -> Vec<f32> {
        let mut v = rng.f32_vec(n, 1.0);
        match rng.range(0, 9) {
            0 => v.iter_mut().for_each(|x| *x *= 1e-20),
            1 => v.iter_mut().for_each(|x| *x = 0.0),
            2 => {
                for x in v.iter_mut() {
                    if rng.range(0, 3) != 0 {
                        *x = 0.0
                    }
                }
            }
            3 => v.iter_mut().for_each(|x| *x *= 1e4),
            4 => v[rng.range(0, n as i32 - 1) as usize] = 1.0,
            _ => {
                let e: f32 = v.iter().map(|x| x * x).sum::<f32>() + 1e-15;
                let g = 1.0 / libm::sqrtf(e);
                v.iter_mut().for_each(|x| *x *= g);
            }
        }
        v
    }

    /// A valid PVQ (N, K) pair from the static pulse cache (band i at LM in -1..=3).
    fn rand_nk(rng: &mut Rng) -> (i32, i32) {
        use crate::celt::modes::mode48000_960_120 as MODE;
        use crate::celt::rate::get_pulses;
        loop {
            let i = rng.range(0, 20);
            let lm = rng.range(-1, 3);
            let w = (MODE.eBands[i as usize + 1] - MODE.eBands[i as usize]) as i32;
            let n = (w << (lm + 1)) >> 1;
            if n < 2 {
                continue;
            }
            let off = MODE.cache.index[((lm + 1) * 21 + i) as usize] as usize;
            let maxq = MODE.cache.bits[off] as i32;
            let q = if rng.range(0, 3) == 0 { maxq } else { rng.range(1, maxq) };
            return (n, get_pulses(q));
        }
    }

    fn rand_n(rng: &mut Rng) -> i32 {
        match rng.range(0, 3) {
            0 => rng.range(2, 16),
            1 => rng.range(2, 64),
            _ => rng.range(2, 176),
        }
    }

    #[test]
    fn exp_rotation1_matches_c() {
        let mut rng = Rng::new(1);
        for _ in 0..3000 {
            let len = rng.range(2, 200);
            let stride = rng.range(1, (len / 2).max(1));
            let (cc, s) = (rng.f32_unit(), rng.f32_unit());
            let mut a = rng.f32_vec(len as usize, 1.0);
            let mut b = a.clone();
            exp_rotation1(&mut a, len, stride, cc, s);
            unsafe { c::oracle_exp_rotation1(b.as_mut_ptr(), len, stride, cc, s) };
            assert_eq!(bits(&a), bits(&b));
        }
    }

    #[test]
    fn exp_rotation_matches_c() {
        let mut rng = Rng::new(2);
        for it in 0..20000 {
            let stride = [1, 2, 4, 8, 16][rng.range(0, 4) as usize];
            let n0 = rng.range(1, 30);
            let len = stride * n0;
            if len < 2 {
                continue;
            }
            let K = if it % 3 == 0 { rng.range(1, len) } else { rng.range(1, (len / 2).max(1)) };
            let spread = rng.range(0, 3);
            let dir = if rng.range(0, 1) == 0 { 1 } else { -1 };
            let mut a = rng.f32_vec(len as usize, 1.0);
            let mut b = a.clone();
            exp_rotation(&mut a, len, dir, stride, K, spread);
            unsafe { c::exp_rotation(b.as_mut_ptr(), len, dir, stride, K, spread) };
            assert_eq!(bits(&a), bits(&b), "len {len} stride {stride} K {K} spread {spread}");
        }
    }

    #[test]
    fn op_pvq_search_matches_c() {
        let mut rng = Rng::new(3);
        for it in 0..30000 {
            let N = rand_n(&mut rng);
            let K = match it % 4 {
                0 => rng.range(1, (N / 2).max(1)),
                1 => rng.range(N / 2 + 1, N + 8),
                2 => rng.range(1, 128),
                _ => rng.range(1, 600),
            };
            let x = rand_vec(&mut rng, N as usize);
            let mut xc = x.clone();
            let mut iyr = vec![0x5555i32; N as usize + 3];
            let mut iyc = vec![0x5555i32; N as usize + 3];
            let yr = op_pvq_search(&x, &mut iyr, K, N);
            let yc = unsafe { c::op_pvq_search_wasm(xc.as_mut_ptr(), iyc.as_mut_ptr(), K, N, 0) };
            assert_eq!(yr.to_bits(), yc.to_bits(), "N {N} K {K}");
            assert_eq!(iyr[..N as usize], iyc[..N as usize], "N {N} K {K}");
            assert_eq!(bits(&x), bits(&xc));
            assert_eq!(iyr.iter().map(|v| v.abs()).sum::<i32>() - iyr[N as usize..].iter().map(|v| v.abs()).sum::<i32>(), K);
        }
    }

    #[test]
    fn normalise_residual_and_collapse_mask_match_c() {
        let mut rng = Rng::new(4);
        for _ in 0..5000 {
            let B = [1, 2, 4, 8][rng.range(0, 3) as usize];
            let N = B * rng.range(1, 22);
            let mut iy = rng.i32_vec(N as usize, 5);
            if rng.range(0, 1) == 0 {
                for v in iy.iter_mut() {
                    if rng.range(0, 2) != 0 {
                        *v = 0;
                    }
                }
            }
            let ryy = iy.iter().map(|v| (v * v) as f32).sum::<f32>() + 1.0;
            let gain = rng.f32_unit().abs() + 0.1;
            let mut a = vec![0.0f32; N as usize];
            let mut b = a.clone();
            normalise_residual(&iy, &mut a, N, ryy, gain);
            unsafe { c::oracle_normalise_residual(iy.as_mut_ptr(), b.as_mut_ptr(), N, ryy, gain, 0) };
            assert_eq!(bits(&a), bits(&b));
            assert_eq!(extract_collapse_mask(&iy, N, B), unsafe {
                c::oracle_extract_collapse_mask(iy.as_mut_ptr(), N, B)
            });
        }
    }

    #[test]
    fn alg_quant_matches_c() {
        let mut rng = Rng::new(5);
        for it in 0..20000 {
            let (N, K) = rand_nk(&mut rng);
            let mut B = [1, 2, 4, 8][rng.range(0, 3) as usize];
            while N % B != 0 {
                B >>= 1;
            }
            let _ = it;
            let spread = rng.range(0, 3);
            let resynth = rng.range(0, 1);
            let gain = if rng.range(0, 1) == 0 { 1.0 } else { rng.f32_unit().abs() };
            let x = rand_vec(&mut rng, N as usize);
            let (mut xr, mut xc) = (x.clone(), x.clone());
            let size = rng.range(4, 200) as usize;
            let (mut br, mut bc) = (vec![0u8; size], vec![0u8; size]);
            let mut er: ec_enc = unsafe { core::mem::zeroed() };
            let mut ec: ec_enc = unsafe { core::mem::zeroed() };
            ec_enc_init(&mut er, br.as_mut_ptr(), size as u32);
            unsafe { c::ec_enc_init(&mut ec as *mut ec_enc as *mut c_void, bc.as_mut_ptr(), size as u32) };
            let mr = alg_quant(&mut xr, N, K, spread, B, &mut er, gain, resynth);
            let mc = unsafe {
                c::alg_quant(xc.as_mut_ptr(), N, K, spread, B, &mut ec as *mut ec_enc as *mut c_void, gain, resynth, 0)
            };
            assert_eq!(mr, mc);
            assert_eq!(bits(&xr), bits(&xc), "N {N} K {K} B {B} spread {spread} resynth {resynth}");
            same_enc(&er, &ec);
            ec_enc_done(&mut er);
            unsafe { c::ec_enc_done(&mut ec as *mut ec_enc as *mut c_void) };
            same_enc(&er, &ec);
            assert_eq!(br, bc);
        }
    }

    #[test]
    fn renormalise_vector_and_stereo_itheta_match_c() {
        let mut rng = Rng::new(6);
        for _ in 0..20000 {
            let N = rand_n(&mut rng);
            let x = rand_vec(&mut rng, N as usize);
            let y = rand_vec(&mut rng, N as usize);
            let gain = if rng.range(0, 1) == 0 { 1.0 } else { rng.f32_unit() };
            let (mut a, mut b) = (x.clone(), x.clone());
            renormalise_vector(&mut a, N, gain);
            unsafe { c::renormalise_vector(b.as_mut_ptr(), N, gain, 0) };
            assert_eq!(bits(&a), bits(&b));
            for stereo in 0..2 {
                assert_eq!(stereo_itheta(&x, &y, stereo, N), unsafe {
                    c::stereo_itheta(x.as_ptr(), y.as_ptr(), stereo, N, 0)
                });
            }
        }
    }
}
