//! Port of silk/float/encode_frame_FLP.c.
//!
//! Not ported (unreachable in minisilk's configuration): LBRR encoding
//! (`silk_LBRR_encode_FLP`; LBRR is never enabled), the bandwidth transition filter
//! (`silk_LP_variable_cutoff`; `sLP.mode` stays 0 with a fixed 16 kHz internal rate),
//! prefill and CBR.

use crate::celt::entcode::{ec_enc, ec_tell};
use crate::silk::VAD::silk_VAD_GetSA_Q8;
use crate::silk::define::*;
use crate::silk::encode_indices::silk_encode_indices;
use crate::silk::encode_pulses::silk_encode_pulses;
use crate::silk::float::find_pitch_lags_FLP::{silk_find_pitch_lags_FLP, silk_max_float};
use crate::silk::float::find_pred_coefs_FLP::silk_find_pred_coefs_FLP;
use crate::silk::float::noise_shape_analysis_FLP::silk_noise_shape_analysis_FLP;
use crate::silk::float::process_gains_FLP::silk_process_gains_FLP;
use crate::silk::float::sigproc_flp::silk_short2float_array;
use crate::silk::float::structs_flp::{silk_encoder_control_FLP, silk_encoder_state_FLP};
use crate::silk::float::wrappers_FLP::silk_NSQ_wrapper_FLP;
use crate::silk::gain_quant::{silk_gains_ID, silk_gains_quant};
use crate::silk::macros::*;
use crate::silk::structs::silk_nsq_state;
use crate::silk::tuning_parameters::*;
use crate::stack;

/// Copies a range coder state (C: silk_memcpy of an ec_enc).
#[inline(always)]
fn ec_copy(dst: &mut ec_enc, src: &ec_enc) {
    // SAFETY: ec_ctx is plain data (the buffer pointer is shared, not owned).
    unsafe { core::ptr::copy_nonoverlapping(src as *const ec_enc, dst as *mut ec_enc, 1) };
}

pub fn silk_encode_do_VAD_FLP(
    psEnc: &mut silk_encoder_state_FLP, /* I/O  Encoder state FLP                           */
    activity: i32,                      /* I    Decision of Opus voice activity detector    */
) {
    let activity_threshold = SILK_FIX_CONST(SPEECH_ACTIVITY_DTX_THRES as f64, 8);

    /****************************/
    /* Voice Activity Detection */
    /****************************/
    unsafe {
        let p: *mut crate::silk::structs::silk_encoder_state = &mut psEnc.sCmn;
        silk_VAD_GetSA_Q8(p, core::ptr::addr_of!((*p).inputBuf).cast::<i16>().add(1));
    }
    /* If Opus VAD is inactive and Silk VAD is active: lower Silk VAD to just under the threshold */
    if activity == VAD_NO_ACTIVITY && psEnc.sCmn.speech_activity_Q8 >= activity_threshold {
        psEnc.sCmn.speech_activity_Q8 = activity_threshold - 1;
    }

    /**************************************************/
    /* Convert speech activity into VAD and DTX flags */
    /**************************************************/
    let nFramesEncoded = psEnc.sCmn.nFramesEncoded as usize;
    if psEnc.sCmn.speech_activity_Q8 < activity_threshold {
        psEnc.sCmn.indices.signalType = TYPE_NO_VOICE_ACTIVITY as i8;
        psEnc.sCmn.noSpeechCounter += 1;
        if psEnc.sCmn.noSpeechCounter <= NB_SPEECH_FRAMES_BEFORE_DTX {
            psEnc.sCmn.inDTX = 0;
        } else if psEnc.sCmn.noSpeechCounter > MAX_CONSECUTIVE_DTX + NB_SPEECH_FRAMES_BEFORE_DTX {
            psEnc.sCmn.noSpeechCounter = NB_SPEECH_FRAMES_BEFORE_DTX;
            psEnc.sCmn.inDTX = 0;
        }
        psEnc.sCmn.VAD_flags[nFramesEncoded] = 0;
    } else {
        psEnc.sCmn.noSpeechCounter = 0;
        psEnc.sCmn.inDTX = 0;
        psEnc.sCmn.indices.signalType = TYPE_UNVOICED as i8;
        psEnc.sCmn.VAD_flags[nFramesEncoded] = 1;
    }
}

