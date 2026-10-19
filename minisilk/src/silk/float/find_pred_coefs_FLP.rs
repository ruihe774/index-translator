//! Port of silk/float/find_pred_coefs_FLP.c.

use crate::silk::define::*;
use crate::silk::float::LTP_analysis_filter_FLP::silk_LTP_analysis_filter_FLP;
use crate::silk::float::LTP_scale_ctrl_FLP::silk_LTP_scale_ctrl_FLP;
use crate::silk::float::find_LPC_FLP::silk_find_LPC_FLP;
use crate::silk::float::find_LTP_FLP::silk_find_LTP_FLP;
use crate::silk::float::residual_energy_FLP::silk_residual_energy_FLP;
use crate::silk::float::scale_copy_vector_FLP::silk_scale_copy_vector_FLP;
use crate::silk::float::structs_flp::{silk_encoder_control_FLP, silk_encoder_state_FLP};
use crate::silk::float::wrappers_FLP::{silk_process_NLSFs_FLP, silk_quant_LTP_gains_FLP};

const MAX_NB_SUBFR_: usize = MAX_NB_SUBFR as usize;
const LTP_ORDER_: usize = LTP_ORDER as usize;

/// Find LPC and LTP coefficients.
/// The pitch residual `res_pitch` of C is `&res_pitch[res_off..]` (read from before
/// `res_off` for the LTP analysis); the speech signal `x` of C is `&psEnc.x_buf[x_off..]`.
pub fn silk_find_pred_coefs_FLP(
    psEnc: &mut silk_encoder_state_FLP,        /* I/O  Encoder state FLP                           */
    psEncCtrl: &mut silk_encoder_control_FLP, /* I/O  Encoder control FLP                         */
    res_pitch: &[f32],                        /* I    Residual from pitch analysis                */
    res_off: usize,
    x_off: usize,                             /* I    Speech signal: psEnc->x_buf + x_off         */
    condCoding: i32,                          /* I    The type of conditional coding to use       */
) {
    let mut XXLTP = [0f32; MAX_NB_SUBFR_ * LTP_ORDER_ * LTP_ORDER_];
    let mut xXLTP = [0f32; MAX_NB_SUBFR_ * LTP_ORDER_];
    let mut invGains = [0f32; MAX_NB_SUBFR_];
    /* Set to NLSF_Q15 to zero so we don't copy junk to the state. */
    let mut NLSF_Q15 = [0i16; MAX_LPC_ORDER as usize];
    let mut LPC_in_pre = [0f32; (MAX_NB_SUBFR * MAX_LPC_ORDER + MAX_FRAME_LENGTH) as usize];
    let minInvGain: f32;

    let nb_subfr = psEnc.sCmn.nb_subfr;
    let subfr_length = psEnc.sCmn.subfr_length;
    let predictLPCOrder = psEnc.sCmn.predictLPCOrder;

    /* Weighting for weighted least squares */
    for i in 0..nb_subfr as usize {
        debug_assert!(psEncCtrl.Gains[i] > 0.0f32);
        invGains[i] = 1.0f32 / psEncCtrl.Gains[i];
    }

    if psEnc.sCmn.indices.signalType as i32 == TYPE_VOICED {
        /**********/
        /* VOICED */
        /**********/
        debug_assert!(psEnc.sCmn.ltp_mem_length - predictLPCOrder >= psEncCtrl.pitchL[0] + LTP_ORDER / 2);

        /* LTP analysis */
        silk_find_LTP_FLP(&mut XXLTP, &mut xXLTP, res_pitch, res_off, &psEncCtrl.pitchL, subfr_length, nb_subfr);

        /* Quantize LTP gain parameters */
        silk_quant_LTP_gains_FLP(
            &mut psEncCtrl.LTPCoef,
            &mut psEnc.sCmn.indices.LTPIndex,
            &mut psEnc.sCmn.indices.PERIndex,
            &mut psEnc.sCmn.sum_log_gain_Q7,
            &mut psEncCtrl.LTPredCodGain,
            &XXLTP,
            &xXLTP,
            subfr_length,
            nb_subfr,
        );

        /* Control LTP scaling */
        silk_LTP_scale_ctrl_FLP(psEnc, psEncCtrl, condCoding);

        /* Create LTP residual */
        silk_LTP_analysis_filter_FLP(
            &mut LPC_in_pre,
            &psEnc.x_buf,
            x_off - predictLPCOrder as usize,
            &psEncCtrl.LTPCoef,
            &psEncCtrl.pitchL,
            &invGains,
            subfr_length,
            nb_subfr,
            predictLPCOrder,
        );
    } else {
        /************/
        /* UNVOICED */
        /************/
        /* Create signal with prepended subframes, scaled by inverse gains */
        let mut x_ptr = x_off - predictLPCOrder as usize;
        let mut x_pre_ptr = 0usize;
        for i in 0..nb_subfr as usize {
            silk_scale_copy_vector_FLP(
                &mut LPC_in_pre[x_pre_ptr..],
                &psEnc.x_buf[x_ptr..],
                invGains[i],
                subfr_length + predictLPCOrder,
            );
            x_pre_ptr += (subfr_length + predictLPCOrder) as usize;
            x_ptr += subfr_length as usize;
        }
        psEncCtrl.LTPCoef[..nb_subfr as usize * LTP_ORDER_].fill(0.0);
        psEncCtrl.LTPredCodGain = 0.0f32;
        psEnc.sCmn.sum_log_gain_Q7 = 0;
    }

    /* Limit on total predictive coding gain */
    if psEnc.sCmn.first_frame_after_reset != 0 {
        minInvGain = 1.0f32 / MAX_PREDICTION_POWER_GAIN_AFTER_RESET;
    } else {
        let mut g = libm::pow(2.0, (psEncCtrl.LTPredCodGain / 3.0f32) as f64) as f32 / MAX_PREDICTION_POWER_GAIN;
        g /= 0.25f32 + 0.75f32 * psEncCtrl.coding_quality;
        minInvGain = g;
    }

    /* LPC_in_pre contains the LTP-filtered input for voiced, and the unfiltered input for unvoiced */
    silk_find_LPC_FLP(&mut psEnc.sCmn, &mut NLSF_Q15, &LPC_in_pre, minInvGain);

    /* Quantize LSFs */
    let prev_NLSFq_Q15 = psEnc.sCmn.prev_NLSFq_Q15;
    silk_process_NLSFs_FLP(&mut psEnc.sCmn, &mut psEncCtrl.PredCoef, &mut NLSF_Q15, &prev_NLSFq_Q15);

    /* Calculate residual energy using quantized LPC coefficients */
    silk_residual_energy_FLP(
        &mut psEncCtrl.ResNrg,
        &LPC_in_pre,
        &psEncCtrl.PredCoef,
        &psEncCtrl.Gains,
        subfr_length,
        nb_subfr,
        predictLPCOrder,
    );

    /* Copy to prediction struct for use in next frame for interpolation */
    psEnc.sCmn.prev_NLSFq_Q15 = NLSF_Q15;
}
