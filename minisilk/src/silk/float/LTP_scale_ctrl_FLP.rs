//! Port of silk/float/LTP_scale_ctrl_FLP.c.

use crate::silk::float::structs_flp::{silk_encoder_control_FLP, silk_encoder_state_FLP};
use crate::silk::log2lin::silk_log2lin;
use crate::silk::macros::*;

/// `silk_SMULBB` with a float first operand: C converts the float to opus_int16 (truncation;
/// on wasm32 via a 32-bit conversion).
#[inline(always)]
fn smulbb_f(a: f32, b: i32) -> i32 {
    silk_SMULBB(a as i32, b)
}

pub fn silk_LTP_scale_ctrl_FLP(
    psEnc: &mut silk_encoder_state_FLP,        /* I/O  Encoder state FLP                           */
    psEncCtrl: &mut silk_encoder_control_FLP, /* I/O  Encoder control FLP                         */
) {
    /* First (and only) frame in packet, no LBRR */
    let round_loss = psEnc.sCmn.PacketLoss_perc;
    psEnc.sCmn.indices.LTP_scaleIndex =
        (smulbb_f(psEncCtrl.LTPredCodGain, round_loss) > silk_log2lin(2900 - psEnc.sCmn.SNR_dB_Q7)) as i8;
    psEnc.sCmn.indices.LTP_scaleIndex +=
        (smulbb_f(psEncCtrl.LTPredCodGain, round_loss) > silk_log2lin(3900 - psEnc.sCmn.SNR_dB_Q7)) as i8;
}
