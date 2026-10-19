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
        for i in 0..n {
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
