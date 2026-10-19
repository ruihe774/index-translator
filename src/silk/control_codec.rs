//! Port of silk/control_codec.c.
//!
//! minisilk's configuration is fixed (16 kHz API and internal rate, 20 ms packets, no LBRR),
//! so the resampler is only ever initialized once (16 kHz -> 16 kHz) and the re-sampling of
//! buffered data on a rate change, 10/40/60 ms packets and LBRR gain setup are not ported.

use crate::silk::control_audio_bandwidth::silk_control_audio_bandwidth;
use crate::silk::define::*;
use crate::silk::float::structs_flp::silk_encoder_state_FLP;
use crate::silk::macros::*;
use crate::silk::pitch_est_defines::*;
use crate::silk::resampler::silk_resampler_init;
use crate::silk::structs::{silk_EncControlStruct, silk_encoder_state};
use crate::silk::tables::*;
use crate::silk::tuning_parameters::*;

/// Control encoder
pub fn silk_control_encoder(
    psEnc: &mut silk_encoder_state_FLP,     /* I/O  Pointer to Silk encoder state                                               */
    encControl: &mut silk_EncControlStruct, /* I    Control structure                                                           */
    allow_bw_switch: i32,                   /* I    Flag to allow switching audio bandwidth                                     */
    channelNb: i32,                         /* I    Channel number                                                              */
    force_fs_kHz: i32,
) -> i32 {
    let mut ret = 0;

    psEnc.sCmn.useDTX = encControl.useDTX;
    psEnc.sCmn.useCBR = encControl.useCBR;
    psEnc.sCmn.API_fs_Hz = encControl.API_sampleRate;
    psEnc.sCmn.maxInternal_fs_Hz = encControl.maxInternalSampleRate;
    psEnc.sCmn.minInternal_fs_Hz = encControl.minInternalSampleRate;
    psEnc.sCmn.desiredInternal_fs_Hz = encControl.desiredInternalSampleRate;
    psEnc.sCmn.useInBandFEC = encControl.useInBandFEC;
    psEnc.sCmn.nChannelsAPI = encControl.nChannelsAPI;
    psEnc.sCmn.nChannelsInternal = encControl.nChannelsInternal;
    psEnc.sCmn.allow_bandwidth_switch = allow_bw_switch;
    psEnc.sCmn.channelNb = channelNb;

    if psEnc.sCmn.controlled_since_last_payload != 0 && psEnc.sCmn.prefillFlag == 0 {
        if psEnc.sCmn.API_fs_Hz != psEnc.sCmn.prev_API_fs_Hz && psEnc.sCmn.fs_kHz > 0 {
            /* Change in API sampling rate in the middle of encoding a packet */
            ret += silk_setup_resamplers(psEnc, psEnc.sCmn.fs_kHz);
        }
        return ret;
    }

    /* Beyond this point we know that there are no previously coded frames in the payload buffer */

    /********************************************/
    /* Determine internal sampling rate         */
    /********************************************/
    let mut fs_kHz = silk_control_audio_bandwidth(&mut psEnc.sCmn, encControl);
    if force_fs_kHz != 0 {
        fs_kHz = force_fs_kHz;
    }
    /********************************************/
    /* Prepare resampler and buffered data      */
    /********************************************/
    ret += silk_setup_resamplers(psEnc, fs_kHz);

    /********************************************/
    /* Set internal sampling frequency          */
    /********************************************/
    ret += silk_setup_fs(psEnc, fs_kHz, encControl.payloadSize_ms);

    /********************************************/
    /* Set encoding complexity                  */
    /********************************************/
    ret += silk_setup_complexity(&mut psEnc.sCmn, encControl.complexity);

    /********************************************/
    /* Set packet loss rate measured by farend  */
    /********************************************/
    psEnc.sCmn.PacketLoss_perc = encControl.packetLossPercentage;

    /********************************************/
    /* Set LBRR usage                           */
    /********************************************/
    ret += silk_setup_LBRR(&mut psEnc.sCmn, encControl);

    psEnc.sCmn.controlled_since_last_payload = 1;

    ret
}

