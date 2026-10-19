//! Port of silk/float/LTP_scale_ctrl_FLP.c.

use crate::silk::define::*;
use crate::silk::float::structs_flp::{silk_encoder_control_FLP, silk_encoder_state_FLP};
use crate::silk::log2lin::silk_log2lin;
use crate::silk::macros::*;
use crate::silk::tables::silk_LTPScales_table_Q14;

/// `silk_SMULBB` with a float first operand: C converts the float to opus_int16 (truncation;
/// on wasm32 via a 32-bit conversion).
#[inline(always)]
fn smulbb_f(a: f32, b: i32) -> i32 {
    silk_SMULBB(a as i32, b)
}

pub fn silk_LTP_scale_ctrl_FLP(
    psEnc: &mut silk_encoder_state_FLP,        /* I/O  Encoder state FLP                           */
    psEncCtrl: &mut silk_encoder_control_FLP, /* I/O  Encoder control FLP                         */
    condCoding: i32,                          /* I    The type of conditional coding to use       */
) {
    if condCoding == CODE_INDEPENDENTLY {
        /* Only scale if first frame in packet */
        let mut round_loss = psEnc.sCmn.PacketLoss_perc * psEnc.sCmn.nFramesPerPacket;
        if psEnc.sCmn.LBRR_flag != 0 {
            /* LBRR reduces the effective loss. In practice, it does not square the loss because
               losses aren't independent, but that still seems to work best. We also never go below 2%. */
            round_loss = 2 + silk_SMULBB(round_loss, round_loss) / 100;
        }
        psEnc.sCmn.indices.LTP_scaleIndex =
            (smulbb_f(psEncCtrl.LTPredCodGain, round_loss) > silk_log2lin(2900 - psEnc.sCmn.SNR_dB_Q7)) as i8;
        psEnc.sCmn.indices.LTP_scaleIndex +=
            (smulbb_f(psEncCtrl.LTPredCodGain, round_loss) > silk_log2lin(3900 - psEnc.sCmn.SNR_dB_Q7)) as i8;
    } else {
        /* Default is minimum scaling */
        psEnc.sCmn.indices.LTP_scaleIndex = 0;
    }

    psEncCtrl.LTP_scale = silk_LTPScales_table_Q14[psEnc.sCmn.indices.LTP_scaleIndex as usize] as f32 / 16384.0f32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::silk::float::encode_frame_FLP::tests::{c, for_each_frame, same_ctrl, same_state};
    use crate::testutil::Rng;

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(81);
        for_each_frame(|fr, what| {
            for cond in [CODE_INDEPENDENTLY, CODE_INDEPENDENTLY_NO_LTP_SCALING, CODE_CONDITIONALLY] {
                let mut fr = fr.clone();
                fr.ctrl.LTPredCodGain = rng.f32_unit().abs() * 30.0;
                fr.st.sCmn.PacketLoss_perc = rng.range(0, 100);
                fr.st.sCmn.LBRR_flag = (rng.range(0, 3) == 0) as i8;
                let mut r = fr.clone();
                let mut cc = fr.clone();
                silk_LTP_scale_ctrl_FLP(&mut r.st, &mut r.ctrl, cond);
                unsafe { c::silk_LTP_scale_ctrl_FLP(&mut *cc.st, &mut cc.ctrl, cond) };
                same_state(&r.st, &cc.st, what);
                same_ctrl(&r.ctrl, &cc.ctrl, what);
            }
        });
    }
}
