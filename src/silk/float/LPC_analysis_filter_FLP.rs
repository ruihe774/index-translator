//! Port of silk/float/LPC_analysis_filter_FLP.c.

/************************************************/
/* LPC analysis filter                          */
/* NB! State is kept internally and the         */
/* filter always starts with zero state         */
/* first Order output samples are set to zero   */
/************************************************/

/* Order-th order LPC analysis filter (C: silk_LPC_analysis_filter{6,8,10,12,16}_FLP, one
   fully unrolled function per order), does not write the first Order samples. The
   prediction is summed left to right in float, exactly as the unrolled C expressions. */
#[inline(always)]
fn silk_LPC_analysis_filterN_FLP(r_LPC: &mut [f32], PredCoef: &[f32], s: &[f32], length: usize, order: usize) {
    let mut ix = order;

    while ix < length {
        /* short-term prediction */
        let mut LPC_pred: f32 = s[ix - 1] * PredCoef[0];
        for j in 1..order {
            LPC_pred += s[ix - 1 - j] * PredCoef[j];
        }

        /* prediction error */
        r_LPC[ix] = s[ix] - LPC_pred;
        ix += 1;
    }
}

/************************************************/
/* LPC analysis filter                          */
/* NB! State is kept internally and the         */
/* filter always starts with zero state         */
/* first Order output samples are set to zero   */
/************************************************/
pub fn silk_LPC_analysis_filter_FLP(
    r_LPC: &mut [f32],  /* O    LPC residual signal                         */
    PredCoef: &[f32],   /* I    LPC coefficients                            */
    s: &[f32],          /* I    Input signal                                */
    length: i32,        /* I    Length of input signal                      */
    Order: i32,         /* I    LPC order                                   */
) {
    debug_assert!(Order <= length);
    debug_assert!(matches!(Order, 6 | 8 | 10 | 12 | 16));

    match Order {
        6 | 8 | 10 | 12 | 16 => {
            silk_LPC_analysis_filterN_FLP(r_LPC, PredCoef, s, length as usize, Order as usize)
        }
        _ => debug_assert!(false),
    }

    /* Set first Order output samples to zero */
    r_LPC[..Order as usize].fill(0.0);
}

#[cfg(test)]
mod tests {
    use crate::testutil::{Rng, SpeechGen};
    mod c {
        unsafe extern "C" {
            pub fn silk_LPC_analysis_filter_FLP(r_LPC: *mut f32, PredCoef: *const f32, s: *const f32, length: i32, Order: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(111);
        let mut sg = SpeechGen::new(112);
        let sp: Vec<f32> = (0..1000).map(|_| sg.next_sample() as f32).collect();
        let noise = rng.f32_vec(1000, 20000.0);
        for order in [6, 8, 10, 12, 16] {
            for length in [order, order + 1, 2 * (order + 80), 100, 320, 400, 624] {
                for src in [&sp, &noise] {
                    let coef = rng.f32_vec(16, 0.8);
                    let off = rng.range(0, 7) as usize;
                    let s = &src[off..off + length as usize];
                    let mut r = vec![9f32; 700];
                    let mut e = r.clone();
                    super::silk_LPC_analysis_filter_FLP(&mut r, &coef, s, length, order);
                    unsafe { c::silk_LPC_analysis_filter_FLP(e.as_mut_ptr(), coef.as_ptr(), s.as_ptr(), length, order) };
                    for i in 0..700 {
                        assert_eq!(r[i].to_bits(), e[i].to_bits(), "order {order} length {length} i {i}");
                    }
                }
            }
        }
    }
}
