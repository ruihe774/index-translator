//! Port of silk/enc_API.c.
//!
//! Mono only, 16 kHz API and internal rate, 20 ms packets of one frame, VBR, no LBRR, no
//! prefill. Not ported (unreachable in this configuration): stereo, LBRR encoding and LBRR
//! flag coding (the VAD/LBRR header bits are still written as C does with LBRR disabled),
//! multi-frame packets, prefill, CBR, the `silk_EncControlStruct` (its fields are arguments of
//! `silk_Encode`), bandwidth-switching bookkeeping and the (delay-line only) resampler.

use crate::celt::entcode::ec_enc;
use crate::celt::entenc::{ec_enc_icdf, ec_enc_patch_initial_bits};
use crate::silk::HP_variable_cutoff::silk_HP_variable_cutoff;
use crate::silk::control_SNR::silk_control_SNR;
use crate::silk::control_codec::silk_control_encoder;
use crate::silk::define::*;
use crate::silk::float::encode_frame_FLP::{silk_encode_do_VAD_FLP, silk_encode_frame_FLP};
use crate::silk::float::sigproc_flp::float2int;
use crate::silk::float::structs_flp::silk_encoder;
use crate::silk::init_encoder::silk_init_encoder;
use crate::silk::macros::*;
use crate::silk::tuning_parameters::*;

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
    encState: &mut silk_encoder, /* I/O  State                                           */
) {
    // SAFETY: all-zero is a valid silk_encoder.
    unsafe { core::ptr::write_bytes(encState as *mut silk_encoder, 0, 1) };
    silk_init_encoder(&mut encState.state_Fxx);
}

/// Encode frame with Silk: one 20 ms frame (`MAX_FRAME_LENGTH` float samples, full scale
/// +-1.0). Returns the number of payload bytes (0 if the frame is DTX-ed); the signal type of
/// the frame is left in `encState.state_Fxx.sCmn.indices.signalType`.
pub fn silk_Encode(
    encState: &mut silk_encoder, /* I/O  State                                           */
    samplesIn: &[f32],           /* I    Speech sample input vector                      */
    psRangeEnc: &mut ec_enc,     /* I/O  Compressor data structure                       */
    bitRate: i32,                /* I    Bitrate during active speech in bits/second     */
    maxBits: i32,                /* I    Maximum number of bits allowed for the frame    */
    complexity: i32,             /* I    Complexity mode; 0 is lowest, 10 is highest     */
    packetLossPercentage: i32,   /* I    Uplink packet loss in percent (0-100)           */
    useDTX: i32,                 /* I    Flag to enable discontinuous transmission       */
    activity: i32,               /* I    Decision of Opus voice activity detector        */
) -> i32 {
    let psEnc = encState;
    let mut nBytesOut: i32 = 0;
    debug_assert!(samplesIn.len() == MAX_FRAME_LENGTH as usize);

    silk_control_encoder(&mut psEnc.state_Fxx.sCmn, complexity, packetLossPercentage, useDTX);
    psEnc.state_Fxx.sCmn.inDTX = useDTX;

    /* Input buffering: the 16 kHz -> 16 kHz resampler is a delay line, and C's mono "stereo mid"
       buffer adds one more sample of delay (see INPUT_DELAY). */
    {
        let s = &mut psEnc.state_Fxx.sCmn;
        const D: usize = INPUT_DELAY as usize;
        const N: usize = MAX_FRAME_LENGTH as usize;
        s.inputBuf[..D].copy_from_slice(&s.delayBuf);
        for n in 0..N - D {
            s.inputBuf[D + n] = FLOAT2INT16(samplesIn[n]);
        }
        for n in 0..D {
            s.delayBuf[n] = FLOAT2INT16(samplesIn[N - D + n]);
        }
    }

    /* Create space at start of payload for VAD and FEC flags */
    ec_enc_icdf(psRangeEnc, 0, &[192, 0], 8);

    silk_HP_variable_cutoff(&mut psEnc.state_Fxx.sCmn);

    /* Total target bits for packet */
    let nBits = silk_DIV32_16(silk_MUL(bitRate, 20), 1000);
    /* Convert to bits/second */
    let mut TargetRate_bps = silk_SMULBB(nBits, 50);
    /* Subtract fraction of bits in excess of target in previous frames and packets */
    TargetRate_bps -= silk_DIV32_16(silk_MUL(psEnc.nBitsExceeded, 1000), BITRESERVOIR_DECAY_TIME_MS);
    /* Never exceed input bitrate */
    TargetRate_bps = silk_LIMIT!(TargetRate_bps, bitRate, 5000);

    silk_encode_do_VAD_FLP(&mut psEnc.state_Fxx, activity);

    /* Encode */
    debug_assert!(TargetRate_bps > 0);
    silk_control_SNR(&mut psEnc.state_Fxx.sCmn, TargetRate_bps);
    let ret = silk_encode_frame_FLP(&mut psEnc.state_Fxx, &mut nBytesOut, psRangeEnc, maxBits);
    debug_assert!(ret == 0);

    /* Insert VAD and FEC flags at beginning of bitstream */
    if nBytesOut > 0 {
        let flags = (psEnc.state_Fxx.sCmn.VAD_flags[0] as i32) << 1; /* LBRR flag is 0 */
        ec_enc_patch_initial_bits(psRangeEnc, flags as u32, 2);

        /* Return zero bytes if all channels DTXed */
        if psEnc.state_Fxx.sCmn.inDTX != 0 {
            nBytesOut = 0;
        }

        psEnc.nBitsExceeded += nBytesOut * 8;
        psEnc.nBitsExceeded -= silk_DIV32_16(silk_MUL(bitRate, 20), 1000);
        psEnc.nBitsExceeded = silk_LIMIT!(psEnc.nBitsExceeded, 0, 10000);
    }
    nBytesOut
}
