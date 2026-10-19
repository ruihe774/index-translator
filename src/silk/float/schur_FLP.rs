//! Port of silk/float/schur_FLP.c.

/// SILK_MAX_ORDER_LPC (SigProc_FIX.h): max order of the LPC analysis in schur() and k2a()
pub const SILK_MAX_ORDER_LPC: usize = 24;

/// Returns residual energy.
pub fn silk_schur_FLP(
    refl_coef: &mut [f32], /* O    reflection coefficients (length order)                      */
    auto_corr: &[f32],     /* I    autocorrelation sequence (length order+1)                   */
    order: i32,            /* I    order                                                       */
) -> f32 {
    let mut C = [[0f64; 2]; SILK_MAX_ORDER_LPC + 1];

    debug_assert!(order >= 0 && order <= SILK_MAX_ORDER_LPC as i32);
    let order = order as usize;

    /* Copy correlations */
    for k in 0..=order {
        C[k][0] = auto_corr[k] as f64;
        C[k][1] = auto_corr[k] as f64;
    }

    for k in 0..order {
        /* Get reflection coefficient */
        /* silk_max_float( C[ 0 ][ 1 ], 1e-9f ) is evaluated in double */
        let m = if C[0][1] > 1e-9f32 as f64 { C[0][1] } else { 1e-9f32 as f64 };
        let rc_tmp: f64 = -C[k + 1][0] / m;

        /* Save the output */
        refl_coef[k] = rc_tmp as f32;

        /* Update correlations */
        for n in 0..order - k {
            let Ctmp1 = C[n + k + 1][0];
            let Ctmp2 = C[n][1];
            C[n + k + 1][0] = Ctmp1 + Ctmp2 * rc_tmp;
            C[n][1] = Ctmp2 + Ctmp1 * rc_tmp;
        }
    }

    /* Return residual energy */
    C[0][1] as f32
}

#[cfg(test)]
mod tests {
    use crate::silk::float::autocorrelation_FLP::silk_autocorrelation_FLP;
    use crate::testutil::{Rng, SpeechGen};
    mod c {
        unsafe extern "C" {
            pub fn silk_schur_FLP(refl_coef: *mut f32, auto_corr: *const f32, order: i32) -> f32;
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(81);
        let mut sg = SpeechGen::new(82);
        for iter in 0..200 {
            let x: Vec<f32> = if iter % 3 == 2 {
                rng.f32_vec(384, 10000.0)
            } else {
                (0..384).map(|_| sg.next_sample() as f32).collect()
            };
            for order in [0, 1, 10, 12, 16, 24] {
                let mut ac = vec![0f32; 25];
                silk_autocorrelation_FLP(&mut ac, &x, 384, order + 1);
                if iter % 7 == 0 {
                    ac[0] *= 1.0001; /* regularised, like find_LPC */
                }
                let mut r = vec![0f32; 24];
                let mut e = r.clone();
                let rr = super::silk_schur_FLP(&mut r, &ac, order);
                let ee = unsafe { c::silk_schur_FLP(e.as_mut_ptr(), ac.as_ptr(), order) };
                assert_eq!(rr.to_bits(), ee.to_bits(), "order {order}");
                for i in 0..24 {
                    assert_eq!(r[i].to_bits(), e[i].to_bits(), "order {order} i {i}");
                }
            }
        }
        /* all-zero correlation */
        let ac = vec![0f32; 25];
        let (mut r, mut e) = (vec![0f32; 24], vec![0f32; 24]);
        let rr = super::silk_schur_FLP(&mut r, &ac, 16);
        let ee = unsafe { c::silk_schur_FLP(e.as_mut_ptr(), ac.as_ptr(), 16) };
        assert_eq!(rr.to_bits(), ee.to_bits());
        assert_eq!(r.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), e.iter().map(|x| x.to_bits()).collect::<Vec<_>>());
    }
}
