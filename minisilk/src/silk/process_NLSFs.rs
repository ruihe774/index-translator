//! Port of silk/process_NLSFs.c.

use crate::silk::NLSF2A::silk_NLSF2A;
use crate::silk::NLSF_VQ_weights_laroia::silk_NLSF_VQ_weights_laroia;
use crate::silk::NLSF_encode::silk_NLSF_encode;
use crate::silk::define::*;
use crate::silk::interpolate::silk_interpolate;
use crate::silk::macros::*;
use crate::silk::tables::silk_NLSF_CB_WB;
use crate::silk::structs::silk_encoder_state;

/// Limit, stabilize, convert and quantize NLSFs.
/// `psEncC`: encoder state (I/O); `PredCoef_Q12`: prediction coefficients (O);
/// `pNLSF_Q15`: normalized LSFs (quant out) (0 - (2^15-1)) [MAX_LPC_ORDER] (I/O);
/// `prev_NLSFq_Q15`: previous normalized LSFs (0 - (2^15-1)) [MAX_LPC_ORDER] (I).
pub fn silk_process_NLSFs(
    psEncC: &mut silk_encoder_state,
    PredCoef_Q12: &mut [[i16; MAX_LPC_ORDER as usize]; 2],
    pNLSF_Q15: &mut [i16],
    prev_NLSFq_Q15: &[i16],
) {
    let mut pNLSF0_temp_Q15 = [0i16; MAX_LPC_ORDER as usize];
    let mut pNLSFW_QW = [0i16; MAX_LPC_ORDER as usize];
    let mut pNLSFW0_temp_QW = [0i16; MAX_LPC_ORDER as usize];

    debug_assert!(psEncC.speech_activity_Q8 >= 0);
    debug_assert!(psEncC.speech_activity_Q8 <= SILK_FIX_CONST(1.0, 8));
    debug_assert!(psEncC.useInterpolatedNLSFs == 1 || psEncC.indices.NLSFInterpCoef_Q2 == (1 << 2));

    let predictLPCOrder = MAX_LPC_ORDER;

    /***********************/
    /* Calculate mu values */
    /***********************/
    /* NLSF_mu  = 0.003 - 0.0015 * psEnc->speech_activity; */
    let NLSF_mu_Q20 =
        silk_SMLAWB(SILK_FIX_CONST(0.003, 20), SILK_FIX_CONST(-0.001, 28), psEncC.speech_activity_Q8);

    debug_assert!(NLSF_mu_Q20 > 0);
    debug_assert!(NLSF_mu_Q20 <= SILK_FIX_CONST(0.005, 20));

    /* Calculate NLSF weights */
    silk_NLSF_VQ_weights_laroia(&mut pNLSFW_QW, pNLSF_Q15, predictLPCOrder);

    /* Update NLSF weights for interpolated NLSFs */
    let NLSFInterpCoef_Q2 = psEncC.indices.NLSFInterpCoef_Q2 as i32;
    let doInterpolate = (psEncC.useInterpolatedNLSFs == 1) && (NLSFInterpCoef_Q2 < 4);
    if doInterpolate {
        /* Calculate the interpolated NLSF vector for the first half */
        silk_interpolate(&mut pNLSF0_temp_Q15, prev_NLSFq_Q15, pNLSF_Q15, NLSFInterpCoef_Q2, predictLPCOrder);

        /* Calculate first half NLSF weights for the interpolated NLSFs */
        silk_NLSF_VQ_weights_laroia(&mut pNLSFW0_temp_QW, &pNLSF0_temp_Q15, predictLPCOrder);

        /* Update NLSF weights with contribution from first half */
        let i_sqr_Q15 = silk_LSHIFT(silk_SMULBB(NLSFInterpCoef_Q2, NLSFInterpCoef_Q2), 11) as i16;
        for i in 0..predictLPCOrder as usize {
            pNLSFW_QW[i] = (silk_RSHIFT(pNLSFW_QW[i] as i32, 1)
                + silk_RSHIFT(silk_SMULBB(pNLSFW0_temp_QW[i] as i32, i_sqr_Q15 as i32), 16)) as i16; /* silk_ADD16 */
            debug_assert!(pNLSFW_QW[i] >= 1);
        }
    }

    let signalType = psEncC.indices.signalType as i32;
    let survivors = psEncC.NLSF_MSVQ_Survivors;
    let psNLSF_CB = &silk_NLSF_CB_WB;
    silk_NLSF_encode(
        &mut psEncC.indices.NLSFIndices,
        pNLSF_Q15,
        psNLSF_CB,
        &pNLSFW_QW,
        NLSF_mu_Q20,
        survivors,
        signalType,
    );

    /* Convert quantized NLSFs back to LPC coefficients */
    silk_NLSF2A(&mut PredCoef_Q12[1], pNLSF_Q15, predictLPCOrder);

    if doInterpolate {
        /* Calculate the interpolated, quantized LSF vector for the first half */
        silk_interpolate(&mut pNLSF0_temp_Q15, prev_NLSFq_Q15, pNLSF_Q15, NLSFInterpCoef_Q2, predictLPCOrder);

        /* Convert back to LPC coefficients */
        silk_NLSF2A(&mut PredCoef_Q12[0], &pNLSF0_temp_Q15, predictLPCOrder);
    } else {
        /* Copy LPC coefficients for first half from second half */
        debug_assert!(predictLPCOrder <= MAX_LPC_ORDER);
        let (first, second) = PredCoef_Q12.split_at_mut(1);
        first[0][..predictLPCOrder as usize].copy_from_slice(&second[0][..predictLPCOrder as usize]);
    }
}
