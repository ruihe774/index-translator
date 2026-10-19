//! Port of silk/float/process_gains_FLP.c.

use crate::silk::define::*;
use crate::silk::float::find_pitch_lags_FLP::silk_min_float;
use crate::silk::float::sigproc_flp::silk_sigmoid;
use crate::silk::float::structs_flp::{silk_encoder_control_FLP, silk_encoder_state_FLP};
use crate::silk::gain_quant::silk_gains_quant;
use crate::silk::tables::silk_Quantization_Offsets_Q10;
use crate::silk::tuning_parameters::*;

/// Processing of gains
pub fn silk_process_gains_FLP(
    psEnc: &mut silk_encoder_state_FLP,        /* I/O  Encoder state FLP                           */
    psEncCtrl: &mut silk_encoder_control_FLP, /* I/O  Encoder control FLP                         */
    condCoding: i32,                          /* I    The type of conditional coding to use       */
) {
    let psShapeSt = &mut psEnc.sShape;
    let sCmn = &mut psEnc.sCmn;
    let mut pGains_Q16 = [0i32; MAX_NB_SUBFR as usize];
    let nb_subfr = sCmn.nb_subfr as usize;

    /* Gain reduction when LTP coding gain is high */
    if sCmn.indices.signalType as i32 == TYPE_VOICED {
        let s = 1.0f32 - 0.5f32 * silk_sigmoid(0.25f32 * (psEncCtrl.LTPredCodGain - 12.0f32));
        for k in 0..nb_subfr {
            psEncCtrl.Gains[k] *= s;
        }
    }

    /* Limit the quantized signal */
    let InvMaxSqrVal = (libm::pow(2.0, (0.33f32 * (21.0f32 - sCmn.SNR_dB_Q7 as f32 * (1.0f32 / 128.0f32))) as f64)
        / sCmn.subfr_length as f64) as f32;

    for k in 0..nb_subfr {
        /* Soft limit on ratio residual energy and squared gains */
        let mut gain = psEncCtrl.Gains[k];
        gain = libm::sqrt((gain * gain + psEncCtrl.ResNrg[k] * InvMaxSqrVal) as f64) as f32;
        psEncCtrl.Gains[k] = silk_min_float(gain, 32767.0f32);
    }

    /* Prepare gains for noise shaping quantization */
    for k in 0..nb_subfr {
        pGains_Q16[k] = (psEncCtrl.Gains[k] * 65536.0f32) as i32;
    }

    /* Save unquantized gains and gain Index */
    psEncCtrl.GainsUnq_Q16[..nb_subfr].copy_from_slice(&pGains_Q16[..nb_subfr]);
    psEncCtrl.lastGainIndexPrev = psShapeSt.LastGainIndex;

    /* Quantize gains */
    silk_gains_quant(
        &mut sCmn.indices.GainsIndices,
        &mut pGains_Q16,
        &mut psShapeSt.LastGainIndex,
        (condCoding == CODE_CONDITIONALLY) as i32,
        sCmn.nb_subfr,
    );

    /* Overwrite unquantized gains with quantized gains and convert back to Q0 from Q16 */
    for k in 0..nb_subfr {
        psEncCtrl.Gains[k] = pGains_Q16[k] as f32 / 65536.0f32;
    }

    /* Set quantizer offset for voiced signals. Larger offset when LTP coding gain is low or tilt is high (ie low-pass) */
    if sCmn.indices.signalType as i32 == TYPE_VOICED {
        if psEncCtrl.LTPredCodGain + sCmn.input_tilt_Q15 as f32 * (1.0f32 / 32768.0f32) > 1.0f32 {
            sCmn.indices.quantOffsetType = 0;
        } else {
            sCmn.indices.quantOffsetType = 1;
        }
    }

    /* Quantizer boundary adjustment */
    let quant_offset = silk_Quantization_Offsets_Q10[(sCmn.indices.signalType >> 1) as usize]
        [sCmn.indices.quantOffsetType as usize] as f32
        / 1024.0f32;
    psEncCtrl.Lambda = LAMBDA_OFFSET
        + LAMBDA_DELAYED_DECISIONS * sCmn.nStatesDelayedDecision as f32
        + LAMBDA_SPEECH_ACT * sCmn.speech_activity_Q8 as f32 * (1.0f32 / 256.0f32)
        + LAMBDA_INPUT_QUALITY * psEncCtrl.input_quality
        + LAMBDA_CODING_QUALITY * psEncCtrl.coding_quality
        + LAMBDA_QUANT_OFFSET * quant_offset;

    debug_assert!(psEncCtrl.Lambda > 0.0f32);
    debug_assert!(psEncCtrl.Lambda < 2.0f32);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::silk::float::encode_frame_FLP::tests::{c, for_each_frame, same_ctrl, same_state};

    #[test]
    fn matches_c() {
        for_each_frame(|fr, what| {
            for cond in [CODE_INDEPENDENTLY, CODE_CONDITIONALLY] {
                let mut fr = fr.clone();
                c::find_pitch_lags(&mut fr);
                c::noise_shape_analysis(&mut fr);
                c::find_pred_coefs(&mut fr, cond);
                let mut r = fr.clone();
                let mut cc = fr.clone();
                silk_process_gains_FLP(&mut r.st, &mut r.ctrl, cond);
                c::process_gains(&mut cc, cond);
                same_state(&r.st, &cc.st, what);
                same_ctrl(&r.ctrl, &cc.ctrl, what);
            }
        });
    }
}
