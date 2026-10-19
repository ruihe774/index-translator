//! Port of silk/enc_API.c.
//!
//! Mono only, 16 kHz API and internal rate, 20 ms packets of one frame, VBR, no LBRR, no
//! prefill. Not ported (unreachable in this configuration): stereo (second channel, LR->MS
//! conversion, stereo prediction and mid-only flags), LBRR encoding and LBRR flag coding
//! (the VAD/LBRR header bits are still written as C does with LBRR disabled), multi-frame
//! packets (40/60 ms rate control), prefill and CBR.

use crate::celt::entcode::{ec_enc, ec_tell};
use crate::celt::entenc::{ec_enc_icdf, ec_enc_patch_initial_bits};
use crate::silk::HP_variable_cutoff::silk_HP_variable_cutoff;
use crate::silk::check_control_input::check_control_input;
use crate::silk::control_SNR::silk_control_SNR;
use crate::silk::control_codec::silk_control_encoder;
use crate::silk::define::*;
use crate::silk::float::encode_frame_FLP::{silk_encode_do_VAD_FLP, silk_encode_frame_FLP};
use crate::silk::float::sigproc_flp::float2int;
use crate::silk::float::structs_flp::silk_encoder;
use crate::silk::init_encoder::silk_init_encoder;
use crate::silk::macros::*;
use crate::silk::resampler::silk_resampler;
use crate::silk::structs::silk_EncControlStruct;
use crate::silk::tables::silk_Quantization_Offsets_Q10;
use crate::silk::tuning_parameters::*;
use crate::stack;

/// celt/float_cast.h FLOAT2INT16 (RES2INT16 in the float build)
#[inline(always)]
fn FLOAT2INT16(mut x: f32) -> i16 {
    x = x * 32768.0f32; /* CELT_SIG_SCALE */
    x = if x > -32768.0f32 { x } else { -32768.0f32 }; /* MAX32 */
    x = if x < 32767.0f32 { x } else { 32767.0f32 }; /* MIN32 */
    float2int(x) as i16
}

/// Init or Reset encoder
pub fn silk_InitEncoder(
    encState: &mut silk_encoder,              /* I/O  State                                           */
    encStatus: &mut silk_EncControlStruct,    /* O    Encoder Status                                  */
) -> i32 {
    let mut ret = SILK_NO_ERROR;

    /* Reset encoder (mono: the struct holds a single channel state) */
    // SAFETY: all-zero is a valid silk_encoder.
    unsafe { core::ptr::write_bytes(encState as *mut silk_encoder, 0, 1) };
    ret += silk_init_encoder(&mut encState.state_Fxx[0]);
    debug_assert!(ret == 0);

    encState.nChannelsAPI = 1;
    encState.nChannelsInternal = 1;

    /* Read control structure */
    ret += silk_QueryEncoder(encState, encStatus);
    debug_assert!(ret == 0);

    ret
}

/// Read control structure from encoder
fn silk_QueryEncoder(
    encState: &silk_encoder,               /* I    State                                           */
    encStatus: &mut silk_EncControlStruct, /* O    Encoder Status                                  */
) -> i32 {
    let ret = SILK_NO_ERROR;
    let psEnc = encState;
    let state_Fxx = &psEnc.state_Fxx;

    encStatus.nChannelsAPI = psEnc.nChannelsAPI;
    encStatus.nChannelsInternal = psEnc.nChannelsInternal;
    encStatus.API_sampleRate = state_Fxx[0].sCmn.API_fs_Hz;
    encStatus.maxInternalSampleRate = state_Fxx[0].sCmn.maxInternal_fs_Hz;
    encStatus.minInternalSampleRate = state_Fxx[0].sCmn.minInternal_fs_Hz;
    encStatus.desiredInternalSampleRate = state_Fxx[0].sCmn.desiredInternal_fs_Hz;
    encStatus.payloadSize_ms = state_Fxx[0].sCmn.PacketSize_ms;
    encStatus.bitRate = state_Fxx[0].sCmn.TargetRate_bps;
    encStatus.packetLossPercentage = state_Fxx[0].sCmn.PacketLoss_perc;
    encStatus.complexity = state_Fxx[0].sCmn.Complexity;
    encStatus.useInBandFEC = state_Fxx[0].sCmn.useInBandFEC;
    encStatus.useDTX = state_Fxx[0].sCmn.useDTX;
    encStatus.useCBR = state_Fxx[0].sCmn.useCBR;
    encStatus.internalSampleRate = silk_SMULBB(state_Fxx[0].sCmn.fs_kHz, 1000);
    encStatus.allowBandwidthSwitch = state_Fxx[0].sCmn.allow_bandwidth_switch;
    encStatus.inWBmodeWithoutVariableLP = (state_Fxx[0].sCmn.fs_kHz == 16 && state_Fxx[0].sCmn.sLP.mode == 0) as i32;

    ret
}

