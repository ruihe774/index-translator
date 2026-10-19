//! Port of silk/control_codec.c.
//!
//! The configuration is fixed (16 kHz API and internal rate, 20 ms packets, no LBRR), so the
//! resampler/bandwidth/packet-size/`silk_setup_fs` handling reduces to what `silk_init_encoder`
//! does once; only the complexity, packet loss and DTX settings are applied per frame.

use crate::silk::define::*;
use crate::silk::macros::*;
use crate::silk::pitch_est_defines::*;
use crate::silk::structs::silk_encoder_state;
use crate::silk::tuning_parameters::*;

/// Control encoder
pub fn silk_control_encoder(
    psEnc: &mut silk_encoder_state, /* I/O  Pointer to Silk encoder state               */
    Complexity: i32,                /* I    Complexity setting (0..=10)                 */
    PacketLoss_perc: i32,           /* I    Uplink packet loss in percent (0..=100)     */
    useDTX: i32,                    /* I    Flag to enable DTX                          */
) {
    psEnc.useDTX = useDTX;
    silk_setup_complexity(psEnc, Complexity);
    psEnc.PacketLoss_perc = PacketLoss_perc;
}

fn silk_setup_complexity(
    psEncC: &mut silk_encoder_state, /* I/O                      */
    Complexity: i32,                 /* I                        */
) {

    /* Set encoding complexity */
    debug_assert!(Complexity >= 0 && Complexity <= 10);
    if Complexity < 1 {
        psEncC.pitchEstimationComplexity = SILK_PE_MIN_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.8, 16);
        psEncC.pitchEstimationLPCOrder = 6;
        psEncC.shapingLPCOrder = 12;
        psEncC.la_shape = 3 * FS_KHZ;
        psEncC.nStatesDelayedDecision = 1;
        psEncC.useInterpolatedNLSFs = 0;
        psEncC.NLSF_MSVQ_Survivors = 2;
        psEncC.warping_Q16 = 0;
    } else if Complexity < 2 {
        psEncC.pitchEstimationComplexity = SILK_PE_MID_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.76, 16);
        psEncC.pitchEstimationLPCOrder = 8;
        psEncC.shapingLPCOrder = 14;
        psEncC.la_shape = 5 * FS_KHZ;
        psEncC.nStatesDelayedDecision = 1;
        psEncC.useInterpolatedNLSFs = 0;
        psEncC.NLSF_MSVQ_Survivors = 3;
        psEncC.warping_Q16 = 0;
    } else if Complexity < 3 {
        psEncC.pitchEstimationComplexity = SILK_PE_MIN_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.8, 16);
        psEncC.pitchEstimationLPCOrder = 6;
        psEncC.shapingLPCOrder = 12;
        psEncC.la_shape = 3 * FS_KHZ;
        psEncC.nStatesDelayedDecision = 2;
        psEncC.useInterpolatedNLSFs = 0;
        psEncC.NLSF_MSVQ_Survivors = 2;
        psEncC.warping_Q16 = 0;
    } else if Complexity < 4 {
        psEncC.pitchEstimationComplexity = SILK_PE_MID_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.76, 16);
        psEncC.pitchEstimationLPCOrder = 8;
        psEncC.shapingLPCOrder = 14;
        psEncC.la_shape = 5 * FS_KHZ;
        psEncC.nStatesDelayedDecision = 2;
        psEncC.useInterpolatedNLSFs = 0;
        psEncC.NLSF_MSVQ_Survivors = 4;
        psEncC.warping_Q16 = 0;
    } else if Complexity < 6 {
        psEncC.pitchEstimationComplexity = SILK_PE_MID_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.74, 16);
        psEncC.pitchEstimationLPCOrder = 10;
        psEncC.shapingLPCOrder = 16;
        psEncC.la_shape = 5 * FS_KHZ;
        psEncC.nStatesDelayedDecision = 2;
        psEncC.useInterpolatedNLSFs = 1;
        psEncC.NLSF_MSVQ_Survivors = 6;
        psEncC.warping_Q16 = FS_KHZ * SILK_FIX_CONST(WARPING_MULTIPLIER as f64, 16);
    } else if Complexity < 8 {
        psEncC.pitchEstimationComplexity = SILK_PE_MID_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.72, 16);
        psEncC.pitchEstimationLPCOrder = 12;
        psEncC.shapingLPCOrder = 20;
        psEncC.la_shape = 5 * FS_KHZ;
        psEncC.nStatesDelayedDecision = 3;
        psEncC.useInterpolatedNLSFs = 1;
        psEncC.NLSF_MSVQ_Survivors = 8;
        psEncC.warping_Q16 = FS_KHZ * SILK_FIX_CONST(WARPING_MULTIPLIER as f64, 16);
    } else {
        psEncC.pitchEstimationComplexity = SILK_PE_MAX_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.7, 16);
        psEncC.pitchEstimationLPCOrder = 16;
        psEncC.shapingLPCOrder = 24;
        psEncC.la_shape = 5 * FS_KHZ;
        psEncC.nStatesDelayedDecision = MAX_DEL_DEC_STATES;
        psEncC.useInterpolatedNLSFs = 1;
        psEncC.NLSF_MSVQ_Survivors = 16;
        psEncC.warping_Q16 = FS_KHZ * SILK_FIX_CONST(WARPING_MULTIPLIER as f64, 16);
    }

    psEncC.shapeWinLength = SUB_FRAME_LENGTH_MS * FS_KHZ + 2 * psEncC.la_shape;

    debug_assert!(psEncC.pitchEstimationLPCOrder <= MAX_FIND_PITCH_LPC_ORDER);
    debug_assert!(psEncC.shapingLPCOrder <= MAX_SHAPE_LPC_ORDER);
    debug_assert!(psEncC.nStatesDelayedDecision <= MAX_DEL_DEC_STATES);
    debug_assert!(psEncC.warping_Q16 <= 32767);
    debug_assert!(psEncC.la_shape <= LA_SHAPE_MAX);
    debug_assert!(psEncC.shapeWinLength <= SHAPE_LPC_WIN_MAX);
}
