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

#[cfg(test)]
mod tests {
    use crate::testutil::{Rng, SpeechGen};
    mod c {
        unsafe extern "C" {
            pub fn silk_warped_autocorrelation_FLP(corr: *mut f32, input: *const f32, warping: f32, length: i32, order: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(131);
        let mut sg = SpeechGen::new(132);
        let sp: Vec<f32> = (0..600).map(|_| sg.next_sample() as f32).collect();
        let noise = rng.f32_vec(600, 20000.0);
        for order in [2, 4, 10, 16, 20, 24] {
            for length in [0, 1, 7, 160, 320, 384, 500] {
                for src in [&sp, &noise] {
                    let warping = rng.f32_unit() * 0.1 + 0.02;
                    let mut r = vec![3f32; 25];
                    let mut e = r.clone();
                    super::silk_warped_autocorrelation_FLP(&mut r, src, warping, length, order);
                    unsafe { c::silk_warped_autocorrelation_FLP(e.as_mut_ptr(), src.as_ptr(), warping, length, order) };
                    for i in 0..25 {
                        assert_eq!(r[i].to_bits(), e[i].to_bits(), "order {order} length {length} i {i}");
                    }
                }
            }
        }
    }
}
