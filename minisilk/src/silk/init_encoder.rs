//! Port of silk/init_encoder.c, including the one-time part of `silk_setup_fs` from
//! silk/control_codec.c (the first `silk_control_encoder` call finds `fs_kHz == 0` and resets
//! the state; with the fixed 16 kHz / 20 ms configuration that happens exactly once, so it is
//! folded in here).

use crate::silk::VAD::silk_VAD_Init;
use crate::silk::define::*;
use crate::silk::float::structs_flp::silk_encoder_state_FLP;
use crate::silk::lin2log::silk_lin2log;
use crate::silk::macros::*;
use crate::silk::tuning_parameters::*;

/// Initialize Silk Encoder state
pub fn silk_init_encoder(
    psEnc: &mut silk_encoder_state_FLP, /* I/O  Pointer to Silk FIX encoder state                                           */
) {
    /* Clear the entire encoder state */
    // SAFETY: all-zero is a valid silk_encoder_state_FLP.
    unsafe { core::ptr::write_bytes(psEnc as *mut silk_encoder_state_FLP, 0, 1) };

    psEnc.sCmn.variable_HP_smth1_Q15 =
        silk_LSHIFT(silk_lin2log(SILK_FIX_CONST(VARIABLE_HP_MIN_CUTOFF_HZ as f64, 16)) - (16 << 7), 8);

    /* Used to deactivate LSF interpolation, pitch prediction */
    psEnc.sCmn.first_frame_after_reset = 1;

    /* Initialize Silk VAD */
    silk_VAD_Init(&mut psEnc.sCmn.sVAD);

    /* Initialize non-zero parameters (silk_setup_fs) */
    psEnc.sCmn.prevLag = 100;
    psEnc.sShape.LastGainIndex = 10;
    psEnc.sCmn.sNSQ.lagPrev = 100;
    psEnc.sCmn.sNSQ.prev_gain_Q16 = 65536;
    psEnc.sCmn.prevSignalType = TYPE_NO_VOICE_ACTIVITY as i8;
}
