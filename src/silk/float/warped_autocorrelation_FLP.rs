//! Port of silk/float/warped_autocorrelation_FLP.c.

use crate::silk::define::MAX_SHAPE_LPC_ORDER;

/* Autocorrelations for a warped frequency axis */
pub fn silk_warped_autocorrelation_FLP(
    corr: &mut [f32],  /* O    Result [order + 1]                          */
    input: &[f32],     /* I    Input data to correlate                     */
    warping: f32,      /* I    Warping coefficient                         */
    length: i32,       /* I    Length of input                             */
    order: i32,        /* I    Correlation order (even)                    */
) {
    let mut state = [0f64; MAX_SHAPE_LPC_ORDER as usize + 1];
    let mut C = [0f64; MAX_SHAPE_LPC_ORDER as usize + 1];
    let warping = warping as f64;

    /* Order must be even */
    debug_assert!((order & 1) == 0);
    let order = order as usize;

    /* Loop over samples */
    for n in 0..length as usize {
        let mut tmp1: f64 = input[n] as f64;
        /* Loop over allpass sections */
        for i in (0..order).step_by(2) {
            /* Output of allpass section */
            /* We voluntarily use two multiples instead of factoring the expression to
            reduce the length of the dependency chain (tmp1->tmp2->tmp1... ). */
            let tmp2: f64 = state[i] + warping * state[i + 1] - warping * tmp1;
            state[i] = tmp1;
            C[i] += state[0] * tmp1;
            /* Output of allpass section */
            tmp1 = state[i + 1] + warping * state[i + 2] - warping * tmp2;
            state[i + 1] = tmp2;
            C[i + 1] += state[0] * tmp2;
        }
        state[order] = tmp1;
        C[order] += state[0] * tmp1;
    }

    /* Copy correlations in silk_float output format */
    for i in 0..order + 1 {
        corr[i] = C[i] as f32;
    }
}
