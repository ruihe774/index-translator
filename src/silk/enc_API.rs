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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::celt::entcode::tests_support::same_enc;
    use crate::silk::control_codec::tests::canon_ptrs;
    use crate::silk::float::encode_frame_FLP::tests::{bytes, encoder_fields, first_diff, gen_frame, kind_at};
    use crate::testutil::{CSilkEncoder, Rng, SpeechGen, zeroed_box};
    use std::boxed::Box;
    use std::vec::Vec;

    mod c {
        use crate::celt::entcode::ec_enc;
        use crate::silk::float::structs_flp::silk_encoder;
        use crate::silk::structs::silk_EncControlStruct;
        unsafe extern "C" {
            pub fn silk_InitEncoder(encState: *mut silk_encoder, channels: i32, arch: i32, encStatus: *mut silk_EncControlStruct) -> i32;
            pub fn silk_Encode(
                encState: *mut silk_encoder,
                encControl: *mut silk_EncControlStruct,
                samplesIn: *const f32,
                nSamplesIn: i32,
                psRangeEnc: *mut ec_enc,
                nBytesOut: *mut i32,
                prefillFlag: i32,
                activity: i32,
            ) -> i32;
            pub fn ec_enc_init(this: *mut ec_enc, buf: *mut u8, size: u32);
            pub fn ec_enc_done(this: *mut ec_enc);
        }
    }

    fn encoder_bytes(e: &silk_encoder) -> Vec<u8> {
        let mut v = bytes(e).to_vec();
        canon_ptrs(&mut v, core::mem::offset_of!(silk_encoder, state_Fxx));
        v
    }

    fn same_encoder(r: &silk_encoder, c: &silk_encoder, what: &str) {
        if let Some(d) = first_diff(&encoder_bytes(r), &encoder_bytes(c), &encoder_fields()) {
            panic!("{what}: encoder state differs: {d}");
        }
    }

    /// A Rust and a C encoder, each on its own state, configured like CSilkEncoder::new.
    struct Pair {
        r: Box<silk_encoder>,
        c: Box<silk_encoder>,
        ctl_r: silk_EncControlStruct,
        ctl_c: silk_EncControlStruct,
    }

    impl Pair {
        fn new(bitrate: i32, complexity: i32, dtx: bool, loss: i32) -> Pair {
            let mut r: Box<silk_encoder> = zeroed_box();
            let mut c: Box<silk_encoder> = zeroed_box();
            // Garbage in the state before init must not matter.
            unsafe { core::ptr::write_bytes(&mut *r as *mut silk_encoder as *mut u8, 0x6B, core::mem::size_of::<silk_encoder>()) };
            let mut ctl_r: silk_EncControlStruct = unsafe { core::mem::zeroed() };
            let mut ctl_c: silk_EncControlStruct = unsafe { core::mem::zeroed() };
            assert_eq!(silk_InitEncoder(&mut r, &mut ctl_r), unsafe { c::silk_InitEncoder(&mut *c, 1, 0, &mut ctl_c) });
            same_encoder(&r, &c, "after init");
            assert_eq!(bytes(&ctl_r), bytes(&ctl_c), "control after init");
            let mut ctl = CSilkEncoder::new(bitrate, complexity, dtx).ctl;
            ctl.packetLossPercentage = loss;
            Pair { r, c, ctl_r: ctl, ctl_c: ctl }
        }

        fn set(&mut self, f: impl Fn(&mut silk_EncControlStruct)) {
            f(&mut self.ctl_r);
            f(&mut self.ctl_c);
        }

        /// Encodes one 20 ms frame with both encoders and compares everything.
        fn encode(&mut self, pcm: &[f32; 320], activity: i32, what: &str) -> usize {
            let (mut buf_r, mut buf_c) = ([0u8; 1275], [0u8; 1275]);
            let mut enc_r: ec_enc = unsafe { core::mem::zeroed() };
            let mut enc_c: ec_enc = unsafe { core::mem::zeroed() };
            crate::celt::entenc::ec_enc_init(&mut enc_r, buf_r.as_mut_ptr(), 1275);
            unsafe { c::ec_enc_init(&mut enc_c, buf_c.as_mut_ptr(), 1275) };
            let (mut n_r, mut n_c) = (1275, 1275);
            let a = silk_Encode(&mut self.r, &mut self.ctl_r, pcm, 320, &mut enc_r, &mut n_r, 0, activity);
            let b = unsafe { c::silk_Encode(&mut *self.c, &mut self.ctl_c, pcm.as_ptr(), 320, &mut enc_c, &mut n_c, 0, activity) };
            assert_eq!(a, b, "{what}: return value");
            assert_eq!(n_r, n_c, "{what}: nBytesOut");
            assert_eq!(enc_r.rng, enc_c.rng, "{what}: range coder rng");
            same_enc(&enc_r, &enc_c);
            same_encoder(&self.r, &self.c, what);
            assert_eq!(bytes(&self.ctl_r), bytes(&self.ctl_c), "{what}: control struct");
            crate::celt::entenc::ec_enc_done(&mut enc_r);
            unsafe { c::ec_enc_done(&mut enc_c) };
            same_enc(&enc_r, &enc_c);
            assert!(buf_r[..] == buf_c[..], "{what}: payload");
            n_r as usize
        }
    }

    /// Float input for one frame: the i16 test signals, with fractional parts, and some
    /// frames beyond full scale (clipped by FLOAT2INT16).
    fn input(kind: u32, sg: &mut SpeechGen, rng: &mut Rng, f: usize) -> [f32; 320] {
        let pcm = gen_frame(kind, sg, rng);
        let over = if f % 37 == 5 { 1.7f32 } else { 1.0 };
        core::array::from_fn(|i| (pcm[i] as f32 + rng.f32_unit() * 0.5) * (over / 32768.0))
    }

    fn run(bitrate: i32, complexity: i32, dtx: bool, loss: i32, frames: usize, seed: u64) -> (usize, usize) {
        let mut p = Pair::new(bitrate, complexity, dtx, loss);
        let mut sg = SpeechGen::new(seed);
        let mut rng = Rng::new(seed ^ 0xABCD);
        let (mut bytes, mut dtx_frames) = (0, 0);
        for f in 0..frames {
            let x = input(kind_at(f, seed), &mut sg, &mut rng, f);
            let activity = if f % 9 == 3 { rng.range(-1, 1) } else { -1 };
            let what = std::format!("{bitrate} bps, complexity {complexity}, dtx {dtx}, loss {loss}%, frame {f}");
            let n = p.encode(&x, activity, &what);
            bytes += n;
            dtx_frames += (n == 0) as usize;
        }
        (bytes, dtx_frames)
    }

    #[test]
    fn encode_matches_c() {
        let mut total_dtx = 0;
        let cfgs: [(i32, i32, bool, i32); 14] = [
            (6000, 0, false, 0),
            (6000, 10, true, 0),
            (8000, 1, true, 5),
            (10000, 2, false, 0),
            (12000, 3, true, 0),
            (14000, 4, false, 15),
            (16000, 5, true, 0),
            (20000, 6, false, 0),
            (24000, 7, true, 25),
            (28000, 8, false, 0),
            (32000, 9, true, 0),
            (40000, 10, false, 0),
            (40000, 0, true, 50),
            (20000, 10, true, 10),
        ];
        for (i, &(bitrate, complexity, dtx, loss)) in cfgs.iter().enumerate() {
            let (bytes, dtx_frames) = run(bitrate, complexity, dtx, loss, 300, 1000 + i as u64);
            assert!(bytes > 300 * bitrate as usize / 8 / 50 / 4, "{bitrate}: {bytes} bytes");
            assert!(dtx || dtx_frames == 0);
            total_dtx += dtx_frames;
        }
        assert!(total_dtx > 50, "only {total_dtx} DTX frames");
    }

    #[test]
    fn encode_matches_c_changing_settings() {
        let mut rng = Rng::new(4242);
        for seed in 0..3u64 {
            let mut p = Pair::new(20000, 5, false, 0);
            let mut sg = SpeechGen::new(seed + 50);
            for f in 0..400 {
                if f % 17 == 0 {
                    let (b, c, d, l) = (rng.range(6000, 40000), rng.range(0, 10), rng.range(0, 1), rng.range(0, 30));
                    p.set(|ctl| {
                        ctl.bitRate = b;
                        ctl.complexity = c;
                        ctl.useDTX = d;
                        ctl.packetLossPercentage = l;
                    });
                }
                if f % 50 == 25 {
                    let rd = rng.range(0, 1);
                    p.set(|ctl| ctl.reducedDependency = rd);
                }
                if f % 31 == 7 {
                    let mb = rng.range(100, 1275 * 8);
                    p.set(|ctl| ctl.maxBits = mb);
                }
                let x = input(kind_at(f, seed + 3), &mut sg, &mut rng, f);
                let what = std::format!("seed {seed}, frame {f}");
                p.encode(&x, -1, &what);
            }
        }
    }

    #[test]
    fn init_resets_running_encoder() {
        // Re-init of a used encoder (as OPUS_RESET_STATE does) matches C.
        let mut p = Pair::new(16000, 8, true, 0);
        let mut sg = SpeechGen::new(1);
        let mut rng = Rng::new(2);
        for f in 0..30 {
            let x = input(0, &mut sg, &mut rng, f);
            p.encode(&x, -1, "before reset");
        }
        let (mut a, mut b) = (p.ctl_r, p.ctl_c);
        assert_eq!(silk_InitEncoder(&mut p.r, &mut a), unsafe { c::silk_InitEncoder(&mut *p.c, 1, 0, &mut b) });
        same_encoder(&p.r, &p.c, "after reset");
        assert_eq!(bytes(&a), bytes(&b));
        for f in 0..30 {
            let x = input(0, &mut sg, &mut rng, f);
            p.encode(&x, -1, "after reset");
        }
    }
}
