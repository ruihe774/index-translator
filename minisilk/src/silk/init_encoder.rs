//! Port of silk/init_encoder.c.

use crate::silk::VAD::silk_VAD_Init;
use crate::silk::float::structs_flp::silk_encoder_state_FLP;
use crate::silk::lin2log::silk_lin2log;
use crate::silk::macros::*;
use crate::silk::tuning_parameters::*;

/// Initialize Silk Encoder state
pub fn silk_init_encoder(
    psEnc: &mut silk_encoder_state_FLP, /* I/O  Pointer to Silk FIX encoder state                                           */
) -> i32 {
    let mut ret = 0;

    /* Clear the entire encoder state */
    // SAFETY: all-zero is a valid silk_encoder_state_FLP (null table pointers, as in C).
    unsafe { core::ptr::write_bytes(psEnc as *mut silk_encoder_state_FLP, 0, 1) };

    psEnc.sCmn.arch = 0;

    psEnc.sCmn.variable_HP_smth1_Q15 =
        silk_LSHIFT(silk_lin2log(SILK_FIX_CONST(VARIABLE_HP_MIN_CUTOFF_HZ as f64, 16)) - (16 << 7), 8);
    psEnc.sCmn.variable_HP_smth2_Q15 = psEnc.sCmn.variable_HP_smth1_Q15;

    /* Used to deactivate LSF interpolation, pitch prediction */
    psEnc.sCmn.first_frame_after_reset = 1;

    /* Initialize Silk VAD */
    ret += silk_VAD_Init(&mut psEnc.sCmn.sVAD);

    ret
}
