//! Port of silk/float/find_pitch_lags_FLP.c.

use crate::silk::define::*;
use crate::silk::float::LPC_analysis_filter_FLP::silk_LPC_analysis_filter_FLP;
use crate::silk::float::apply_sine_window_FLP::silk_apply_sine_window_FLP;
use crate::silk::float::autocorrelation_FLP::silk_autocorrelation_FLP;
use crate::silk::float::bwexpander_FLP::silk_bwexpander_FLP;
use crate::silk::float::k2a_FLP::silk_k2a_FLP;
use crate::silk::float::pitch_analysis_core_FLP::silk_pitch_analysis_core_FLP;
use crate::silk::float::schur_FLP::silk_schur_FLP;
use crate::silk::float::structs_flp::{silk_encoder_control_FLP, silk_encoder_state_FLP};
use crate::silk::tuning_parameters::*;

/// Find pitch lags.
/// The speech signal `x` of C is `&psEnc.x_buf[x_off..]` (it points into the encoder's own
/// buffer); `x_off` must be at least `ltp_mem_length`.
pub fn silk_find_pitch_lags_FLP(
    psEnc: &mut silk_encoder_state_FLP,        /* I/O  Encoder state FLP                           */
    psEncCtrl: &mut silk_encoder_control_FLP, /* I/O  Encoder control FLP                         */
    res: &mut [f32],                          /* O    Residual                                    */
    x_off: usize,                             /* I    Speech signal: psEnc->x_buf + x_off         */
) {
    let mut auto_corr = [0f32; (MAX_FIND_PITCH_LPC_ORDER + 1) as usize];
    let mut A = [0f32; MAX_FIND_PITCH_LPC_ORDER as usize];
    let mut refl_coef = [0f32; MAX_FIND_PITCH_LPC_ORDER as usize];
    let mut Wsig = [0f32; FIND_PITCH_LPC_WIN_MAX as usize];

    /******************************************/
    /* Set up buffer lengths etc based on Fs  */
    /******************************************/
    let buf_len = psEnc.sCmn.la_pitch + psEnc.sCmn.frame_length + psEnc.sCmn.ltp_mem_length;

    /* Safety check */
    debug_assert!(buf_len >= psEnc.sCmn.pitch_LPC_win_length);

    let x_buf = &psEnc.x_buf[x_off - psEnc.sCmn.ltp_mem_length as usize..];

    let la_pitch = psEnc.sCmn.la_pitch as usize;
    let win_len = psEnc.sCmn.pitch_LPC_win_length as usize;

    /******************************************/
    /* Estimate LPC AR coefficients           */
    /******************************************/

    /* Calculate windowed signal */

    /* First LA_LTP samples */
    let mut x_buf_ptr = buf_len as usize - win_len;
    let mut Wsig_ptr = 0usize;
    silk_apply_sine_window_FLP(&mut Wsig[Wsig_ptr..], &x_buf[x_buf_ptr..], 1, la_pitch as i32);

    /* Middle non-windowed samples */
    Wsig_ptr += la_pitch;
    x_buf_ptr += la_pitch;
    let mid = win_len - (la_pitch << 1);
    Wsig[Wsig_ptr..Wsig_ptr + mid].copy_from_slice(&x_buf[x_buf_ptr..x_buf_ptr + mid]);

    /* Last LA_LTP samples */
    Wsig_ptr += mid;
    x_buf_ptr += mid;
    silk_apply_sine_window_FLP(&mut Wsig[Wsig_ptr..], &x_buf[x_buf_ptr..], 2, la_pitch as i32);

    /* Calculate autocorrelation sequence */
    silk_autocorrelation_FLP(&mut auto_corr, &Wsig, win_len as i32, psEnc.sCmn.pitchEstimationLPCOrder + 1);

    /* Add white noise, as a fraction of the energy */
    auto_corr[0] += auto_corr[0] * FIND_PITCH_WHITE_NOISE_FRACTION + 1.0;

    /* Calculate the reflection coefficients using Schur */
    let res_nrg = silk_schur_FLP(&mut refl_coef, &auto_corr, psEnc.sCmn.pitchEstimationLPCOrder);

    /* Prediction gain */
    psEncCtrl.predGain = auto_corr[0] / silk_max_float(res_nrg, 1.0);

    /* Convert reflection coefficients to prediction coefficients */
    silk_k2a_FLP(&mut A, &refl_coef, psEnc.sCmn.pitchEstimationLPCOrder);

    /* Bandwidth expansion */
    silk_bwexpander_FLP(&mut A, psEnc.sCmn.pitchEstimationLPCOrder, FIND_PITCH_BANDWIDTH_EXPANSION);

    /*****************************************/
    /* LPC analysis filtering                */
    /*****************************************/
    silk_LPC_analysis_filter_FLP(res, &A, x_buf, buf_len, psEnc.sCmn.pitchEstimationLPCOrder);

    if psEnc.sCmn.indices.signalType as i32 != TYPE_NO_VOICE_ACTIVITY && psEnc.sCmn.first_frame_after_reset == 0 {
        /* Threshold for pitch estimator */
        let mut thrhld: f32 = 0.6;
        thrhld -= 0.004f32 * psEnc.sCmn.pitchEstimationLPCOrder as f32;
        thrhld -= 0.1f32 * psEnc.sCmn.speech_activity_Q8 as f32 * (1.0f32 / 256.0);
        thrhld -= 0.15f32 * (psEnc.sCmn.prevSignalType as i32 >> 1) as f32;
        thrhld -= 0.1f32 * psEnc.sCmn.input_tilt_Q15 as f32 * (1.0f32 / 32768.0);

        /*****************************************/
        /* Call Pitch estimator                  */
        /*****************************************/
        if silk_pitch_analysis_core_FLP(
            res,
            &mut psEncCtrl.pitchL,
            &mut psEnc.sCmn.indices.lagIndex,
            &mut psEnc.sCmn.indices.contourIndex,
            &mut psEnc.LTPCorr,
            psEnc.sCmn.prevLag,
            psEnc.sCmn.pitchEstimationThreshold_Q16 as f32 / 65536.0,
            thrhld,
            psEnc.sCmn.fs_kHz,
            psEnc.sCmn.pitchEstimationComplexity,
            psEnc.sCmn.nb_subfr,
        ) == 0
        {
            psEnc.sCmn.indices.signalType = TYPE_VOICED as i8;
        } else {
            psEnc.sCmn.indices.signalType = TYPE_UNVOICED as i8;
        }
    } else {
        psEncCtrl.pitchL = [0; MAX_NB_SUBFR as usize];
        psEnc.sCmn.indices.lagIndex = 0;
        psEnc.sCmn.indices.contourIndex = 0;
        psEnc.LTPCorr = 0.0;
    }
}