fn silk_setup_resamplers(
    psEnc: &mut silk_encoder_state_FLP, /* I/O                      */
    fs_kHz: i32,                        /* I                        */
) -> i32 {
    let mut ret = SILK_NO_ERROR;

    if psEnc.sCmn.fs_kHz != fs_kHz || psEnc.sCmn.prev_API_fs_Hz != psEnc.sCmn.API_fs_Hz {
        /* The API and internal rates never change after the first call, so the resampler is
           only initialized once; re-sampling buffered data to a new rate is not ported. */
        debug_assert!(psEnc.sCmn.fs_kHz == 0);
        /* Initialize the resampler for enc_API.c preparing resampling from API_fs_Hz to fs_kHz */
        ret += silk_resampler_init(&mut psEnc.sCmn.resampler_state, psEnc.sCmn.API_fs_Hz, fs_kHz * 1000, 1);
    }

    psEnc.sCmn.prev_API_fs_Hz = psEnc.sCmn.API_fs_Hz;

    ret
}

fn silk_setup_fs(
    psEnc: &mut silk_encoder_state_FLP, /* I/O                      */
    fs_kHz: i32,                        /* I                        */
    PacketSize_ms: i32,                 /* I                        */
) -> i32 {
    let mut ret = SILK_NO_ERROR;

    /* Set packet size */
    if PacketSize_ms != psEnc.sCmn.PacketSize_ms {
        if PacketSize_ms != 10 && PacketSize_ms != 20 && PacketSize_ms != 40 && PacketSize_ms != 60 {
            ret = SILK_ENC_PACKET_SIZE_NOT_SUPPORTED;
        }
        /* Only 20 ms packets (one 20 ms frame) are supported */
        debug_assert!(PacketSize_ms == MAX_FRAME_LENGTH_MS);
        psEnc.sCmn.nFramesPerPacket = silk_DIV32_16(PacketSize_ms, MAX_FRAME_LENGTH_MS);
        psEnc.sCmn.nb_subfr = MAX_NB_SUBFR;
        psEnc.sCmn.frame_length = silk_SMULBB(20, fs_kHz);
        psEnc.sCmn.pitch_LPC_win_length = silk_SMULBB(FIND_PITCH_LPC_WIN_MS, fs_kHz);
        debug_assert!(psEnc.sCmn.fs_kHz != 8);
        psEnc.sCmn.pitch_contour_iCDF = silk_pitch_contour_iCDF.as_ptr();
        psEnc.sCmn.PacketSize_ms = PacketSize_ms;
        psEnc.sCmn.TargetRate_bps = 0; /* trigger new SNR computation */
    }

    /* Set internal sampling frequency */
    debug_assert!(fs_kHz == 16);
    debug_assert!(psEnc.sCmn.nb_subfr == 4);
    if psEnc.sCmn.fs_kHz != fs_kHz {
        /* reset part of the state */
        // SAFETY: all-zero is a valid value for these plain-data structs.
        unsafe {
            core::ptr::write_bytes(&mut psEnc.sShape as *mut _, 0, 1);
            core::ptr::write_bytes(&mut psEnc.sCmn.sNSQ as *mut _, 0, 1);
        }
        psEnc.sCmn.prev_NLSFq_Q15 = [0; MAX_LPC_ORDER as usize];
        psEnc.sCmn.sLP.In_LP_State = [0; 2];
        psEnc.sCmn.inputBufIx = 0;
        psEnc.sCmn.nFramesEncoded = 0;
        psEnc.sCmn.TargetRate_bps = 0; /* trigger new SNR computation */

        /* Initialize non-zero parameters */
        psEnc.sCmn.prevLag = 100;
        psEnc.sCmn.first_frame_after_reset = 1;
        psEnc.sShape.LastGainIndex = 10;
        psEnc.sCmn.sNSQ.lagPrev = 100;
        psEnc.sCmn.sNSQ.prev_gain_Q16 = 65536;
        psEnc.sCmn.prevSignalType = TYPE_NO_VOICE_ACTIVITY as i8;

        psEnc.sCmn.fs_kHz = fs_kHz;
        /* fs_kHz == 16, nb_subfr == MAX_NB_SUBFR */
        psEnc.sCmn.pitch_contour_iCDF = silk_pitch_contour_iCDF.as_ptr();
        psEnc.sCmn.predictLPCOrder = MAX_LPC_ORDER;
        psEnc.sCmn.psNLSF_CB = &silk_NLSF_CB_WB;
        psEnc.sCmn.subfr_length = SUB_FRAME_LENGTH_MS * fs_kHz;
        psEnc.sCmn.frame_length = silk_SMULBB(psEnc.sCmn.subfr_length, psEnc.sCmn.nb_subfr);
        psEnc.sCmn.ltp_mem_length = silk_SMULBB(LTP_MEM_LENGTH_MS, fs_kHz);
        psEnc.sCmn.la_pitch = silk_SMULBB(LA_PITCH_MS, fs_kHz);
        psEnc.sCmn.max_pitch_lag = silk_SMULBB(18, fs_kHz);
        psEnc.sCmn.pitch_LPC_win_length = silk_SMULBB(FIND_PITCH_LPC_WIN_MS, fs_kHz);
        psEnc.sCmn.pitch_lag_low_bits_iCDF = silk_uniform8_iCDF.as_ptr();
    }

    /* Check that settings are valid */
    debug_assert!((psEnc.sCmn.subfr_length * psEnc.sCmn.nb_subfr) == psEnc.sCmn.frame_length);

    ret
}