/// Encode frame
pub fn silk_encode_frame_FLP(
    psEnc: &mut silk_encoder_state_FLP, /* I/O  Encoder state FLP                           */
    pnBytesOut: &mut i32,               /* O    Number of payload bytes;                    */
    psRangeEnc: &mut ec_enc,            /* I/O  compressor data structure                   */
    condCoding: i32,                    /* I    The type of conditional coding to use       */
    maxBits: i32,                       /* I    If > 0: maximum number of output bits       */
    useCBR: i32,                        /* I    Flag to force constant-bitrate operation    */
) -> i32 {
    let ret = 0;
    let mut sEncCtrl: silk_encoder_control_FLP = unsafe { core::mem::zeroed() };
    let mut res_pitch = [0f32; (2 * MAX_FRAME_LENGTH + LA_PITCH_MAX) as usize];
    let mut sRangeEnc_copy: ec_enc = unsafe { core::mem::zeroed() };
    let mut sRangeEnc_copy2: ec_enc = unsafe { core::mem::zeroed() };
    let mut sNSQ_copy: [silk_nsq_state; 2] = [psEnc.sCmn.sNSQ; 2];
    let mut nBits: i32;
    let mut pGains_Q16 = [0i32; MAX_NB_SUBFR as usize];
    let mut gain_lock = [0i32; MAX_NB_SUBFR as usize];
    let mut best_gain_mult = [0i16; MAX_NB_SUBFR as usize];
    let mut best_sum = [0i32; MAX_NB_SUBFR as usize];
    let st = stack::save();

    /* CBR, prefill and LBRR are not supported */
    debug_assert!(useCBR == 0);
    debug_assert!(psEnc.sCmn.prefillFlag == 0);
    debug_assert!(psEnc.sCmn.LBRR_enabled == 0);

    /* For VBR, allow up to 25% below the cap if we initially busted the budget. (CBR: 5 bits) */
    let bits_margin = maxBits / 4;
    /* This is totally unnecessary but many compilers (including gcc) are too dumb to realise it */
    let mut LastGainIndex_copy2: i8 = 0;
    let (mut nBits_lower, mut nBits_upper, mut gainMult_lower, mut gainMult_upper) = (0i32, 0i32, 0i32, 0i32);

    psEnc.sCmn.indices.Seed = (psEnc.sCmn.frameCounter & 3) as i8;
    psEnc.sCmn.frameCounter += 1;

    /**************************************************************/
    /* Set up Input Pointers, and insert frame in input buffer    */
    /**************************************************************/
    /* pointers aligned with start of frame to encode */
    let x_frame = psEnc.sCmn.ltp_mem_length as usize; /* start of frame to encode: psEnc->x_buf + x_frame */
    let res_pitch_frame = psEnc.sCmn.ltp_mem_length as usize; /* start of pitch LPC residual frame */

    /***************************************/
    /* Ensure smooth bandwidth transitions */
    /***************************************/
    /* silk_LP_variable_cutoff() does nothing while sLP.mode == 0 (fixed 16 kHz internal rate) */
    debug_assert!(psEnc.sCmn.sLP.mode == 0);

    /*******************************************/
    /* Copy new frame to front of input buffer */
    /*******************************************/
    let la = (LA_SHAPE_MS * psEnc.sCmn.fs_kHz) as usize;
    let frame_length = psEnc.sCmn.frame_length;
    silk_short2float_array(&mut psEnc.x_buf[x_frame + la..], &psEnc.sCmn.inputBuf[1..], frame_length);

    /* Add tiny signal to avoid high CPU load from denormalized floating point numbers */
    for i in 0..8 {
        psEnc.x_buf[x_frame + la + (i * (frame_length >> 3)) as usize] += (1 - (i & 2)) as f32 * 1e-6f32;
    }

    {
        /*****************************************/
        /* Find pitch lags, initial LPC analysis */
        /*****************************************/
        silk_find_pitch_lags_FLP(psEnc, &mut sEncCtrl, &mut res_pitch, x_frame);

        /************************/
        /* Noise shape analysis */
        /************************/
        silk_noise_shape_analysis_FLP(psEnc, &mut sEncCtrl, &res_pitch[res_pitch_frame..], x_frame);

        /***************************************************/
        /* Find linear prediction coefficients (LPC + LTP) */
        /***************************************************/
        silk_find_pred_coefs_FLP(psEnc, &mut sEncCtrl, &res_pitch, res_pitch_frame, x_frame, condCoding);

        /****************************************/
        /* Process gains                        */
        /****************************************/
        silk_process_gains_FLP(psEnc, &mut sEncCtrl, condCoding);

        /****************************************/
        /* Low Bitrate Redundant Encoding       */
        /****************************************/
        /* silk_LBRR_encode_FLP() does nothing while LBRR is disabled */

        /* Loop over quantizer and entroy coding to control bitrate */
        let maxIter = 6;
        let mut gainMult_Q8: i16 = SILK_FIX_CONST(1.0, 8) as i16;
        let mut found_lower = 0;
        let mut found_upper = 0;
        let mut gainsID = silk_gains_ID(&psEnc.sCmn.indices.GainsIndices, psEnc.sCmn.nb_subfr);
        let mut gainsID_lower = -1;
        let mut gainsID_upper = -1;
        /* Copy part of the input state */
        ec_copy(&mut sRangeEnc_copy, psRangeEnc);
        sNSQ_copy[0] = psEnc.sCmn.sNSQ;
        let seed_copy = psEnc.sCmn.indices.Seed;
        let ec_prevLagIndex_copy = psEnc.sCmn.ec_prevLagIndex;
        let ec_prevSignalType_copy = psEnc.sCmn.ec_prevSignalType;
        let ec_buf_copy = st.alloc::<u8>(1275);
        let nFramesEncoded = psEnc.sCmn.nFramesEncoded;
        let mut iter = 0;
        loop {
            if gainsID == gainsID_lower {
                nBits = nBits_lower;
            } else if gainsID == gainsID_upper {
                nBits = nBits_upper;
            } else {
                /* Restore part of the input state */
                if iter > 0 {
                    ec_copy(psRangeEnc, &sRangeEnc_copy);
                    psEnc.sCmn.sNSQ = sNSQ_copy[0];
                    psEnc.sCmn.indices.Seed = seed_copy;
                    psEnc.sCmn.ec_prevLagIndex = ec_prevLagIndex_copy;
                    psEnc.sCmn.ec_prevSignalType = ec_prevSignalType_copy;
                }

                /*****************************************/
                /* Noise shaping quantization            */
                /*****************************************/
                unsafe {
                    let p: *mut silk_encoder_state_FLP = psEnc;
                    silk_NSQ_wrapper_FLP(
                        p,
                        &sEncCtrl,
                        core::ptr::addr_of_mut!((*p).sCmn.indices),
                        core::ptr::addr_of_mut!((*p).sCmn.sNSQ),
                        core::ptr::addr_of_mut!((*p).sCmn.pulses).cast::<i8>(),
                        core::ptr::addr_of!((*p).x_buf).cast::<f32>().add(x_frame),
                    );
                }

                if iter == maxIter && found_lower == 0 {
                    ec_copy(&mut sRangeEnc_copy2, psRangeEnc);
                }

                /****************************************/
                /* Encode Parameters                    */
                /****************************************/
                silk_encode_indices(&mut psEnc.sCmn, psRangeEnc, nFramesEncoded, 0, condCoding);

                /****************************************/
                /* Encode Excitation Signal             */
                /****************************************/
                silk_encode_pulses(
                    psRangeEnc,
                    psEnc.sCmn.indices.signalType as i32,
                    psEnc.sCmn.indices.quantOffsetType as i32,
                    &psEnc.sCmn.pulses,
                    psEnc.sCmn.frame_length,
                );

                nBits = ec_tell(psRangeEnc);

                /* If we still bust after the last iteration, do some damage control. */
                if iter == maxIter && found_lower == 0 && nBits > maxBits {
                    ec_copy(psRangeEnc, &sRangeEnc_copy2);

                    /* Keep gains the same as the last frame. */
                    psEnc.sShape.LastGainIndex = sEncCtrl.lastGainIndexPrev;
                    for i in 0..psEnc.sCmn.nb_subfr as usize {
                        psEnc.sCmn.indices.GainsIndices[i] = 4;
                    }
                    if condCoding != CODE_CONDITIONALLY {
                        psEnc.sCmn.indices.GainsIndices[0] = sEncCtrl.lastGainIndexPrev;
                    }
                    psEnc.sCmn.ec_prevLagIndex = ec_prevLagIndex_copy;
                    psEnc.sCmn.ec_prevSignalType = ec_prevSignalType_copy;
                    /* Clear all pulses. */
                    for i in 0..psEnc.sCmn.frame_length as usize {
                        psEnc.sCmn.pulses[i] = 0;
                    }

                    silk_encode_indices(&mut psEnc.sCmn, psRangeEnc, nFramesEncoded, 0, condCoding);

                    silk_encode_pulses(
                        psRangeEnc,
                        psEnc.sCmn.indices.signalType as i32,
                        psEnc.sCmn.indices.quantOffsetType as i32,
                        &psEnc.sCmn.pulses,
                        psEnc.sCmn.frame_length,
                    );

                    nBits = ec_tell(psRangeEnc);
                }

                if iter == 0 && nBits <= maxBits {
                    break;
                }
            }

            if iter == maxIter {
                if found_lower != 0 && (gainsID == gainsID_lower || nBits > maxBits) {
                    /* Restore output state from earlier iteration that did meet the bitrate budget */
                    ec_copy(psRangeEnc, &sRangeEnc_copy2);
                    debug_assert!(sRangeEnc_copy2.offs <= 1275);
                    unsafe {
                        core::ptr::copy_nonoverlapping(ec_buf_copy.as_ptr(), psRangeEnc.buf, sRangeEnc_copy2.offs as usize)
                    };
                    psEnc.sCmn.sNSQ = sNSQ_copy[1];
                    psEnc.sShape.LastGainIndex = LastGainIndex_copy2;
                }
                break;
            }

            if nBits > maxBits {
                if found_lower == 0 && iter >= 2 {
                    /* Adjust the quantizer's rate/distortion tradeoff and discard previous "upper" results */
                    sEncCtrl.Lambda = silk_max_float(sEncCtrl.Lambda * 1.5f32, 1.5f32);
                    /* Reducing dithering can help us hit the target. */
                    psEnc.sCmn.indices.quantOffsetType = 0;
                    found_upper = 0;
                    gainsID_upper = -1;
                } else {
                    found_upper = 1;
                    nBits_upper = nBits;
                    gainMult_upper = gainMult_Q8 as i32;
                    gainsID_upper = gainsID;
                }
            } else if nBits < maxBits - bits_margin {
                found_lower = 1;
                nBits_lower = nBits;
                gainMult_lower = gainMult_Q8 as i32;
                if gainsID != gainsID_lower {
                    gainsID_lower = gainsID;
                    /* Copy part of the output state */
                    ec_copy(&mut sRangeEnc_copy2, psRangeEnc);
                    debug_assert!(psRangeEnc.offs <= 1275);
                    unsafe {
                        core::ptr::copy_nonoverlapping(psRangeEnc.buf, ec_buf_copy.as_mut_ptr(), psRangeEnc.offs as usize)
                    };
                    sNSQ_copy[1] = psEnc.sCmn.sNSQ;
                    LastGainIndex_copy2 = psEnc.sShape.LastGainIndex;
                }
            } else {
                /* Close enough */
                break;
            }

            if found_lower == 0 && nBits > maxBits {
                let subfr_length = psEnc.sCmn.subfr_length as usize;
                for i in 0..psEnc.sCmn.nb_subfr as usize {
                    let mut sum: i32 = 0;
                    for j in i * subfr_length..(i + 1) * subfr_length {
                        sum += (psEnc.sCmn.pulses[j] as i32).abs();
                    }
                    if iter == 0 || (sum < best_sum[i] && gain_lock[i] == 0) {
                        best_sum[i] = sum;
                        best_gain_mult[i] = gainMult_Q8;
                    } else {
                        gain_lock[i] = 1;
                    }
                }
            }
            if (found_lower & found_upper) == 0 {
                /* Adjust gain according to high-rate rate/distortion curve */
                if nBits > maxBits {
                    gainMult_Q8 = silk_min_32(1024, gainMult_Q8 as i32 * 3 / 2) as i16;
                } else {
                    gainMult_Q8 = silk_max_32(64, gainMult_Q8 as i32 * 4 / 5) as i16;
                }
            } else {
                /* Adjust gain by interpolating */
                gainMult_Q8 = (gainMult_lower
                    + ((gainMult_upper - gainMult_lower) * (maxBits - nBits_lower)) / (nBits_upper - nBits_lower))
                    as i16;
                /* New gain multiplier must be between 25% and 75% of old range (note that gainMult_upper < gainMult_lower) */
                if gainMult_Q8 as i32 > silk_ADD_RSHIFT32(gainMult_lower, gainMult_upper - gainMult_lower, 2) {
                    gainMult_Q8 = silk_ADD_RSHIFT32(gainMult_lower, gainMult_upper - gainMult_lower, 2) as i16;
                } else if (gainMult_Q8 as i32) < silk_SUB_RSHIFT32(gainMult_upper, gainMult_upper - gainMult_lower, 2) {
                    gainMult_Q8 = silk_SUB_RSHIFT32(gainMult_upper, gainMult_upper - gainMult_lower, 2) as i16;
                }
            }

            for i in 0..psEnc.sCmn.nb_subfr as usize {
                let tmp: i16 = if gain_lock[i] != 0 { best_gain_mult[i] } else { gainMult_Q8 };
                pGains_Q16[i] = silk_LSHIFT_SAT32(silk_SMULWB(sEncCtrl.GainsUnq_Q16[i], tmp as i32), 8);
            }

            /* Quantize gains */
            psEnc.sShape.LastGainIndex = sEncCtrl.lastGainIndexPrev;
            silk_gains_quant(
                &mut psEnc.sCmn.indices.GainsIndices,
                &mut pGains_Q16,
                &mut psEnc.sShape.LastGainIndex,
                (condCoding == CODE_CONDITIONALLY) as i32,
                psEnc.sCmn.nb_subfr,
            );

            /* Unique identifier of gains vector */
            gainsID = silk_gains_ID(&psEnc.sCmn.indices.GainsIndices, psEnc.sCmn.nb_subfr);

            /* Overwrite unquantized gains with quantized gains and convert back to Q0 from Q16 */
            for i in 0..psEnc.sCmn.nb_subfr as usize {
                sEncCtrl.Gains[i] = pGains_Q16[i] as f32 / 65536.0f32;
            }
            iter += 1;
        }
    }

    /* Update input buffer */
    let n = (psEnc.sCmn.ltp_mem_length + LA_SHAPE_MS * psEnc.sCmn.fs_kHz) as usize;
    psEnc.x_buf.copy_within(frame_length as usize..frame_length as usize + n, 0);

    /* Parameters needed for next frame */
    psEnc.sCmn.prevLag = sEncCtrl.pitchL[(psEnc.sCmn.nb_subfr - 1) as usize];
    psEnc.sCmn.prevSignalType = psEnc.sCmn.indices.signalType;

    /****************************************/
    /* Finalize payload                     */
    /****************************************/
    psEnc.sCmn.first_frame_after_reset = 0;
    /* Payload size */
    *pnBytesOut = silk_RSHIFT(ec_tell(psRangeEnc) + 7, 3);

    ret
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::silk::float::structs_flp::silk_encoder;
    use crate::testutil::{CSilkEncoder, Rng, SpeechGen};
    use std::boxed::Box;
    use std::format;
    use std::string::String;
    use std::vec::Vec;

    pub(crate) mod c {
        use super::Frame;
        use crate::celt::entcode::ec_enc;
        use crate::silk::float::structs_flp::{silk_encoder_control_FLP, silk_encoder_state_FLP};
        use crate::silk::structs::{SideInfoIndices, silk_encoder_state, silk_nsq_state};
        unsafe extern "C" {
            pub fn silk_encode_do_VAD_FLP(psEnc: *mut silk_encoder_state_FLP, activity: i32);
            pub fn silk_encode_frame_FLP(
                psEnc: *mut silk_encoder_state_FLP,
                pnBytesOut: *mut i32,
                psRangeEnc: *mut ec_enc,
                condCoding: i32,
                maxBits: i32,
                useCBR: i32,
            ) -> i32;
            pub fn silk_find_pitch_lags_FLP(
                psEnc: *mut silk_encoder_state_FLP,
                psEncCtrl: *mut silk_encoder_control_FLP,
                res: *mut f32,
                x: *const f32,
                arch: i32,
            );
            pub fn silk_noise_shape_analysis_FLP(
                psEnc: *mut silk_encoder_state_FLP,
                psEncCtrl: *mut silk_encoder_control_FLP,
                pitch_res: *const f32,
                x: *const f32,
            );
            pub fn silk_find_pred_coefs_FLP(
                psEnc: *mut silk_encoder_state_FLP,
                psEncCtrl: *mut silk_encoder_control_FLP,
                res_pitch: *const f32,
                x: *const f32,
                condCoding: i32,
            );
            pub fn silk_process_gains_FLP(psEnc: *mut silk_encoder_state_FLP, psEncCtrl: *mut silk_encoder_control_FLP, condCoding: i32);
            pub fn silk_find_LPC_FLP(psEncC: *mut silk_encoder_state, NLSF_Q15: *mut i16, x: *const f32, minInvGain: f32, arch: i32);
            pub fn silk_find_LTP_FLP(
                XX: *mut f32,
                xX: *mut f32,
                r_ptr: *const f32,
                lag: *const i32,
                subfr_length: i32,
                nb_subfr: i32,
                arch: i32,
            );
            pub fn silk_LTP_scale_ctrl_FLP(psEnc: *mut silk_encoder_state_FLP, psEncCtrl: *mut silk_encoder_control_FLP, condCoding: i32);
            pub fn silk_regularize_correlations_FLP(XX: *mut f32, xx: *mut f32, noise: f32, D: i32);
            pub fn silk_A2NLSF_FLP(NLSF_Q15: *mut i16, pAR: *const f32, LPC_order: i32);
            pub fn silk_NLSF2A_FLP(pAR: *mut f32, NLSF_Q15: *const i16, LPC_order: i32, arch: i32);
            pub fn silk_process_NLSFs_FLP(
                psEncC: *mut silk_encoder_state,
                PredCoef: *mut [f32; 16],
                NLSF_Q15: *mut i16,
                prev_NLSF_Q15: *const i16,
            );
            pub fn silk_NSQ_wrapper_FLP(
                psEnc: *mut silk_encoder_state_FLP,
                psEncCtrl: *mut silk_encoder_control_FLP,
                psIndices: *mut SideInfoIndices,
                psNSQ: *mut silk_nsq_state,
                pulses: *mut i8,
                x: *const f32,
            );
            pub fn silk_quant_LTP_gains_FLP(
                B: *mut f32,
                cbk_index: *mut i8,
                periodicity_index: *mut i8,
                sum_log_gain_Q7: *mut i32,
                pred_gain_dB: *mut f32,
                XX: *const f32,
                xX: *const f32,
                subfr_len: i32,
                nb_subfr: i32,
                arch: i32,
            );
            pub fn silk_burg_modified_FLP(A: *mut f32, x: *const f32, minInvGain: f32, subfr_length: i32, nb_subfr: i32, D: i32, arch: i32) -> f32;
        }

        /* The encode_frame stages, run with the C functions. */
        pub fn find_pitch_lags(fr: &mut Frame) {
            let off = fr.st.sCmn.ltp_mem_length as usize;
            unsafe {
                let x = fr.st.x_buf.as_ptr().add(off);
                silk_find_pitch_lags_FLP(&mut *fr.st, &mut fr.ctrl, fr.res_pitch.as_mut_ptr(), x, 0)
            }
        }
        pub fn noise_shape_analysis(fr: &mut Frame) {
            let off = fr.st.sCmn.ltp_mem_length as usize;
            unsafe {
                let x = fr.st.x_buf.as_ptr().add(off);
                silk_noise_shape_analysis_FLP(&mut *fr.st, &mut fr.ctrl, fr.res_pitch.as_ptr().add(off), x)
            }
        }
        pub fn find_pred_coefs(fr: &mut Frame, condCoding: i32) {
            let off = fr.st.sCmn.ltp_mem_length as usize;
            unsafe {
                let x = fr.st.x_buf.as_ptr().add(off);
                silk_find_pred_coefs_FLP(&mut *fr.st, &mut fr.ctrl, fr.res_pitch.as_ptr().add(off), x, condCoding)
            }
        }
        pub fn process_gains(fr: &mut Frame, condCoding: i32) {
            unsafe { silk_process_gains_FLP(&mut *fr.st, &mut fr.ctrl, condCoding) }
        }
    }

    /// An encoder channel state in the middle of silk_encode_frame_FLP, with its local
    /// encoder control struct and pitch residual buffer.
    #[derive(Clone)]
    pub(crate) struct Frame {
        pub st: Box<silk_encoder_state_FLP>,
        pub ctrl: silk_encoder_control_FLP,
        pub res_pitch: [f32; (2 * MAX_FRAME_LENGTH + LA_PITCH_MAX) as usize],
    }

    /// Test input: speech-like signal at several levels, silence, near-silence, white noise,
    /// loud clipped speech and full-scale square waves.
    pub(crate) fn gen_frame(kind: u32, sg: &mut SpeechGen, rng: &mut Rng) -> [i16; 320] {
        match kind {
            0 => {
                sg.gain = 3000.0;
                sg.frame_i16()
            }
            1 => [0; 320],
            2 => core::array::from_fn(|_| rng.range(-2, 2) as i16),
            3 => {
                let bits = rng.range(4, 15) as u32;
                core::array::from_fn(|_| rng.i32_bits(bits) as i16)
            }
            4 => {
                sg.gain = 60000.0;
                sg.frame_i16()
            }
            5 => {
                let p = rng.range(3, 40) as usize;
                core::array::from_fn(|i| if (i / p) % 2 == 0 { i16::MAX } else { i16::MIN })
            }
            6 => {
                sg.gain = 300.0;
                sg.frame_i16()
            }
            _ => {
                sg.gain = 12000.0;
                sg.frame_i16()
            }
        }
    }

    /// Signal kind for frame `f` of a test sequence: mostly speech, with segments of the other
    /// kinds (long silence runs to trigger DTX).
    pub(crate) fn kind_at(f: usize, seed: u64) -> u32 {
        const SEQ: [u32; 16] = [0, 0, 7, 0, 1, 1, 2, 0, 3, 0, 6, 4, 0, 5, 0, 2];
        SEQ[((f / 12) + seed as usize) % 16]
    }

    /// Runs the C encoder over several configurations and signals; for each frame, calls `cb`
    /// with the channel state as silk_encode_frame_FLP sees it on entry (after control,
    /// buffering and VAD), the condCoding to use and a description.
    pub(crate) fn for_each_input(mut cb: impl FnMut(&silk_encoder_state_FLP, i32, &str)) {
        let cfgs: [(i32, i32, bool, i32); 8] = [
            (6000, 0, true, 0),
            (10000, 1, false, 5),
            (14000, 2, true, 0),
            (18000, 3, false, 20),
            (24000, 5, false, 0),
            (30000, 7, true, 10),
            (36000, 9, false, 0),
            (40000, 10, true, 30),
        ];
        let frames = 72;
        for (ci, &(bitrate, complexity, dtx, loss)) in cfgs.iter().enumerate() {
            let mut enc = CSilkEncoder::new(bitrate, complexity, dtx);
            enc.ctl.packetLossPercentage = loss;
            let mut sg = SpeechGen::new(100 + ci as u64);
            let mut rng = Rng::new(200 + ci as u64);
            for f in 0..frames {
                let pcm = gen_frame(kind_at(f, ci as u64), &mut sg, &mut rng);
                if f >= 2 {
                    // Emulate silk_Encode up to silk_encode_frame_FLP on a copy of the state.
                    let mut st = Box::new(enc.st.state_Fxx[0]);
                    let s = &mut st.sCmn;
                    let d = s.resampler_state.inputDelay as usize;
                    s.inputBuf[2..2 + d].copy_from_slice(&s.resampler_state.delayBuf[..d]);
                    s.inputBuf[2 + d..322].copy_from_slice(&pcm[..320 - d]);
                    s.inputBuf[..2].copy_from_slice(&enc.st.sStereo.sMid);
                    s.controlled_since_last_payload = 0;
                    s.nFramesEncoded = 0;
                    unsafe { c::silk_encode_do_VAD_FLP(&mut *st, -1) };
                    let what = format!("cfg {ci} ({bitrate} bps, complexity {complexity}), frame {f}");
                    cb(&st, if f % 5 == 4 { CODE_CONDITIONALLY } else { CODE_INDEPENDENTLY }, &what);
                }
                enc.encode(&pcm);
            }
        }
    }

    /// Like for_each_input, but with the frame inserted into x_buf as silk_encode_frame_FLP
    /// does before the analysis (the state the analysis functions see).
    pub(crate) fn for_each_frame(mut cb: impl FnMut(&Frame, &str)) {
        for_each_input(|st, cond, what| {
            let mut fr = Frame { st: Box::new(*st), ctrl: unsafe { core::mem::zeroed() }, res_pitch: [0.0; 672] };
            let s = &mut *fr.st;
            s.sCmn.indices.Seed = (s.sCmn.frameCounter & 3) as i8;
            s.sCmn.frameCounter += 1;
            let x_frame = s.sCmn.ltp_mem_length as usize;
            let la = (LA_SHAPE_MS * s.sCmn.fs_kHz) as usize;
            silk_short2float_array(&mut s.x_buf[x_frame + la..], &s.sCmn.inputBuf[1..], s.sCmn.frame_length);
            for i in 0..8 {
                s.x_buf[x_frame + la + (i * (s.sCmn.frame_length >> 3)) as usize] += (1 - (i & 2)) as f32 * 1e-6f32;
            }
            let what = format!("{what} (cond {cond})");
            cb(&fr, &what);
        });
    }

    macro_rules! offsets {
        ($t:ty; $($($f:ident).+),* $(,)?) => {
            std::vec![$((stringify!($($f).+), core::mem::offset_of!($t, $($f).+))),*]
        };
    }

    /// (field, offset) of every field of silk_encoder_state_FLP (nested structs expanded).
    pub(crate) fn state_fields() -> Vec<(&'static str, usize)> {
        offsets!(silk_encoder_state_FLP;
            sCmn.In_HP_State, sCmn.variable_HP_smth1_Q15, sCmn.variable_HP_smth2_Q15, sCmn.sLP.In_LP_State,
            sCmn.sLP.transition_frame_no, sCmn.sLP.mode, sCmn.sLP.saved_fs_kHz, sCmn.sVAD.AnaState, sCmn.sVAD.AnaState1,
            sCmn.sVAD.AnaState2, sCmn.sVAD.XnrgSubfr, sCmn.sVAD.NrgRatioSmth_Q8, sCmn.sVAD.HPstate, sCmn.sVAD.NL,
            sCmn.sVAD.inv_NL, sCmn.sVAD.NoiseLevelBias, sCmn.sVAD.counter, sCmn.sNSQ.xq, sCmn.sNSQ.sLTP_shp_Q14,
            sCmn.sNSQ.sLPC_Q14, sCmn.sNSQ.sAR2_Q14, sCmn.sNSQ.sLF_AR_shp_Q14, sCmn.sNSQ.sDiff_shp_Q14, sCmn.sNSQ.lagPrev,
            sCmn.sNSQ.sLTP_buf_idx, sCmn.sNSQ.sLTP_shp_buf_idx, sCmn.sNSQ.rand_seed, sCmn.sNSQ.prev_gain_Q16,
            sCmn.sNSQ.rewhite_flag, sCmn.prev_NLSFq_Q15, sCmn.speech_activity_Q8, sCmn.allow_bandwidth_switch,
            sCmn.LBRRprevLastGainIndex, sCmn.prevSignalType, sCmn.prevLag, sCmn.pitch_LPC_win_length, sCmn.max_pitch_lag,
            sCmn.API_fs_Hz, sCmn.prev_API_fs_Hz, sCmn.maxInternal_fs_Hz, sCmn.minInternal_fs_Hz, sCmn.desiredInternal_fs_Hz,
            sCmn.fs_kHz, sCmn.nb_subfr, sCmn.frame_length, sCmn.subfr_length, sCmn.ltp_mem_length, sCmn.la_pitch,
            sCmn.la_shape, sCmn.shapeWinLength, sCmn.TargetRate_bps, sCmn.PacketSize_ms, sCmn.PacketLoss_perc,
            sCmn.frameCounter, sCmn.Complexity, sCmn.nStatesDelayedDecision, sCmn.useInterpolatedNLSFs,
            sCmn.shapingLPCOrder, sCmn.predictLPCOrder, sCmn.pitchEstimationComplexity, sCmn.pitchEstimationLPCOrder,
            sCmn.pitchEstimationThreshold_Q16, sCmn.sum_log_gain_Q7, sCmn.NLSF_MSVQ_Survivors, sCmn.first_frame_after_reset,
            sCmn.controlled_since_last_payload, sCmn.warping_Q16, sCmn.useCBR, sCmn.prefillFlag,
            sCmn.pitch_lag_low_bits_iCDF, sCmn.pitch_contour_iCDF, sCmn.psNLSF_CB, sCmn.input_quality_bands_Q15,
            sCmn.input_tilt_Q15, sCmn.SNR_dB_Q7, sCmn.VAD_flags, sCmn.LBRR_flag, sCmn.LBRR_flags,
            sCmn.indices.GainsIndices, sCmn.indices.LTPIndex, sCmn.indices.NLSFIndices, sCmn.indices.lagIndex,
            sCmn.indices.contourIndex, sCmn.indices.signalType, sCmn.indices.quantOffsetType,
            sCmn.indices.NLSFInterpCoef_Q2, sCmn.indices.PERIndex, sCmn.indices.LTP_scaleIndex, sCmn.indices.Seed,
            sCmn.pulses, sCmn.arch, sCmn.inputBuf, sCmn.inputBufIx, sCmn.nFramesPerPacket, sCmn.nFramesEncoded,
            sCmn.nChannelsAPI, sCmn.nChannelsInternal, sCmn.channelNb, sCmn.frames_since_onset, sCmn.ec_prevSignalType,
            sCmn.ec_prevLagIndex, sCmn.resampler_state.sIIR, sCmn.resampler_state.sFIR, sCmn.resampler_state.delayBuf,
            sCmn.resampler_state.resampler_function, sCmn.resampler_state.batchSize, sCmn.resampler_state.invRatio_Q16,
            sCmn.resampler_state.FIR_Order, sCmn.resampler_state.FIR_Fracs, sCmn.resampler_state.Fs_in_kHz,
            sCmn.resampler_state.Fs_out_kHz, sCmn.resampler_state.inputDelay, sCmn.resampler_state.Coefs, sCmn.useDTX,
            sCmn.inDTX, sCmn.noSpeechCounter, sCmn.useInBandFEC, sCmn.LBRR_enabled, sCmn.LBRR_GainIncreases,
            sCmn.indices_LBRR, sCmn.pulses_LBRR,
            sShape.LastGainIndex, sShape.HarmShapeGain_smth, sShape.Tilt_smth, x_buf, LTPCorr,
        )
    }

    /// (field, offset) of every field of silk_encoder (the channel state expanded).
    pub(crate) fn encoder_fields() -> Vec<(String, usize)> {
        let mut v: Vec<(String, usize)> = offsets!(silk_encoder;
            sStereo, nBitsUsedLBRR, nBitsExceeded, nChannelsAPI, nChannelsInternal, nPrevChannelsInternal,
            timeSinceSwitchAllowed_ms, allowBandwidthSwitch, prev_decode_only_middle,
        )
        .into_iter()
        .map(|(n, o)| (String::from(n), o))
        .collect();
        let base = core::mem::offset_of!(silk_encoder, state_Fxx);
        v.extend(state_fields().into_iter().map(|(n, o)| (format!("state_Fxx[0].{n}"), base + o)));
        v
    }

    /// Describes the first byte where `a` and `b` differ, by field, or None if they are equal.
    pub(crate) fn first_diff<S: AsRef<str>>(a: &[u8], b: &[u8], fields: &[(S, usize)]) -> Option<String> {
        let i = a.iter().zip(b.iter()).position(|(x, y)| x != y)?;
        let (name, off) = fields.iter().filter(|(_, o)| *o <= i).max_by_key(|(_, o)| *o).map(|(n, o)| (n.as_ref(), *o))?;
        Some(format!("first difference in `{}` (byte {} of the field, offset {})", name.replace(' ', ""), i - off, i))
    }

    pub(crate) fn bytes<T>(x: &T) -> &[u8] {
        unsafe { core::slice::from_raw_parts(x as *const T as *const u8, core::mem::size_of::<T>()) }
    }

    /// Compares two channel states byte for byte (table pointers canonicalized).
    pub(crate) fn same_state(r: &silk_encoder_state_FLP, c: &silk_encoder_state_FLP, what: &str) {
        let (a, b) = (crate::silk::control_codec::tests::state_bytes(r), crate::silk::control_codec::tests::state_bytes(c));
        if let Some(d) = first_diff(&a, &b, &state_fields()) {
            panic!("{what}: state differs: {d}");
        }
    }

    pub(crate) fn same_ctrl(r: &silk_encoder_control_FLP, c: &silk_encoder_control_FLP, what: &str) {
        let fields = offsets!(silk_encoder_control_FLP;
            Gains, PredCoef, LTPCoef, LTP_scale, pitchL, AR, LF_MA_shp, LF_AR_shp, Tilt, HarmShapeGain, Lambda,
            input_quality, coding_quality, predGain, LTPredCodGain, ResNrg, GainsUnq_Q16, lastGainIndexPrev,
        );
        if let Some(d) = first_diff(bytes(r), bytes(c), &fields) {
            panic!("{what}: encoder control differs: {d}");
        }
    }

    #[test]
    fn encode_do_VAD_matches_c() {
        for_each_input(|st, _, what| {
            for activity in [-1, 0, 1] {
                let mut r = Box::new(*st);
                let mut cc = Box::new(*st);
                silk_encode_do_VAD_FLP(&mut r, activity);
                unsafe { c::silk_encode_do_VAD_FLP(&mut *cc, activity) };
                same_state(&r, &cc, what);
            }
        });
    }

    #[test]
    fn encode_frame_matches_c() {
        let mut rng = Rng::new(9);
        for_each_input(|st, cond, what| {
            let mut r = Box::new(*st);
            let mut cc = Box::new(*st);
            // Tight budgets exercise the rate control loop.
            let maxBits = [8 * 1275, 1000, 300, 150, 80, 40][rng.range(0, 5) as usize];
            let (mut buf_r, mut buf_c) = ([0u8; 1275], [0u8; 1275]);
            let mut enc_r = crate::celt::entcode::tests_support::new_enc(&mut buf_r);
            let mut enc_c = crate::celt::entcode::tests_support::new_enc(&mut buf_c);
            // Header bits as silk_Encode writes them first.
            crate::celt::entenc::ec_enc_icdf(&mut enc_r, 0, &[128, 0], 8);
            crate::celt::entenc::ec_enc_icdf(&mut enc_c, 0, &[128, 0], 8);
            let (mut n_r, mut n_c) = (0, 0);
            let a = silk_encode_frame_FLP(&mut r, &mut n_r, &mut enc_r, cond, maxBits, 0);
            let b = unsafe { c::silk_encode_frame_FLP(&mut *cc, &mut n_c, &mut enc_c, cond, maxBits, 0) };
            assert_eq!((a, n_r), (b, n_c), "{what}");
            crate::celt::entcode::tests_support::same_enc(&enc_r, &enc_c);
            assert!(buf_r[..enc_r.offs as usize] == buf_c[..enc_c.offs as usize], "{what}: payload");
            same_state(&r, &cc, what);
        });
    }
}
