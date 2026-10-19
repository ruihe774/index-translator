//! Port of silk/float/find_LPC_FLP.c.

use crate::silk::define::*;
use crate::silk::float::LPC_analysis_filter_FLP::silk_LPC_analysis_filter_FLP;
use crate::silk::float::burg_modified_FLP::silk_burg_modified_FLP;
use crate::silk::float::energy_FLP::silk_energy_FLP;
use crate::silk::float::wrappers_FLP::{silk_A2NLSF_FLP, silk_NLSF2A_FLP};
use crate::silk::interpolate::silk_interpolate;
use crate::silk::macros::silk_float_MAX;
use crate::silk::structs::silk_encoder_state;

/// LPC analysis
pub fn silk_find_LPC_FLP(
    psEncC: &mut silk_encoder_state, /* I/O  Encoder state                               */
    NLSF_Q15: &mut [i16],            /* O    NLSFs                                       */
    x: &[f32],                       /* I    Input signal                                */
    minInvGain: f32,                 /* I    Inverse of max prediction gain              */
) {
    let mut a = [0f32; MAX_LPC_ORDER as usize];

    /* Used only for NLSF interpolation */
    let mut NLSF0_Q15 = [0i16; MAX_LPC_ORDER as usize];
    let mut a_tmp = [0f32; MAX_LPC_ORDER as usize];
    let mut LPC_res = [0f32; (MAX_FRAME_LENGTH + MAX_NB_SUBFR * MAX_LPC_ORDER) as usize];

    let subfr_length = MAX_SUB_FRAME_LENGTH + MAX_LPC_ORDER;
    let order = MAX_LPC_ORDER;

    /* Default: No interpolation */
    psEncC.indices.NLSFInterpCoef_Q2 = 4;

    /* Burg AR analysis for the full frame */
    let mut res_nrg = silk_burg_modified_FLP(&mut a, x, minInvGain, subfr_length, MAX_NB_SUBFR, order);

    if psEncC.useInterpolatedNLSFs != 0 && psEncC.first_frame_after_reset == 0 {
        /* Optimal solution for last 10 ms; subtract residual energy here, as that's easier than        */
        /* adding it to the residual energy of the first 10 ms in each iteration of the search below    */
        res_nrg -= silk_burg_modified_FLP(
            &mut a_tmp,
            &x[((MAX_NB_SUBFR / 2) * subfr_length) as usize..],
            minInvGain,
            subfr_length,
            MAX_NB_SUBFR / 2,
            order,
        );

        /* Convert to NLSFs */
        silk_A2NLSF_FLP(NLSF_Q15, &a_tmp, order);

        /* Search over interpolation indices to find the one with lowest residual energy */
        let mut res_nrg_2nd = silk_float_MAX;
        let mut k = 3;
        while k >= 0 {
            /* Interpolate NLSFs for first half */
            silk_interpolate(&mut NLSF0_Q15, &psEncC.prev_NLSFq_Q15, NLSF_Q15, k, order);

            /* Convert to LPC for residual energy evaluation */
            silk_NLSF2A_FLP(&mut a_tmp, &NLSF0_Q15, order);

            /* Calculate residual energy with LSF interpolation */
            silk_LPC_analysis_filter_FLP(&mut LPC_res, &a_tmp, x, 2 * subfr_length, order);
            let res_nrg_interp = (silk_energy_FLP(&LPC_res[order as usize..], subfr_length - order)
                + silk_energy_FLP(&LPC_res[(order + subfr_length) as usize..], subfr_length - order))
                as f32;

            /* Determine whether current interpolated NLSFs are best so far */
            if res_nrg_interp < res_nrg {
                /* Interpolation has lower residual energy */
                res_nrg = res_nrg_interp;
                psEncC.indices.NLSFInterpCoef_Q2 = k as i8;
            } else if res_nrg_interp > res_nrg_2nd {
                /* No reason to continue iterating - residual energies will continue to climb */
                break;
            }
            res_nrg_2nd = res_nrg_interp;
            k -= 1;
        }
    }

    if psEncC.indices.NLSFInterpCoef_Q2 == 4 {
        /* NLSF interpolation is currently inactive, calculate NLSFs from full frame AR coefficients */
        silk_A2NLSF_FLP(NLSF_Q15, &a, order);
    }

    debug_assert!(
        psEncC.indices.NLSFInterpCoef_Q2 == 4
            || (psEncC.useInterpolatedNLSFs != 0 && psEncC.first_frame_after_reset == 0)
    );
}