fn silk_setup_complexity(
    psEncC: &mut silk_encoder_state, /* I/O                      */
    Complexity: i32,                 /* I                        */
) -> i32 {
    let ret = 0;

    /* Set encoding complexity */
    debug_assert!(Complexity >= 0 && Complexity <= 10);
    if Complexity < 1 {
        psEncC.pitchEstimationComplexity = SILK_PE_MIN_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.8, 16);
        psEncC.pitchEstimationLPCOrder = 6;
        psEncC.shapingLPCOrder = 12;
        psEncC.la_shape = 3 * psEncC.fs_kHz;
        psEncC.nStatesDelayedDecision = 1;
        psEncC.useInterpolatedNLSFs = 0;
        psEncC.NLSF_MSVQ_Survivors = 2;
        psEncC.warping_Q16 = 0;
    } else if Complexity < 2 {
        psEncC.pitchEstimationComplexity = SILK_PE_MID_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.76, 16);
        psEncC.pitchEstimationLPCOrder = 8;
        psEncC.shapingLPCOrder = 14;
        psEncC.la_shape = 5 * psEncC.fs_kHz;
        psEncC.nStatesDelayedDecision = 1;
        psEncC.useInterpolatedNLSFs = 0;
        psEncC.NLSF_MSVQ_Survivors = 3;
        psEncC.warping_Q16 = 0;
    } else if Complexity < 3 {
        psEncC.pitchEstimationComplexity = SILK_PE_MIN_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.8, 16);
        psEncC.pitchEstimationLPCOrder = 6;
        psEncC.shapingLPCOrder = 12;
        psEncC.la_shape = 3 * psEncC.fs_kHz;
        psEncC.nStatesDelayedDecision = 2;
        psEncC.useInterpolatedNLSFs = 0;
        psEncC.NLSF_MSVQ_Survivors = 2;
        psEncC.warping_Q16 = 0;
    } else if Complexity < 4 {
        psEncC.pitchEstimationComplexity = SILK_PE_MID_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.76, 16);
        psEncC.pitchEstimationLPCOrder = 8;
        psEncC.shapingLPCOrder = 14;
        psEncC.la_shape = 5 * psEncC.fs_kHz;
        psEncC.nStatesDelayedDecision = 2;
        psEncC.useInterpolatedNLSFs = 0;
        psEncC.NLSF_MSVQ_Survivors = 4;
        psEncC.warping_Q16 = 0;
    } else if Complexity < 6 {
        psEncC.pitchEstimationComplexity = SILK_PE_MID_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.74, 16);
        psEncC.pitchEstimationLPCOrder = 10;
        psEncC.shapingLPCOrder = 16;
        psEncC.la_shape = 5 * psEncC.fs_kHz;
        psEncC.nStatesDelayedDecision = 2;
        psEncC.useInterpolatedNLSFs = 1;
        psEncC.NLSF_MSVQ_Survivors = 6;
        psEncC.warping_Q16 = psEncC.fs_kHz * SILK_FIX_CONST(WARPING_MULTIPLIER as f64, 16);
    } else if Complexity < 8 {
        psEncC.pitchEstimationComplexity = SILK_PE_MID_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.72, 16);
        psEncC.pitchEstimationLPCOrder = 12;
        psEncC.shapingLPCOrder = 20;
        psEncC.la_shape = 5 * psEncC.fs_kHz;
        psEncC.nStatesDelayedDecision = 3;
        psEncC.useInterpolatedNLSFs = 1;
        psEncC.NLSF_MSVQ_Survivors = 8;
        psEncC.warping_Q16 = psEncC.fs_kHz * SILK_FIX_CONST(WARPING_MULTIPLIER as f64, 16);
    } else {
        psEncC.pitchEstimationComplexity = SILK_PE_MAX_COMPLEX;
        psEncC.pitchEstimationThreshold_Q16 = SILK_FIX_CONST(0.7, 16);
        psEncC.pitchEstimationLPCOrder = 16;
        psEncC.shapingLPCOrder = 24;
        psEncC.la_shape = 5 * psEncC.fs_kHz;
        psEncC.nStatesDelayedDecision = MAX_DEL_DEC_STATES;
        psEncC.useInterpolatedNLSFs = 1;
        psEncC.NLSF_MSVQ_Survivors = 16;
        psEncC.warping_Q16 = psEncC.fs_kHz * SILK_FIX_CONST(WARPING_MULTIPLIER as f64, 16);
    }

    /* Do not allow higher pitch estimation LPC order than predict LPC order */
    psEncC.pitchEstimationLPCOrder = silk_min_int(psEncC.pitchEstimationLPCOrder, psEncC.predictLPCOrder);
    psEncC.shapeWinLength = SUB_FRAME_LENGTH_MS * psEncC.fs_kHz + 2 * psEncC.la_shape;
    psEncC.Complexity = Complexity;

    debug_assert!(psEncC.pitchEstimationLPCOrder <= MAX_FIND_PITCH_LPC_ORDER);
    debug_assert!(psEncC.shapingLPCOrder <= MAX_SHAPE_LPC_ORDER);
    debug_assert!(psEncC.nStatesDelayedDecision <= MAX_DEL_DEC_STATES);
    debug_assert!(psEncC.warping_Q16 <= 32767);
    debug_assert!(psEncC.la_shape <= LA_SHAPE_MAX);
    debug_assert!(psEncC.shapeWinLength <= SHAPE_LPC_WIN_MAX);

    ret
}