/// Encode frame with Silk.
/// `samplesIn` holds `nSamplesIn` float samples (full scale +-1.0). `prefillFlag` must be 0.
pub fn silk_Encode(
    encState: &mut silk_encoder,             /* I/O  State                                           */
    encControl: &mut silk_EncControlStruct,  /* I    Control status                                  */
    samplesIn: &[f32],                       /* I    Speech sample input vector                      */
    mut nSamplesIn: i32,                     /* I    Number of samples in input vector               */
    psRangeEnc: &mut ec_enc,                 /* I/O  Compressor data structure                       */
    nBytesOut: &mut i32,                     /* I/O  Number of bytes in payload (input: Max bytes)   */
    prefillFlag: i32,                        /* I    Flag to indicate prefilling buffers no coding   */
    activity: i32,                           /* I    Decision of Opus voice activity detector        */
) -> i32 {
    let psEnc = encState;
    let mut ret: i32;
    let mut samplesIn_off = 0usize;
    let st = stack::save();

    /* Mono only, no prefill */
    debug_assert!(encControl.nChannelsAPI == 1 && encControl.nChannelsInternal == 1 && psEnc.nChannelsInternal == 1);
    debug_assert!(prefillFlag == 0);
    let _ = prefillFlag;

    if encControl.reducedDependency != 0 {
        psEnc.state_Fxx[0].sCmn.first_frame_after_reset = 1;
    }
    psEnc.state_Fxx[0].sCmn.nFramesEncoded = 0;
    /* Check values in encoder control structure */
    ret = check_control_input(encControl);
    if ret != 0 {
        debug_assert!(false);
        return ret;
    }

    encControl.switchReady = 0;

    /* (Mono -> Stereo transition: not supported) */

    let transition = (encControl.payloadSize_ms != psEnc.state_Fxx[0].sCmn.PacketSize_ms)
        || (psEnc.nChannelsInternal != encControl.nChannelsInternal);

    psEnc.nChannelsAPI = encControl.nChannelsAPI;
    psEnc.nChannelsInternal = encControl.nChannelsInternal;

    let nBlocksOf10ms = silk_DIV32(100 * nSamplesIn, encControl.API_sampleRate);
    let tot_blocks = if nBlocksOf10ms > 1 { nBlocksOf10ms >> 1 } else { 1 };
    let mut curr_block = 0;
    {
        /* Only accept input lengths that are a multiple of 10 ms */
        if nBlocksOf10ms * encControl.API_sampleRate != 100 * nSamplesIn || nSamplesIn < 0 {
            debug_assert!(false);
            return SILK_ENC_INPUT_INVALID_NO_OF_SAMPLES;
        }
        /* Make sure no more than one packet can be produced */
        if 1000 * nSamplesIn > encControl.payloadSize_ms * encControl.API_sampleRate {
            debug_assert!(false);
            return SILK_ENC_INPUT_INVALID_NO_OF_SAMPLES;
        }
    }

    {
        ret = silk_control_encoder(&mut psEnc.state_Fxx[0], encControl, psEnc.allowBandwidthSwitch, 0, 0);
        if ret != 0 {
            debug_assert!(false);
            return ret;
        }
        if psEnc.state_Fxx[0].sCmn.first_frame_after_reset != 0 || transition {
            for i in 0..psEnc.state_Fxx[0].sCmn.nFramesPerPacket as usize {
                psEnc.state_Fxx[0].sCmn.LBRR_flags[i] = 0;
            }
        }
        psEnc.state_Fxx[0].sCmn.inDTX = psEnc.state_Fxx[0].sCmn.useDTX;
    }

    /* Input buffering/resampling and encoding */
    let nSamplesToBufferMax = 10 * nBlocksOf10ms * psEnc.state_Fxx[0].sCmn.fs_kHz;
    let nSamplesFromInputMax =
        silk_DIV32_16(nSamplesToBufferMax * psEnc.state_Fxx[0].sCmn.API_fs_Hz, psEnc.state_Fxx[0].sCmn.fs_kHz * 1000);
    let buf = st.alloc::<i16>(nSamplesFromInputMax as usize);
    loop {
        let mut curr_nBitsUsedLBRR = 0;
        let mut nSamplesToBuffer = psEnc.state_Fxx[0].sCmn.frame_length - psEnc.state_Fxx[0].sCmn.inputBufIx;
        nSamplesToBuffer = silk_min!(nSamplesToBuffer, nSamplesToBufferMax);
        let nSamplesFromInput = silk_DIV32_16(
            nSamplesToBuffer * psEnc.state_Fxx[0].sCmn.API_fs_Hz,
            psEnc.state_Fxx[0].sCmn.fs_kHz * 1000,
        );
        /* Resample and write to buffer */
        {
            for n in 0..nSamplesFromInput as usize {
                buf[n] = FLOAT2INT16(samplesIn[samplesIn_off + n]);
            }
            let s = &mut psEnc.state_Fxx[0].sCmn;
            let ix = (s.inputBufIx + 2) as usize;
            ret += silk_resampler(&mut s.resampler_state, &mut s.inputBuf[ix..], buf, nSamplesFromInput);
            s.inputBufIx += nSamplesToBuffer;
        }

        samplesIn_off += nSamplesFromInput as usize; /* * nChannelsAPI */
        nSamplesIn -= nSamplesFromInput;

        /* Default */
        psEnc.allowBandwidthSwitch = 0;

        /* Silk encoder */
        if psEnc.state_Fxx[0].sCmn.inputBufIx >= psEnc.state_Fxx[0].sCmn.frame_length {
            /* Enough data in input buffer, so encode */
            debug_assert!(psEnc.state_Fxx[0].sCmn.inputBufIx == psEnc.state_Fxx[0].sCmn.frame_length);

            /* Deal with LBRR data */
            if psEnc.state_Fxx[0].sCmn.nFramesEncoded == 0 {
                /* Create space at start of payload for VAD and FEC flags */
                let mut iCDF: [u8; 2] = [0, 0];
                iCDF[0] = (256
                    - silk_RSHIFT(256, (psEnc.state_Fxx[0].sCmn.nFramesPerPacket + 1) * encControl.nChannelsInternal))
                    as u8;
                ec_enc_icdf(psRangeEnc, 0, &iCDF, 8);
                curr_nBitsUsedLBRR = ec_tell(psRangeEnc);

                /* Encode any LBRR data from previous packet */
                /* Encode LBRR flags */
                {
                    let s = &mut psEnc.state_Fxx[0].sCmn;
                    let mut LBRR_symbol = 0;
                    for i in 0..s.nFramesPerPacket as usize {
                        LBRR_symbol |= silk_LSHIFT(s.LBRR_flags[i], i as i32);
                    }
                    s.LBRR_flag = if LBRR_symbol > 0 { 1 } else { 0 };
                    /* LBRR is never enabled, so there are no LBRR flags (nor LBRR indices and
                       excitation signals) to code; one frame per packet. */
                    debug_assert!(LBRR_symbol == 0);
                    debug_assert!(s.nFramesPerPacket == 1);
                }

                /* Reset LBRR flags */
                psEnc.state_Fxx[0].sCmn.LBRR_flags = [0; MAX_FRAMES_PER_PACKET as usize];
                curr_nBitsUsedLBRR = ec_tell(psRangeEnc) - curr_nBitsUsedLBRR;
            }

            silk_HP_variable_cutoff(&mut psEnc.state_Fxx);

            /* Total target bits for packet */
            let mut nBits = silk_DIV32_16(silk_MUL(encControl.bitRate, encControl.payloadSize_ms), 1000);
            /* Subtract bits used for LBRR */
            {
                /* psEnc->nBitsUsedLBRR is an exponential moving average of the LBRR usage,
                   except that for the first LBRR frame it does no averaging and for the first
                   frame after after LBRR, it goes back to zero immediately. */
                if curr_nBitsUsedLBRR < 10 {
                    psEnc.nBitsUsedLBRR = 0;
                } else if psEnc.nBitsUsedLBRR < 10 {
                    psEnc.nBitsUsedLBRR = curr_nBitsUsedLBRR;
                } else {
                    psEnc.nBitsUsedLBRR = (psEnc.nBitsUsedLBRR + curr_nBitsUsedLBRR) / 2;
                }
                nBits -= psEnc.nBitsUsedLBRR;
            }
            /* Divide by number of uncoded frames left in packet */
            nBits = silk_DIV32_16(nBits, psEnc.state_Fxx[0].sCmn.nFramesPerPacket);
            /* Convert to bits/second */
            let mut TargetRate_bps = if encControl.payloadSize_ms == 10 {
                silk_SMULBB(nBits, 100)
            } else {
                silk_SMULBB(nBits, 50)
            };
            /* Subtract fraction of bits in excess of target in previous frames and packets */
            TargetRate_bps -= silk_DIV32_16(silk_MUL(psEnc.nBitsExceeded, 1000), BITRESERVOIR_DECAY_TIME_MS);
            /* (Bits balance of earlier frames in the packet: one frame per packet) */
            debug_assert!(psEnc.state_Fxx[0].sCmn.nFramesEncoded == 0);
            /* Never exceed input bitrate */
            TargetRate_bps = silk_LIMIT!(TargetRate_bps, encControl.bitRate, 5000);

            /* Buffering */
            {
                let s = &mut psEnc.state_Fxx[0].sCmn;
                let fl = s.frame_length as usize;
                s.inputBuf[..2].copy_from_slice(&psEnc.sStereo.sMid);
                psEnc.sStereo.sMid.copy_from_slice(&s.inputBuf[fl..fl + 2]);
            }
            silk_encode_do_VAD_FLP(&mut psEnc.state_Fxx[0], activity);

            /* Encode */
            {
                /* Handling rate constraints (40/60 ms packets would split maxBits) */
                debug_assert!(tot_blocks == 1 && curr_block == 0);
                let maxBits = encControl.maxBits;
                /* CBR is not supported */
                debug_assert!(encControl.useCBR == 0);
                let useCBR = 0;

                let channelRate_bps = TargetRate_bps;

                if channelRate_bps > 0 {
                    silk_control_SNR(&mut psEnc.state_Fxx[0].sCmn, channelRate_bps);

                    /* Use independent coding if no previous frame available */
                    let condCoding = if psEnc.state_Fxx[0].sCmn.nFramesEncoded <= 0 {
                        CODE_INDEPENDENTLY
                    } else {
                        CODE_CONDITIONALLY
                    };
                    ret = silk_encode_frame_FLP(&mut psEnc.state_Fxx[0], nBytesOut, psRangeEnc, condCoding, maxBits, useCBR);
                    debug_assert!(ret == 0);
                }
                let s = &mut psEnc.state_Fxx[0].sCmn;
                s.controlled_since_last_payload = 0;
                s.inputBufIx = 0;
                s.nFramesEncoded += 1;
            }
            psEnc.prev_decode_only_middle =
                psEnc.sStereo.mid_only_flags[(psEnc.state_Fxx[0].sCmn.nFramesEncoded - 1) as usize] as i32;

            /* Insert VAD and FEC flags at beginning of bitstream */
            if *nBytesOut > 0 && psEnc.state_Fxx[0].sCmn.nFramesEncoded == psEnc.state_Fxx[0].sCmn.nFramesPerPacket {
                let mut flags: i32 = 0;
                {
                    let s = &psEnc.state_Fxx[0].sCmn;
                    for i in 0..s.nFramesPerPacket as usize {
                        flags = silk_LSHIFT(flags, 1);
                        flags |= s.VAD_flags[i] as i32;
                    }
                    flags = silk_LSHIFT(flags, 1);
                    flags |= s.LBRR_flag as i32;
                }
                ec_enc_patch_initial_bits(
                    psRangeEnc,
                    flags as u32,
                    ((psEnc.state_Fxx[0].sCmn.nFramesPerPacket + 1) * encControl.nChannelsInternal) as u32,
                );

                /* Return zero bytes if all channels DTXed */
                if psEnc.state_Fxx[0].sCmn.inDTX != 0 {
                    *nBytesOut = 0;
                }

                psEnc.nBitsExceeded += *nBytesOut * 8;
                psEnc.nBitsExceeded -= silk_DIV32_16(silk_MUL(encControl.bitRate, encControl.payloadSize_ms), 1000);
                psEnc.nBitsExceeded = silk_LIMIT!(psEnc.nBitsExceeded, 0, 10000);

                /* Update flag indicating if bandwidth switching is allowed */
                let speech_act_thr_for_switch_Q8 = silk_SMLAWB(
                    SILK_FIX_CONST(SPEECH_ACTIVITY_DTX_THRES as f64, 8),
                    SILK_FIX_CONST(
                        ((1.0f32 - SPEECH_ACTIVITY_DTX_THRES) / MAX_BANDWIDTH_SWITCH_DELAY_MS as f32) as f64,
                        16 + 8,
                    ),
                    psEnc.timeSinceSwitchAllowed_ms,
                );
                if psEnc.state_Fxx[0].sCmn.speech_activity_Q8 < speech_act_thr_for_switch_Q8 {
                    psEnc.allowBandwidthSwitch = 1;
                    psEnc.timeSinceSwitchAllowed_ms = 0;
                } else {
                    psEnc.allowBandwidthSwitch = 0;
                    psEnc.timeSinceSwitchAllowed_ms += encControl.payloadSize_ms;
                }
            }

            if nSamplesIn == 0 {
                break;
            }
        } else {
            break;
        }
        curr_block += 1;
    }

    psEnc.nPrevChannelsInternal = encControl.nChannelsInternal;

    encControl.allowBandwidthSwitch = psEnc.allowBandwidthSwitch;
    encControl.inWBmodeWithoutVariableLP =
        (psEnc.state_Fxx[0].sCmn.fs_kHz == 16 && psEnc.state_Fxx[0].sCmn.sLP.mode == 0) as i32;
    encControl.internalSampleRate = silk_SMULBB(psEnc.state_Fxx[0].sCmn.fs_kHz, 1000);
    encControl.stereoWidth_Q14 = if encControl.toMono != 0 { 0 } else { psEnc.sStereo.smth_width_Q14 as i32 };

    encControl.signalType = psEnc.state_Fxx[0].sCmn.indices.signalType as i32;
    encControl.offset = silk_Quantization_Offsets_Q10[(psEnc.state_Fxx[0].sCmn.indices.signalType >> 1) as usize]
        [psEnc.state_Fxx[0].sCmn.indices.quantOffsetType as usize] as i32;
    ret
}
