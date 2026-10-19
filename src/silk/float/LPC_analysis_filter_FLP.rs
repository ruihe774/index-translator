//! Port of silk/float/LPC_analysis_filter_FLP.c.

/************************************************/
/* LPC analysis filter                          */
/* NB! State is kept internally and the         */
/* filter always starts with zero state         */
/* first Order output samples are set to zero   */
/************************************************/

/* Order-th order LPC analysis filter (C: silk_LPC_analysis_filter{6,8,10,12,16}_FLP, one
   fully unrolled function per order), does not write the first Order samples. The
   prediction is summed left to right in float, exactly as the unrolled C expressions.

   With relaxed SIMD, clang auto-vectorizes these loops (4 outputs at a time) and fuses the
   multiply-adds of the unrolled expression into f32x4.relaxed_madd. With C's contraction
   rule (the left operand of `+` is preferred) the chain is
   `t = madd(x0, c0, x1 * c1); t = madd(x_j, c_j, t)` for j = 2..order. The remaining
   (length - order) % 4 samples are computed by the scalar loop (no fusion). */
#[inline(always)]
fn silk_LPC_analysis_filterN_FLP(r_LPC: &mut [f32], PredCoef: &[f32], s: &[f32], length: usize, order: usize) {
    let mut ix = order;

    #[cfg(target_feature = "relaxed-simd")]
    {
        use core::arch::wasm32::*;
        assert!(r_LPC.len() >= length && s.len() >= length && PredCoef.len() >= order);
        let end = order + (length.saturating_sub(order) & !3);
        while ix < end {
            // SAFETY: loads cover s[ix - order .. ix + 4] and the store r_LPC[ix .. ix + 4],
            // with ix >= order and ix + 4 <= end <= length.
            unsafe {
                let ld = |i: usize| v128_load(s.as_ptr().add(i) as *const v128);
                let mut t = f32x4_mul(ld(ix - 2), f32x4_splat(PredCoef[1]));
                t = f32x4_relaxed_madd(ld(ix - 1), f32x4_splat(PredCoef[0]), t);
                for j in 2..order {
                    t = f32x4_relaxed_madd(ld(ix - 1 - j), f32x4_splat(PredCoef[j]), t);
                }
                v128_store(r_LPC.as_mut_ptr().add(ix) as *mut v128, f32x4_sub(ld(ix), t));
            }
            ix += 4;
        }
    }

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