/// `silk_max_float` from SigProc_FLP.h
#[inline(always)]
pub(crate) fn silk_max_float(a: f32, b: f32) -> f32 {
    if a > b { a } else { b }
}

/// `silk_min_float` from SigProc_FLP.h
#[inline(always)]
pub(crate) fn silk_min_float(a: f32, b: f32) -> f32 {
    if a < b { a } else { b }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::silk::float::encode_frame_FLP::tests::{c, for_each_frame, same_ctrl, same_state};

    #[test]
    fn matches_c() {
        for_each_frame(|fr, what| {
            let mut r = fr.clone();
            let mut cc = fr.clone();
            let off = r.st.sCmn.ltp_mem_length as usize;
            silk_find_pitch_lags_FLP(&mut r.st, &mut r.ctrl, &mut r.res_pitch, off);
            unsafe {
                let x = cc.st.x_buf.as_ptr().add(off);
                c::silk_find_pitch_lags_FLP(&mut *cc.st, &mut cc.ctrl, cc.res_pitch.as_mut_ptr(), x, 0);
            }
            same_state(&r.st, &cc.st, what);
            same_ctrl(&r.ctrl, &cc.ctrl, what);
            assert!(r.res_pitch.iter().zip(cc.res_pitch.iter()).all(|(a, b)| a.to_bits() == b.to_bits()), "{what}: res");
        });
    }
}
