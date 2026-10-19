//! Port of silk/float/LTP_analysis_filter_FLP.c.

use crate::silk::define::*;

/// `x` is the buffer holding the signal, and `x_off` the index in it of the C pointer `x`:
/// the filter reads preceding samples (`pitchL[k] + LTP_ORDER/2` before `x + k * subfr_length`),
/// so the buffer must extend that far before `x_off`.
pub fn silk_LTP_analysis_filter_FLP(
    LTP_res: &mut [f32],   /* O    LTP res MAX_NB_SUBFR*(pre_lgth+subfr_lngth) */
    x: &[f32],             /* I    Input signal, with preceding samples        */
    x_off: usize,
    B: &[f32],             /* I    LTP coefficients for each subframe [LTP_ORDER * MAX_NB_SUBFR] */
    pitchL: &[i32],        /* I    Pitch lags [MAX_NB_SUBFR]                   */
    invGains: &[f32],      /* I    Inverse quantization gains [MAX_NB_SUBFR]   */
    subfr_length: i32,     /* I    Length of each subframe                     */
    nb_subfr: i32,         /* I    number of subframes                         */
    pre_length: i32,       /* I    Preceding samples for each subframe         */
) {
    const LTP_ORDER_: usize = LTP_ORDER as usize;
    let mut Btmp = [0f32; LTP_ORDER_];

    let mut x_ptr = x_off as isize;
    let mut LTP_res_ptr = 0usize;
    for k in 0..nb_subfr as usize {
        let mut x_lag_ptr = x_ptr - pitchL[k] as isize;
        let inv_gain: f32 = invGains[k];
        for i in 0..LTP_ORDER_ {
            Btmp[i] = B[k * LTP_ORDER_ + i];
        }

        /* LTP analysis FIR filter */
        let n = (subfr_length + pre_length) as usize;
        #[allow(unused_mut)]
        let mut i0 = 0usize;
        /* With relaxed SIMD, clang auto-vectorizes this loop over i (4 at a time) and fuses
        the multiply-subtracts into f32x4.relaxed_madd with the negated coefficients; the
        remaining n % 4 samples are computed by the scalar loop (no fusion). */
        #[cfg(target_feature = "relaxed-simd")]
        {
            use core::arch::wasm32::*;
            let nvec = n & !3;
            while i0 < nvec {
                let first = (x_ptr + i0 as isize) as usize;
                let lag0 = (x_lag_ptr + i0 as isize - (LTP_ORDER_ / 2) as isize) as usize;
                assert!(first + 4 <= x.len() && lag0 + 4 + LTP_ORDER_ - 1 <= x.len());
                assert!(LTP_res_ptr + i0 + 4 <= LTP_res.len());
                // SAFETY: bounds checked by the asserts above (every load lies within
                // x[first .. first + 4] or x[lag0 .. lag0 + 4 + LTP_ORDER - 1]).
                unsafe {
                    let mut acc = v128_load(x.as_ptr().add(first) as *const v128);
                    for j in 0..LTP_ORDER_ {
                        let xl = v128_load(x.as_ptr().add(lag0 + LTP_ORDER_ - 1 - j) as *const v128);
                        acc = f32x4_relaxed_madd(f32x4_splat(-Btmp[j]), xl, acc);
                    }
                    acc = f32x4_mul(acc, f32x4_splat(inv_gain));
                    v128_store(LTP_res.as_mut_ptr().add(LTP_res_ptr + i0) as *mut v128, acc);
                }
                i0 += 4;
            }
            x_lag_ptr += nvec as isize;
        }
        for i in i0..n {
            let out = &mut LTP_res[LTP_res_ptr + i];
            *out = x[(x_ptr + i as isize) as usize];
            /* Subtract long-term prediction */
            for j in 0..LTP_ORDER_ {
                *out -= Btmp[j] * x[(x_lag_ptr + (LTP_ORDER_ / 2) as isize - j as isize) as usize];
            }
            *out *= inv_gain;
            x_lag_ptr += 1;
        }

        /* Update pointers */
        LTP_res_ptr += (subfr_length + pre_length) as usize;
        x_ptr += subfr_length as isize;
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::{Rng, SpeechGen};
    mod c {
        unsafe extern "C" {
            pub fn silk_LTP_analysis_filter_FLP(
                LTP_res: *mut f32, x: *const f32, B: *const f32, pitchL: *const i32, invGains: *const f32,
                subfr_length: i32, nb_subfr: i32, pre_length: i32,
            );
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(121);
        let mut sg = SpeechGen::new(122);
        let sp: Vec<f32> = (0..1200).map(|_| sg.next_sample() as f32).collect();
        let noise = rng.f32_vec(1200, 20000.0);
        for (subfr, pre) in [(80, 16), (80, 0), (40, 16), (80, 12)] {
            for src in [&sp, &noise] {
                for _ in 0..20 {
                    let x_off = 400usize;
                    let B = rng.f32_vec(20, 1.0);
                    let pitchL: Vec<i32> = (0..4).map(|_| rng.range(32, 288)).collect();
                    let inv: Vec<f32> = (0..4).map(|_| 1.0 / (100.0 + 1000.0 * (rng.f32_unit() + 1.0))).collect();
                    let mut r = vec![5f32; 4 * (subfr + pre) as usize + 3];
                    let mut e = r.clone();
                    super::silk_LTP_analysis_filter_FLP(&mut r, src, x_off, &B, &pitchL, &inv, subfr, 4, pre);
                    unsafe {
                        c::silk_LTP_analysis_filter_FLP(e.as_mut_ptr(), src.as_ptr().add(x_off), B.as_ptr(), pitchL.as_ptr(), inv.as_ptr(), subfr, 4, pre)
                    };
                    for i in 0..r.len() {
                        assert_eq!(r[i].to_bits(), e[i].to_bits(), "i {i}");
                    }
                }
            }
        }
    }
}
