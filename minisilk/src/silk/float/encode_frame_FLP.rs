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
        silk_VAD_GetSA_Q8(p, core::ptr::addr_of!((*p).inputBuf).cast::<i16>());
    }
    /* If Opus VAD is inactive and Silk VAD is active: lower Silk VAD to just under the threshold */
    if activity == VAD_NO_ACTIVITY && psEnc.sCmn.speech_activity_Q8 >= activity_threshold {
        psEnc.sCmn.speech_activity_Q8 = activity_threshold - 1;
    }

    /**************************************************/
    /* Convert speech activity into VAD and DTX flags */
    /**************************************************/
    if psEnc.sCmn.speech_activity_Q8 < activity_threshold {
        psEnc.sCmn.indices.signalType = TYPE_NO_VOICE_ACTIVITY as i8;
        psEnc.sCmn.noSpeechCounter += 1;
        if psEnc.sCmn.noSpeechCounter <= NB_SPEECH_FRAMES_BEFORE_DTX {
            psEnc.sCmn.inDTX = 0;
        } else if psEnc.sCmn.noSpeechCounter > MAX_CONSECUTIVE_DTX + NB_SPEECH_FRAMES_BEFORE_DTX {
            psEnc.sCmn.noSpeechCounter = NB_SPEECH_FRAMES_BEFORE_DTX;
            psEnc.sCmn.inDTX = 0;
        }
        psEnc.sCmn.VAD_flags[0] = 0;
    } else {
        psEnc.sCmn.noSpeechCounter = 0;
        psEnc.sCmn.inDTX = 0;
        psEnc.sCmn.indices.signalType = TYPE_UNVOICED as i8;
        psEnc.sCmn.VAD_flags[0] = 1;
    }
}

/// Encode frame
pub fn silk_encode_frame_FLP(
    psEnc: &mut silk_encoder_state_FLP, /* I/O  Encoder state FLP                           */
    pnBytesOut: &mut i32,               /* O    Number of payload bytes;                    */
    psRangeEnc: &mut ec_enc,            /* I/O  compressor data structure                   */
    maxBits: i32,                       /* I    If > 0: maximum number of output bits       */
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
    let x_frame = LTP_MEM_LENGTH as usize; /* start of frame to encode: psEnc->x_buf + x_frame */
    let res_pitch_frame = LTP_MEM_LENGTH as usize; /* start of pitch LPC residual frame */

    /*******************************************/
    /* Copy new frame to front of input buffer */
    /*******************************************/
    let la = (LA_SHAPE_MS * FS_KHZ) as usize;
    let frame_length = MAX_FRAME_LENGTH;
    silk_short2float_array(&mut psEnc.x_buf[x_frame + la..], &psEnc.sCmn.inputBuf, frame_length);

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
        silk_find_pred_coefs_FLP(psEnc, &mut sEncCtrl, &res_pitch, res_pitch_frame, x_frame);

        /****************************************/
        /* Process gains                        */
        /****************************************/
        silk_process_gains_FLP(psEnc, &mut sEncCtrl);

        /****************************************/
        /* Low Bitrate Redundant Encoding       */
        /****************************************/
        /* silk_LBRR_encode_FLP() does nothing while LBRR is disabled */

        /* Loop over quantizer and entroy coding to control bitrate */
        let maxIter = 6;
        let mut gainMult_Q8: i16 = SILK_FIX_CONST(1.0, 8) as i16;
        let mut found_lower = 0;
        let mut found_upper = 0;
        let mut gainsID = silk_gains_ID(&psEnc.sCmn.indices.GainsIndices);
        let mut gainsID_lower = -1;
        let mut gainsID_upper = -1;
        /* Copy part of the input state */
        ec_copy(&mut sRangeEnc_copy, psRangeEnc);
        sNSQ_copy[0] = psEnc.sCmn.sNSQ;
        let seed_copy = psEnc.sCmn.indices.Seed;
        let ec_buf_copy = st.alloc::<u8>(1275);
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
                silk_encode_indices(&psEnc.sCmn.indices, psRangeEnc);

                /****************************************/
                /* Encode Excitation Signal             */
                /****************************************/
                silk_encode_pulses(
                    psRangeEnc,
                    psEnc.sCmn.indices.signalType as i32,
                    psEnc.sCmn.indices.quantOffsetType as i32,
                    &psEnc.sCmn.pulses,
                    MAX_FRAME_LENGTH,
                );

                nBits = ec_tell(psRangeEnc);

                /* If we still bust after the last iteration, do some damage control. */
                if iter == maxIter && found_lower == 0 && nBits > maxBits {
                    ec_copy(psRangeEnc, &sRangeEnc_copy2);

                    /* Keep gains the same as the last frame. */
                    psEnc.sShape.LastGainIndex = sEncCtrl.lastGainIndexPrev;
                    for i in 0..MAX_NB_SUBFR as usize {
                        psEnc.sCmn.indices.GainsIndices[i] = 4;
                    }
                    psEnc.sCmn.indices.GainsIndices[0] = sEncCtrl.lastGainIndexPrev;
                    /* Clear all pulses. */
                    for i in 0..MAX_FRAME_LENGTH as usize {
                        psEnc.sCmn.pulses[i] = 0;
                    }

                    silk_encode_indices(&psEnc.sCmn.indices, psRangeEnc);

                    silk_encode_pulses(
                        psRangeEnc,
                        psEnc.sCmn.indices.signalType as i32,
                        psEnc.sCmn.indices.quantOffsetType as i32,
                        &psEnc.sCmn.pulses,
                        MAX_FRAME_LENGTH,
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
                let subfr_length = MAX_SUB_FRAME_LENGTH as usize;
                for i in 0..MAX_NB_SUBFR as usize {
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

            for i in 0..MAX_NB_SUBFR as usize {
                let tmp: i16 = if gain_lock[i] != 0 { best_gain_mult[i] } else { gainMult_Q8 };
                pGains_Q16[i] = silk_LSHIFT_SAT32(silk_SMULWB(sEncCtrl.GainsUnq_Q16[i], tmp as i32), 8);
            }

            /* Quantize gains */
            psEnc.sShape.LastGainIndex = sEncCtrl.lastGainIndexPrev;
            silk_gains_quant(
                &mut psEnc.sCmn.indices.GainsIndices,
                &mut pGains_Q16,
                &mut psEnc.sShape.LastGainIndex,
            );

            /* Unique identifier of gains vector */
            gainsID = silk_gains_ID(&psEnc.sCmn.indices.GainsIndices);

            /* Overwrite unquantized gains with quantized gains and convert back to Q0 from Q16 */
            for i in 0..MAX_NB_SUBFR as usize {
                sEncCtrl.Gains[i] = pGains_Q16[i] as f32 / 65536.0f32;
            }
            iter += 1;
        }
    }

    /* Update input buffer */
    let n = (LTP_MEM_LENGTH + LA_SHAPE_MS * FS_KHZ) as usize;
    psEnc.x_buf.copy_within(frame_length as usize..frame_length as usize + n, 0);

    /* Parameters needed for next frame */
    psEnc.sCmn.prevLag = sEncCtrl.pitchL[(MAX_NB_SUBFR - 1) as usize];
    psEnc.sCmn.prevSignalType = psEnc.sCmn.indices.signalType;

    /****************************************/
    /* Finalize payload                     */
    /****************************************/
    psEnc.sCmn.first_frame_after_reset = 0;
    /* Payload size */
    *pnBytesOut = silk_RSHIFT(ec_tell(psRangeEnc) + 7, 3);

    ret
}
