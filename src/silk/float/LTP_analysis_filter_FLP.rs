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
