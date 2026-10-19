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