#[inline(always)]
fn silk_setup_LBRR(
    psEncC: &mut silk_encoder_state,    /* I/O                      */
    encControl: &silk_EncControlStruct, /* I                        */
) -> i32 {
    /* LBRR (FEC) is not supported: LBRR_coded is always 0, so LBRR stays disabled and the
       LBRR gain increase is never set. */
    debug_assert!(encControl.LBRR_coded == 0);
    psEncC.LBRR_enabled = encControl.LBRR_coded;

    SILK_NO_ERROR
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::testutil::{CSilkEncoder, SpeechGen, zeroed_box};
    use std::boxed::Box;

    pub(crate) mod c {
        use crate::silk::float::structs_flp::silk_encoder_state_FLP;
        use crate::silk::structs::{silk_EncControlStruct, silk_NLSF_CB_struct};
        unsafe extern "C" {
            pub fn silk_control_encoder(
                psEnc: *mut silk_encoder_state_FLP,
                encControl: *mut silk_EncControlStruct,
                allow_bw_switch: i32,
                channelNb: i32,
                force_fs_kHz: i32,
            ) -> i32;
            pub fn silk_init_encoder(psEnc: *mut silk_encoder_state_FLP, arch: i32) -> i32;
            pub static silk_pitch_contour_iCDF: [u8; 34];
            pub static silk_uniform8_iCDF: [u8; 8];
            pub static silk_NLSF_CB_WB: silk_NLSF_CB_struct;
        }
    }

    /// Replaces the table pointers of the channel state at byte offset `base` in `bytes` by a
    /// canonical value: the Rust and the C state point to their own copies of the same tables.
    pub(crate) fn canon_ptrs(bytes: &mut [u8], base: usize) {
        use core::mem::offset_of;
        let tables: [(usize, *const u8, *const u8); 3] = unsafe {
            [
                (
                    offset_of!(silk_encoder_state_FLP, sCmn.pitch_contour_iCDF),
                    silk_pitch_contour_iCDF.as_ptr(),
                    c::silk_pitch_contour_iCDF.as_ptr(),
                ),
                (
                    offset_of!(silk_encoder_state_FLP, sCmn.pitch_lag_low_bits_iCDF),
                    silk_uniform8_iCDF.as_ptr(),
                    c::silk_uniform8_iCDF.as_ptr(),
                ),
                (
                    offset_of!(silk_encoder_state_FLP, sCmn.psNLSF_CB),
                    &silk_NLSF_CB_WB as *const _ as *const u8,
                    &c::silk_NLSF_CB_WB as *const _ as *const u8,
                ),
            ]
        };
        for (off, rust, cp) in tables {
            let o = base + off;
            let p = usize::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
            if p == rust as usize || p == cp as usize {
                bytes[o..o + 4].copy_from_slice(&1usize.to_le_bytes());
            }
        }
    }

    /// Bytes of an encoder channel state (incl. padding), with canonical table pointers.
    pub(crate) fn state_bytes(s: &silk_encoder_state_FLP) -> std::vec::Vec<u8> {
        let n = core::mem::size_of::<silk_encoder_state_FLP>();
        let mut v = unsafe { core::slice::from_raw_parts(s as *const _ as *const u8, n) }.to_vec();
        canon_ptrs(&mut v, 0);
        v
    }

    #[test]
    fn matches_c() {
        // Fresh encoder, then reconfiguration of a running one (complexity, bitrate, loss, DTX).
        for (bitrate, complexity, dtx) in [(6000, 0, false), (20000, 5, true), (40000, 10, false)] {
            let mut enc = CSilkEncoder::new(bitrate, complexity, dtx);
            let mut sig = SpeechGen::new(complexity as u64);
            let mut r: Box<silk_encoder_state_FLP> = zeroed_box();
            let mut c: Box<silk_encoder_state_FLP> = zeroed_box();
            assert_eq!(crate::silk::init_encoder::silk_init_encoder(&mut r), unsafe { c::silk_init_encoder(&mut *c, 0) });
            for f in 0..40 {
                let mut ctl = enc.ctl;
                ctl.complexity = (complexity + f) % 11;
                ctl.packetLossPercentage = (f * 7) % 30;
                ctl.useDTX = (f % 3 == 0) as i32;
                ctl.bitRate = 6000 + 1000 * f;
                let mut ctl_c = ctl;
                for (allow, force) in [(0, 0), (1, 0), (0, 16)] {
                    let a = silk_control_encoder(&mut r, &mut ctl, allow, 0, force);
                    let b = unsafe { c::silk_control_encoder(&mut *c, &mut ctl_c, allow, 0, force) };
                    assert_eq!(a, b, "frame {f}");
                    assert_eq!(state_bytes(&r), state_bytes(&c), "frame {f}");
                    let n = core::mem::size_of::<silk_EncControlStruct>();
                    let (x, y) = unsafe {
                        (
                            core::slice::from_raw_parts(&ctl as *const _ as *const u8, n),
                            core::slice::from_raw_parts(&ctl_c as *const _ as *const u8, n),
                        )
                    };
                    assert_eq!(x, y, "frame {f}");
                    // A new payload: control runs again.
                    r.sCmn.controlled_since_last_payload = (f % 2) as i32;
                    c.sCmn.controlled_since_last_payload = (f % 2) as i32;
                }
                // Also on a realistic running state from the C encoder.
                enc.encode(&sig.frame_i16());
                let mut rr = Box::new(enc.st.state_Fxx[0]);
                let mut cc = rr.clone();
                rr.sCmn.controlled_since_last_payload = 0;
                cc.sCmn.controlled_since_last_payload = 0;
                let (mut c1, mut c2) = (ctl, ctl);
                assert_eq!(silk_control_encoder(&mut rr, &mut c1, 1, 0, 0), unsafe {
                    c::silk_control_encoder(&mut *cc, &mut c2, 1, 0, 0)
                });
                assert_eq!(state_bytes(&rr), state_bytes(&cc), "running state, frame {f}");
            }
        }
    }
}
