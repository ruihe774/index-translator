//! Port of the CELT-only path of src/opus_encoder.c (OPUS_APPLICATION_RESTRICTED_CELT),
//! specialised to 48 kHz, mono or stereo (chosen at init), 20 ms frames, VBR (constrained or
//! not), DTX supported, float build without the tonality analysis.
//!
//! What C executes in this configuration is ported as is; the rest is removed:
//! - the mode is always MODE_CELT_ONLY (RESTRICTED_CELT), so there is no SILK, hybrid,
//!   redundancy (`prev_mode` is only ever 0 or CELT-only), prefill (`to_celt`, `tmp_prefill`
//!   and the CELT prefill need a mode change or a non-RESTRICTED_CELT application), FEC
//!   (`decide_fec` returns 0 for CELT-only), DRED, QEXT, LFE, surround energy masking;
//! - one 20 ms frame per packet: `frame_size_select` with OPUS_FRAMESIZE_ARG and 960 samples is
//!   just a length check, no repacketizer; VBR only (`use_vbr == 1`): no CBR, no padding;
//! - no analysis: `analysis_info.valid` is always 0 (`run_analysis` would be called at
//!   complexity >= 7, but the reference replaces it with a stub). Removed with it:
//!   `detected_bandwidth`, the voice_ratio estimate, CELT_SET_ANALYSIS (the CELT state's
//!   `analysis` stays zeroed);
//! - state and computations that cannot influence the output in this configuration:
//!   * `encoder_buffer == 0` and `delay_compensation` unused (RESTRICTED_CELT), so the
//!     `delay_buffer` copies move zero samples;
//!   * `variable_HP_smth2_Q15`/`cutoff_Hz` only feed the VOIP high-pass (`hp_cutoff`);
//!   * `HB_gain == prev_HB_gain == Q15ONE` (hybrid only), so `gain_fade` never runs;
//!   * `compute_stereo_width`/`width_mem`: the width only feeds the AUDIO/VOIP mode decision;
//!   * `max_rate` (hybrid bandwidth cap), the mode-0 `equiv_rate` after the channel decision
//!     (mode decision only), `prev_channels`/`prev_framesize`/`silk_bw_switch`/`nonfinal_frame`
//!     and the SILK control fields other than the ones kept in `silk_EncControlStruct` below.
//!
//! `OpusEncoder` is statically sizable (`new_zeroed` is `const`, no allocation); call `init`
//! before use.

use crate::celt::arch::{IMAX, IMIN, MAX32, celt_isnan};
use crate::celt::celt_encoder::{
    CELTEncoder, celt_encode_with_ec, celt_encoder_get_final_range, celt_encoder_init, celt_encoder_set_bitrate,
    celt_encoder_set_channels, celt_encoder_set_complexity, celt_encoder_set_end_band, celt_encoder_set_lsb_depth,
    celt_encoder_set_packet_loss_perc, celt_encoder_set_phase_inversion_disabled, celt_encoder_set_prediction,
    celt_encoder_set_signalling, celt_encoder_set_start_band, celt_encoder_set_vbr, celt_encoder_set_vbr_constraint,
};
use crate::celt::celt::bits_to_bitrate;
use crate::celt::entcode::{ec_enc, ec_tell};
use crate::celt::entenc::{ec_enc_init, ec_enc_shrink};
use crate::celt::mathops::celt_maxabs_res;
use crate::celt::pitch::celt_inner_prod;
use crate::opus::defines::*;
use crate::stack;

/* Fixed configuration. */
const FS: i32 = 48000;
const FRAME_SIZE: i32 = 960;
/// 1276 bytes: the largest Opus frame.
const PACKET_SIZE_CAP: i32 = 1276;
/// Input limit: `MAX_ENCODING_DEPTH` for the float API.
const MAX_ENCODING_DEPTH: i32 = 24;
const VERY_SMALL: f32 = 1e-30f32;
const PSEUDO_SNR_THRESHOLD: f32 = 316.23f32; /* 10^(25/10) */

/* From silk/define.h */
const NB_SPEECH_FRAMES_BEFORE_DTX: i32 = 10; /* eq 200 ms */
const MAX_CONSECUTIVE_DTX: i32 = 20; /* eq 400 ms */
const VAD_NO_DECISION: i32 = -1;

/* Transition tables for the voice and music. First column is the
middle (memoriless) threshold. The second column is the hysteresis
(difference with the middle) */
static mono_voice_bandwidth_thresholds: [i32; 8] = [
    9000, 700, /* NB<->MB */
    9000, 700, /* MB<->WB */
    13500, 1000, /* WB<->SWB */
    14000, 2000, /* SWB<->FB */
];
static mono_music_bandwidth_thresholds: [i32; 8] = [
    9000, 700, /* NB<->MB */
    9000, 700, /* MB<->WB */
    11000, 1000, /* WB<->SWB */
    12000, 2000, /* SWB<->FB */
];
static stereo_voice_bandwidth_thresholds: [i32; 8] = [
    9000, 700, /* NB<->MB */
    9000, 700, /* MB<->WB */
    13500, 1000, /* WB<->SWB */
    14000, 2000, /* SWB<->FB */
];
static stereo_music_bandwidth_thresholds: [i32; 8] = [
    9000, 700, /* NB<->MB */
    9000, 700, /* MB<->WB */
    11000, 1000, /* WB<->SWB */
    12000, 2000, /* SWB<->FB */
];
/* Threshold bit-rates for switching between mono and stereo */
const stereo_voice_threshold: i32 = 19000;
const stereo_music_threshold: i32 = 17000;

/// The `silk_EncControlStruct` fields the CELT-only path still reads or writes (the Opus
/// layer keeps these settings in `st->silk_mode` even without a SILK encoder).
pub struct silk_EncControlStruct {
    pub packetLossPercentage: i32,
    pub complexity: i32,
    pub useDTX: i32,
    pub reducedDependency: i32,
    pub stereoWidth_Q14: i32,
}

pub struct OpusEncoder {
    celt_enc: CELTEncoder,
    silk_mode: silk_EncControlStruct,
    channels: i32,
    force_channels: i32,
    signal_type: i32,
    user_bandwidth: i32,
    max_bandwidth: i32,
    voice_ratio: i32,
    vbr_constraint: i32,
    bitrate_bps: i32,
    user_bitrate_bps: i32,
    lsb_depth: i32,
    /// general DTX for both SILK and CELT
    use_dtx: i32,

    /* OPUS_ENCODER_RESET_START */
    stream_channels: i32,
    hybrid_stereo_width_Q14: i16,
    hp_mem: [f32; 4],
    mode: i32,
    prev_mode: i32,
    bandwidth: i32,
    /// Bandwidth determined automatically from the rate (before any other adjustment)
    auto_bandwidth: i32,
    first: i32,
    nb_no_activity_ms_Q1: i32,
    peak_signal_energy: f32,
    rangeFinal: u32,
}

fn gen_toc(mode: i32, framerate: i32, bandwidth: i32, channels: i32) -> u8 {
    let mut framerate = framerate;
    let mut period = 0;
    while framerate < 400 {
        framerate <<= 1;
        period += 1;
    }
    let mut toc: i32;
    if mode == MODE_SILK_ONLY {
        toc = (bandwidth - OPUS_BANDWIDTH_NARROWBAND) << 5;
        toc |= (period - 2) << 3;
    } else if mode == MODE_CELT_ONLY {
        let mut tmp = bandwidth - OPUS_BANDWIDTH_MEDIUMBAND;
        if tmp < 0 {
            tmp = 0;
        }
        toc = 0x80;
        toc |= tmp << 5;
        toc |= period << 3;
    } else {
        /* Hybrid */
        toc = 0x60;
        toc |= (bandwidth - OPUS_BANDWIDTH_SUPERWIDEBAND) << 4;
        toc |= (period - 2) << 3;
    }
    toc |= ((channels == 2) as i32) << 2;
    toc as u8
}

/// Float `dc_reject`: one-pole high-pass, state in `hp_mem[0]` (and `hp_mem[2]` for stereo).
fn dc_reject(input: &[f32], cutoff_Hz: i32, out: &mut [f32], hp_mem: &mut [f32; 4], len: usize, channels: i32, Fs: i32) {
    let coef: f32 = 6.3f32 * cutoff_Hz as f32 / Fs as f32;
    let coef2: f32 = 1.0 - coef;
    if channels == 2 {
        let mut m0 = hp_mem[0];
        let mut m2 = hp_mem[2];
        for i in 0..len {
            let x0 = input[2 * i];
            let x1 = input[2 * i + 1];
            let out0 = x0 - m0;
            let out1 = x1 - m2;
            m0 = coef * x0 + VERY_SMALL + coef2 * m0;
            m2 = coef * x1 + VERY_SMALL + coef2 * m2;
            out[2 * i] = out0;
            out[2 * i + 1] = out1;
        }
        hp_mem[0] = m0;
        hp_mem[2] = m2;
    } else {
        let mut m0 = hp_mem[0];
        for i in 0..len {
            let x = input[i];
            let y = x - m0;
            m0 = coef * x + VERY_SMALL + coef2 * m0;
            out[i] = y;
        }
        hp_mem[0] = m0;
    }
}

/// Stereo width reduction, in place (`in == out` in the only caller). `window` is the CELT
/// window, `overlap48` its length at 48 kHz.
fn stereo_fade(buf: &mut [f32], g1: f32, g2: f32, overlap48: i32, frame_size: i32, channels: i32, window: &[f32], Fs: i32) {
    let inc = IMAX(1, 48000 / Fs);
    let overlap = overlap48 / inc;
    let g1 = 1.0f32 - g1;
    let g2 = 1.0f32 - g2;
    let ch = channels as usize;
    let mut i = 0usize;
    while i < overlap as usize {
        let mut w = window[i * inc as usize];
        w = w * w;
        let g = w * g2 + (1.0f32 - w) * g1;
        let mut diff = 0.5f32 * (buf[i * ch] - buf[i * ch + 1]);
        diff = g * diff;
        buf[i * ch] = buf[i * ch] - diff;
        buf[i * ch + 1] = buf[i * ch + 1] + diff;
        i += 1;
    }
    while i < frame_size as usize {
        let mut diff = 0.5f32 * (buf[i * ch] - buf[i * ch + 1]);
        diff = g2 * diff;
        buf[i * ch] = buf[i * ch] - diff;
        buf[i * ch + 1] = buf[i * ch + 1] + diff;
        i += 1;
    }
}

/// Returns the equivalent bitrate corresponding to 20 ms frames, complexity 10 VBR operation.
fn compute_equiv_rate(bitrate: i32, channels: i32, frame_rate: i32, vbr: i32, mode: i32, complexity: i32, loss: i32) -> i32 {
    let mut equiv = bitrate;
    /* Take into account overhead from smaller frames. */
    if frame_rate > 50 {
        equiv -= (40 * channels + 20) * (frame_rate - 50);
    }
    /* CBR is about a 8% penalty for both SILK and CELT. */
    if vbr == 0 {
        equiv -= equiv / 12;
    }
    /* Complexity makes about 10% difference (from 0 to 10) in general. */
    equiv = equiv * (90 + complexity) / 100;
    if mode == MODE_SILK_ONLY || mode == MODE_HYBRID {
        /* SILK complexity 0-1 uses the non-delayed-decision NSQ, which
        costs about 20%. */
        if complexity < 2 {
            equiv = equiv * 4 / 5;
        }
        equiv -= equiv * loss / (6 * loss + 10);
    } else if mode == MODE_CELT_ONLY {
        /* CELT complexity 0-4 doesn't have the pitch filter, which costs
        about 10%. */
        if complexity < 5 {
            equiv = equiv * 9 / 10;
        }
    } else {
        /* Mode not known yet */
        /* Half the SILK loss*/
        equiv -= equiv * loss / (12 * loss + 20);
    }
    equiv
}

fn compute_frame_energy(pcm: &[f32], frame_size: i32, channels: i32) -> f32 {
    let len = frame_size * channels;
    celt_inner_prod(pcm, pcm, len) / len as f32
}

fn is_digital_silence(pcm: &[f32], frame_size: i32, channels: i32, lsb_depth: i32) -> bool {
    let sample_max = celt_maxabs_res(pcm, frame_size * channels);
    sample_max <= 1.0f32 / (1i32 << lsb_depth) as f32
}

/// Decides if DTX should be turned on (=1) or off (=0).
fn decide_dtx_mode(
    activity: i32,                 /* indicates if this frame contains speech/music */
    nb_no_activity_ms_Q1: &mut i32, /* number of consecutive milliseconds with no activity, in Q1 */
    frame_size_ms_Q1: i32,         /* number of milliseconds in this update, in Q1 */
) -> i32 {
    if activity == 0 {
        /* The number of consecutive DTX frames should be within the allowed bounds.
        Note that the allowed bound is defined in the SILK headers and assumes 20 ms
        frames. As this function can be called with any frame length, a conversion to
        milliseconds is done before the comparisons. */
        *nb_no_activity_ms_Q1 += frame_size_ms_Q1;
        if *nb_no_activity_ms_Q1 > NB_SPEECH_FRAMES_BEFORE_DTX * 20 * 2 {
            if *nb_no_activity_ms_Q1 <= (NB_SPEECH_FRAMES_BEFORE_DTX + MAX_CONSECUTIVE_DTX) * 20 * 2 {
                /* Valid frame for DTX! */
                return 1;
            } else {
                *nb_no_activity_ms_Q1 = NB_SPEECH_FRAMES_BEFORE_DTX * 20 * 2;
            }
        }
    } else {
        *nb_no_activity_ms_Q1 = 0;
    }
    0
}

impl OpusEncoder {
    /// All-zero state (as after the C OPUS_CLEAR), usable in a `static`. Call `init` before
    /// encoding.
    pub const fn new_zeroed() -> Self {
        OpusEncoder {
            celt_enc: CELTEncoder::new_zeroed(),
            silk_mode: silk_EncControlStruct {
                packetLossPercentage: 0,
                complexity: 0,
                useDTX: 0,
                reducedDependency: 0,
                stereoWidth_Q14: 0,
            },
            channels: 0,
            force_channels: 0,
            signal_type: 0,
            user_bandwidth: 0,
            max_bandwidth: 0,
            voice_ratio: 0,
            vbr_constraint: 0,
            bitrate_bps: 0,
            user_bitrate_bps: 0,
            lsb_depth: 0,
            use_dtx: 0,
            stream_channels: 0,
            hybrid_stereo_width_Q14: 0,
            hp_mem: [0.0; 4],
            mode: 0,
            prev_mode: 0,
            bandwidth: 0,
            auto_bandwidth: 0,
            first: 0,
            nb_no_activity_ms_Q1: 0,
            peak_signal_energy: 0.0,
            rangeFinal: 0,
        }
    }

    /// `opus_encoder_init(st, 48000, channels, OPUS_APPLICATION_RESTRICTED_CELT)`. Defaults as
    /// in C: bitrate `OPUS_AUTO`, complexity 9, constrained VBR, DTX off.
    pub fn init(&mut self, channels: i32) -> i32 {
        if channels != 1 && channels != 2 {
            return OPUS_BAD_ARG;
        }
        *self = Self::new_zeroed();

        self.channels = channels;
        self.stream_channels = channels;

        /* default SILK parameters (the ones still used) */
        self.silk_mode.packetLossPercentage = 0;
        self.silk_mode.complexity = 9;
        self.silk_mode.useDTX = 0;
        self.silk_mode.reducedDependency = 0;

        /* Initialize CELT encoder */
        let err = celt_encoder_init(&mut self.celt_enc, FS, channels);
        if err != OPUS_OK {
            return OPUS_INTERNAL_ERROR;
        }
        celt_encoder_set_signalling(&mut self.celt_enc, 0);
        celt_encoder_set_complexity(&mut self.celt_enc, self.silk_mode.complexity);

        /* use_vbr = 1 (fixed) */
        /* Makes constrained VBR the default (safer for real-time use) */
        self.vbr_constraint = 1;
        self.user_bitrate_bps = OPUS_AUTO;
        self.bitrate_bps = 3000 + FS * channels;
        self.signal_type = OPUS_AUTO;
        self.user_bandwidth = OPUS_AUTO;
        self.max_bandwidth = OPUS_BANDWIDTH_FULLBAND;
        self.force_channels = OPUS_AUTO;
        self.voice_ratio = -1;
        self.lsb_depth = 24;

        self.hybrid_stereo_width_Q14 = 1 << 14;
        self.first = 1;
        self.mode = MODE_HYBRID;
        self.bandwidth = OPUS_BANDWIDTH_FULLBAND;
        OPUS_OK
    }

    /// `OPUS_SET_BITRATE`: `OPUS_AUTO`, `OPUS_BITRATE_MAX` or a rate in bits/s (clamped to
    /// 500..=750000*channels).
    pub fn set_bitrate(&mut self, value: i32) -> i32 {
        let mut value = value;
        if value != OPUS_AUTO && value != OPUS_BITRATE_MAX {
            if value <= 0 {
                return OPUS_BAD_ARG;
            } else if value <= 500 {
                value = 500;
            } else if value > 750000 * self.channels {
                value = 750000 * self.channels;
            }
        }
        self.user_bitrate_bps = value;
        OPUS_OK
    }

    /// `OPUS_SET_FORCE_CHANNELS`: `OPUS_AUTO`, 1 or (stereo encoders) 2.
    pub fn set_force_channels(&mut self, value: i32) -> i32 {
        if (value < 1 || value > self.channels) && value != OPUS_AUTO {
            return OPUS_BAD_ARG;
        }
        self.force_channels = value;
        OPUS_OK
    }

    /// `OPUS_SET_MAX_BANDWIDTH` (`OPUS_BANDWIDTH_*`). The SILK `maxInternalSampleRate` it also
    /// sets is not used by CELT-only.
    pub fn set_max_bandwidth(&mut self, value: i32) -> i32 {
        if value < OPUS_BANDWIDTH_NARROWBAND || value > OPUS_BANDWIDTH_FULLBAND {
            return OPUS_BAD_ARG;
        }
        self.max_bandwidth = value;
        OPUS_OK
    }

    /// `OPUS_SET_BANDWIDTH` (`OPUS_BANDWIDTH_*` or `OPUS_AUTO`). The SILK
    /// `maxInternalSampleRate` it also sets is not used by CELT-only.
    pub fn set_bandwidth(&mut self, value: i32) -> i32 {
        if (value < OPUS_BANDWIDTH_NARROWBAND || value > OPUS_BANDWIDTH_FULLBAND) && value != OPUS_AUTO {
            return OPUS_BAD_ARG;
        }
        self.user_bandwidth = value;
        OPUS_OK
    }

    /// `OPUS_SET_DTX` (0 or 1).
    pub fn set_dtx(&mut self, value: i32) -> i32 {
        if value < 0 || value > 1 {
            return OPUS_BAD_ARG;
        }
        self.use_dtx = value;
        OPUS_OK
    }

    /// `OPUS_SET_COMPLEXITY` (0..=10).
    pub fn set_complexity(&mut self, value: i32) -> i32 {
        if value < 0 || value > 10 {
            return OPUS_BAD_ARG;
        }
        self.silk_mode.complexity = value;
        celt_encoder_set_complexity(&mut self.celt_enc, value);
        OPUS_OK
    }

    /// `OPUS_SET_PACKET_LOSS_PERC` (0..=100).
    pub fn set_packet_loss_perc(&mut self, value: i32) -> i32 {
        if value < 0 || value > 100 {
            return OPUS_BAD_ARG;
        }
        self.silk_mode.packetLossPercentage = value;
        celt_encoder_set_packet_loss_perc(&mut self.celt_enc, value);
        OPUS_OK
    }

    /// `OPUS_SET_VBR_CONSTRAINT` (0 or 1).
    pub fn set_vbr_constraint(&mut self, value: i32) -> i32 {
        if value < 0 || value > 1 {
            return OPUS_BAD_ARG;
        }
        self.vbr_constraint = value;
        OPUS_OK
    }

    /// `OPUS_SET_SIGNAL` (`OPUS_AUTO`, `OPUS_SIGNAL_VOICE`, `OPUS_SIGNAL_MUSIC`). In CELT-only
    /// mode it biases the mono/stereo and bandwidth decisions.
    pub fn set_signal(&mut self, value: i32) -> i32 {
        if value != OPUS_AUTO && value != OPUS_SIGNAL_VOICE && value != OPUS_SIGNAL_MUSIC {
            return OPUS_BAD_ARG;
        }
        self.signal_type = value;
        OPUS_OK
    }

    /// `OPUS_SET_LSB_DEPTH` (8..=24).
    pub fn set_lsb_depth(&mut self, value: i32) -> i32 {
        if value < 8 || value > 24 {
            return OPUS_BAD_ARG;
        }
        self.lsb_depth = value;
        OPUS_OK
    }

    /// `OPUS_SET_PREDICTION_DISABLED` (0 or 1).
    pub fn set_prediction_disabled(&mut self, value: i32) -> i32 {
        if value > 1 || value < 0 {
            return OPUS_BAD_ARG;
        }
        self.silk_mode.reducedDependency = value;
        OPUS_OK
    }

    /// `OPUS_SET_PHASE_INVERSION_DISABLED` (0 or 1).
    pub fn set_phase_inversion_disabled(&mut self, value: i32) -> i32 {
        if value < 0 || value > 1 {
            return OPUS_BAD_ARG;
        }
        celt_encoder_set_phase_inversion_disabled(&mut self.celt_enc, value);
        OPUS_OK
    }

    /// `OPUS_GET_LOOKAHEAD`: `Fs/400` samples (no delay compensation for RESTRICTED_CELT).
    pub fn get_lookahead(&self) -> i32 {
        FS / 400
    }

    /// `OPUS_GET_FINAL_RANGE`: range coder state after the last `encode*` call.
    pub fn get_final_range(&self) -> u32 {
        self.rangeFinal
    }

    /// `OPUS_GET_IN_DTX`.
    pub fn get_in_dtx(&self) -> i32 {
        /* The SILK branch (prev_mode SILK-only or hybrid) is unreachable. */
        debug_assert!(self.prev_mode == 0 || self.prev_mode == MODE_CELT_ONLY);
        if self.use_dtx != 0 {
            /* DTX determined by Opus. */
            (self.nb_no_activity_ms_Q1 >= NB_SPEECH_FRAMES_BEFORE_DTX * 20 * 2) as i32
        } else {
            0
        }
    }

    /// `opus_encode`: 960 samples per channel of interleaved i16 PCM. Returns the packet
    /// length or a negative Opus error code.
    pub fn encode(&mut self, pcm: &[i16], data: &mut [u8]) -> i32 {
        /* frame_size_select(): only OPUS_FRAMESIZE_ARG with 20 ms frames */
        let n = (FRAME_SIZE * self.channels) as usize;
        if self.channels == 0 || pcm.len() != n {
            return OPUS_BAD_ARG;
        }
        let st = stack::save();
        let input = st.alloc::<f32>(n);
        for i in 0..n {
            /* INT16TORES */
            input[i] = pcm[i] as f32 * (1.0f32 / 32768.0f32);
        }
        self.encode_native(input, FRAME_SIZE, data, 16)
    }

    /// `opus_encode_float`: 960 samples per channel of interleaved f32 PCM (nominal range
    /// +-1). Returns the packet length or a negative Opus error code.
    pub fn encode_float(&mut self, pcm: &[f32], data: &mut [u8]) -> i32 {
        let n = (FRAME_SIZE * self.channels) as usize;
        if self.channels == 0 || pcm.len() != n {
            return OPUS_BAD_ARG;
        }
        self.encode_native(pcm, FRAME_SIZE, data, MAX_ENCODING_DEPTH)
    }

    fn user_bitrate_to_bitrate(&self, frame_size: i32, max_data_bytes: i32) -> i32 {
        let frame_size = if frame_size == 0 { FS / 400 } else { frame_size };
        let max_bitrate = bits_to_bitrate(max_data_bytes * 8, FS, frame_size);
        let user_bitrate = if self.user_bitrate_bps == OPUS_AUTO {
            60 * FS / frame_size + FS * self.channels
        } else if self.user_bitrate_bps == OPUS_BITRATE_MAX {
            1500000
        } else {
            self.user_bitrate_bps
        };
        IMIN(user_bitrate, max_bitrate)
    }

    /// `opus_encode_native` (float_api is 1 for both entry points in the float build).
    fn encode_native(&mut self, pcm: &[f32], frame_size: i32, data: &mut [u8], lsb_depth: i32) -> i32 {
        let out_data_bytes = data.len().min(i32::MAX as usize) as i32;
        /* Just avoid insane packet sizes here, but the real bounds are applied later on. */
        let max_data_bytes = IMIN(PACKET_SIZE_CAP * 6, out_data_bytes);

        self.rangeFinal = 0;
        if frame_size <= 0 || max_data_bytes <= 0 {
            return OPUS_BAD_ARG;
        }
        /* "Cannot encode 100 ms in 1 byte" does not apply to 20 ms frames. */

        let lsb_depth = IMIN(lsb_depth, self.lsb_depth);

        let is_silence = is_digital_silence(pcm, frame_size, self.channels, lsb_depth);
        /* analysis_info.valid = 0: run_analysis() (complexity >= 7) is not ported, see the
        module comment; tonality_analysis_reset() has no observable effect either. */

        /* Reset voice_ratio if this frame is not silent or if analysis is disabled.
         * Otherwise, preserve voice_ratio from the last non-silent frame */
        if !is_silence {
            self.voice_ratio = -1;
        }
        /* detected_bandwidth = 0 (no analysis). */

        /* Track the peak signal energy (analysis_info.valid == 0) */
        if !is_silence {
            self.peak_signal_energy = MAX32(
                0.999f32 * self.peak_signal_energy,
                compute_frame_energy(pcm, frame_size, self.channels),
            );
        }
        /* compute_stereo_width(): dead, see the module comment. */
        self.bitrate_bps = self.user_bitrate_to_bitrate(frame_size, max_data_bytes);

        let frame_rate = FS / frame_size;
        /* use_vbr: no CBR bytes */
        if max_data_bytes < 3
            || self.bitrate_bps < 3 * frame_rate * 8
            || (frame_rate < 50 && (max_data_bytes * frame_rate < 300 || self.bitrate_bps < 2400))
        {
            /*If the space is too low to do something useful, emit 'PLC' frames.*/
            let mut tocmode = self.mode;
            let mut bw = if self.bandwidth == 0 { OPUS_BANDWIDTH_NARROWBAND } else { self.bandwidth };
            let packet_code = 0;

            if tocmode == 0 {
                tocmode = MODE_SILK_ONLY;
            }
            if frame_rate > 100 {
                tocmode = MODE_CELT_ONLY;
            }
            /* The 40 ms and >= 60 ms cases do not apply (frame_rate == 50). */
            debug_assert!(frame_rate == 50);

            if tocmode == MODE_SILK_ONLY && bw > OPUS_BANDWIDTH_WIDEBAND {
                bw = OPUS_BANDWIDTH_WIDEBAND;
            } else if tocmode == MODE_CELT_ONLY && bw == OPUS_BANDWIDTH_MEDIUMBAND {
                bw = OPUS_BANDWIDTH_NARROWBAND;
            } else if tocmode == MODE_HYBRID && bw <= OPUS_BANDWIDTH_SUPERWIDEBAND {
                bw = OPUS_BANDWIDTH_SUPERWIDEBAND;
            }

            data[0] = gen_toc(tocmode, frame_rate, bw, self.stream_channels);
            data[0] |= packet_code as u8;

            let ret = if packet_code <= 1 { 1 } else { 2 };
            /* use_vbr: no padding */
            return ret;
        }
        /* max_rate only caps the bandwidth for hybrid. */

        /* Equivalent 20-ms rate for mode/channel/bandwidth decisions */
        let mut equiv_rate = compute_equiv_rate(
            self.bitrate_bps,
            self.channels,
            FS / frame_size,
            1,
            0,
            self.silk_mode.complexity,
            self.silk_mode.packetLossPercentage,
        );

        let voice_est: i32; /* Probability of voice in Q7 */
        if self.signal_type == OPUS_SIGNAL_VOICE {
            voice_est = 127;
        } else if self.signal_type == OPUS_SIGNAL_MUSIC {
            voice_est = 0;
        } else if self.voice_ratio >= 0 {
            /* Unreachable: voice_ratio is only set by the analysis or OPUS_SET_VOICE_RATIO.
            The OPUS_APPLICATION_AUDIO cap does not apply to RESTRICTED_CELT. */
            voice_est = self.voice_ratio * 327 >> 8;
        } else {
            /* not OPUS_APPLICATION_VOIP */
            voice_est = 48;
        }

        if self.force_channels != OPUS_AUTO && self.channels == 2 {
            self.stream_channels = self.force_channels;
        } else {
            /* Rate-dependent mono-stereo decision */
            if self.channels == 2 {
                let mut stereo_threshold = stereo_music_threshold
                    + ((voice_est * voice_est * (stereo_voice_threshold - stereo_music_threshold)) >> 14);
                if self.stream_channels == 2 {
                    stereo_threshold -= 1000;
                } else {
                    stereo_threshold += 1000;
                }
                self.stream_channels = if equiv_rate > stereo_threshold { 2 } else { 1 };
            } else {
                self.stream_channels = self.channels;
            }
        }
        /* The equivalent rate update for the channels decision only feeds the mode decision. */

        /* Allow SILK DTX if DTX is enabled but the generalized DTX cannot be used,
        e.g. because of the complexity setting or sample rate. */
        self.silk_mode.useDTX = (self.use_dtx != 0 && !is_silence) as i32;

        /* Mode selection: RESTRICTED_CELT is always CELT-only. Since prev_mode is 0 or
        CELT-only, there is no mode transition (no redundancy, to_celt or prefill), and
        toMono stays 0. */
        self.mode = MODE_CELT_ONLY;
        debug_assert!(self.prev_mode == 0 || self.prev_mode == MODE_CELT_ONLY);

        /* Update equivalent rate with mode decision. */
        equiv_rate = compute_equiv_rate(
            self.bitrate_bps,
            self.stream_channels,
            FS / frame_size,
            1,
            self.mode,
            self.silk_mode.complexity,
            self.silk_mode.packetLossPercentage,
        );

        /* Automatic (rate-dependent) bandwidth selection (always, since mode is CELT-only) */
        {
            let voice_bandwidth_thresholds: &[i32; 8];
            let music_bandwidth_thresholds: &[i32; 8];
            let mut bandwidth_thresholds = [0i32; 8];
            let mut bandwidth = OPUS_BANDWIDTH_FULLBAND;

            if self.channels == 2 && self.force_channels != 1 {
                voice_bandwidth_thresholds = &stereo_voice_bandwidth_thresholds;
                music_bandwidth_thresholds = &stereo_music_bandwidth_thresholds;
            } else {
                voice_bandwidth_thresholds = &mono_voice_bandwidth_thresholds;
                music_bandwidth_thresholds = &mono_music_bandwidth_thresholds;
            }
            /* Interpolate bandwidth thresholds depending on voice estimation */
            for i in 0..8 {
                bandwidth_thresholds[i] = music_bandwidth_thresholds[i]
                    + ((voice_est * voice_est * (voice_bandwidth_thresholds[i] - music_bandwidth_thresholds[i])) >> 14);
            }
            loop {
                let mut threshold = bandwidth_thresholds[(2 * (bandwidth - OPUS_BANDWIDTH_MEDIUMBAND)) as usize];
                let hysteresis = bandwidth_thresholds[(2 * (bandwidth - OPUS_BANDWIDTH_MEDIUMBAND) + 1) as usize];
                if self.first == 0 {
                    if self.auto_bandwidth >= bandwidth {
                        threshold -= hysteresis;
                    } else {
                        threshold += hysteresis;
                    }
                }
                if equiv_rate >= threshold {
                    break;
                }
                bandwidth -= 1;
                if bandwidth <= OPUS_BANDWIDTH_NARROWBAND {
                    break;
                }
            }
            /* We don't use mediumband anymore, except when explicitly requested or during
            mode transitions. */
            if bandwidth == OPUS_BANDWIDTH_MEDIUMBAND {
                bandwidth = OPUS_BANDWIDTH_WIDEBAND;
            }
            self.auto_bandwidth = bandwidth;
            self.bandwidth = bandwidth;
            /* The SWB/FB restriction for SILK applies to non-CELT modes only. */
        }

        if self.bandwidth > self.max_bandwidth {
            self.bandwidth = self.max_bandwidth;
        }

        if self.user_bandwidth != OPUS_AUTO {
            self.bandwidth = self.user_bandwidth;
        }

        /* The hybrid max_rate cap, the Nyquist caps (Fs <= 24000), the detected bandwidth
        (no analysis) and decide_fec() (0 for CELT-only) do not apply. */
        celt_encoder_set_lsb_depth(&mut self.celt_enc, lsb_depth);

        /* CELT mode doesn't support mediumband, use wideband instead */
        if self.mode == MODE_CELT_ONLY && self.bandwidth == OPUS_BANDWIDTH_MEDIUMBAND {
            self.bandwidth = OPUS_BANDWIDTH_WIDEBAND;
        }
        /* lfe == 0; CELT-only never switches to SILK/hybrid here. */

        /* Can't support higher than >60 ms frames, and >20 ms when in Hybrid or CELT-only
        modes: frame_size == Fs/50, so no multi-frame packet. */
        debug_assert!(frame_size <= FS / 50);
        self.encode_frame_native(pcm, frame_size, data, max_data_bytes, is_silence, equiv_rate)
    }

    /// `opus_encode_frame_native` for CELT-only (redundancy, celt_to_silk, prefill and to_celt
    /// are all 0).
    fn encode_frame_native(
        &mut self,
        pcm: &[f32],
        frame_size: i32,
        data: &mut [u8],
        orig_max_data_bytes: i32,
        is_silence: bool,
        equiv_rate: i32,
    ) -> i32 {
        let max_data_bytes = IMIN(orig_max_data_bytes, 1276);
        self.rangeFinal = 0;
        let curr_bandwidth = self.bandwidth;
        /* delay_compensation = 0 for RESTRICTED_CELT */
        let total_buffer = 0usize;
        let channels = self.channels as usize;

        let mut activity: i32 = VAD_NO_DECISION;
        if is_silence {
            activity = !is_silence as i32;
        } else if self.mode == MODE_CELT_ONLY {
            /* (analysis_info->valid == 0) */
            let noise_energy = compute_frame_energy(pcm, frame_size, self.channels);
            /* Boosting peak energy a bit because we didn't just average the active frames. */
            activity = (self.peak_signal_energy < (PSEUDO_SNR_THRESHOLD * (0.5f32 * noise_energy))) as i32;
        }

        /* silk_bw_switch == 0; redundancy is off for CELT-only: redundancy_bytes = 0.
        bits_target only feeds SILK. */

        let st = stack::save();

        /* data += 1. The range coder keeps a raw pointer into `data`, so from here on `data`
        is only accessed through `data_ptr` (the TOC byte data[-1] and data[0] of C). */
        debug_assert!(data.len() >= orig_max_data_bytes as usize && orig_max_data_bytes >= 3);
        let data_ptr = data.as_mut_ptr();
        let mut enc: ec_enc = unsafe { core::mem::zeroed() };
        // SAFETY: data.len() >= orig_max_data_bytes >= 3 (the PLC path catches smaller
        // buffers); the coder gets orig_max_data_bytes-1 bytes starting at data[1].
        unsafe { ec_enc_init(&mut enc, data_ptr.add(1), (orig_max_data_bytes - 1) as u32) };

        let pcm_buf = st.alloc::<f32>((total_buffer + frame_size as usize) * channels);
        /* No delay_buffer prefix: total_buffer == 0. The variable HP smoothing only feeds
        the VOIP high-pass. */
        dc_reject(pcm, 3, &mut pcm_buf[total_buffer * channels..], &mut self.hp_mem, frame_size as usize, self.channels, FS);

        /* float_api */
        {
            let n = frame_size * self.channels;
            let sum = celt_inner_prod(&pcm_buf[total_buffer * channels..], &pcm_buf[total_buffer * channels..], n);
            /* This should filter out both NaNs and ridiculous signals that could
            cause NaNs further down. */
            if !(sum < 1e9f32) || celt_isnan(sum) {
                pcm_buf[total_buffer * channels..].fill(0.0);
                self.hp_mem = [0.0; 4];
            }
        }

        /* SILK processing: none (HB_gain = Q15ONE). */

        /* CELT processing */
        {
            let endband = match curr_bandwidth {
                OPUS_BANDWIDTH_NARROWBAND => 13,
                OPUS_BANDWIDTH_MEDIUMBAND | OPUS_BANDWIDTH_WIDEBAND => 17,
                OPUS_BANDWIDTH_SUPERWIDEBAND => 19,
                OPUS_BANDWIDTH_FULLBAND => 21,
                _ => 21,
            };
            celt_encoder_set_end_band(&mut self.celt_enc, endband);
            celt_encoder_set_channels(&mut self.celt_enc, self.stream_channels);
            celt_encoder_set_bitrate(&mut self.celt_enc, OPUS_BITRATE_MAX);
        }
        {
            let mut celt_pred = 2;
            /* We may still decide to disable prediction later */
            if self.silk_mode.reducedDependency != 0 {
                celt_pred = 0;
            }
            celt_encoder_set_prediction(&mut self.celt_enc, celt_pred);
        }

        /* tmp_prefill (needs a mode change), the delay_buffer update (encoder_buffer == 0) and
        gain_fade() (HB_gain == prev_HB_gain == Q15ONE) do nothing here. */

        /* mode != MODE_HYBRID */
        if equiv_rate > 32000 {
            self.silk_mode.stereoWidth_Q14 = 16384;
        } else if equiv_rate < 16000 {
            self.silk_mode.stereoWidth_Q14 = 0;
        } else {
            self.silk_mode.stereoWidth_Q14 = 16384 - 2048 * (32000 - equiv_rate) / (equiv_rate - 14000);
        }
        if self.channels == 2 {
            /* Apply stereo width reduction (at low bitrates) */
            if (self.hybrid_stereo_width_Q14 as i32) < (1 << 14) || self.silk_mode.stereoWidth_Q14 < (1 << 14) {
                let mut g1 = self.hybrid_stereo_width_Q14 as f32;
                let mut g2 = self.silk_mode.stereoWidth_Q14 as f32;
                g1 *= 1.0f32 / 16384.0f32;
                g2 *= 1.0f32 / 16384.0f32;
                let celt_mode = self.celt_enc.mode;
                stereo_fade(pcm_buf, g1, g2, celt_mode.overlap, frame_size, self.channels, celt_mode.window, FS);
                self.hybrid_stereo_width_Q14 = self.silk_mode.stereoWidth_Q14 as i16;
            }
        }

        /* redundancy = 0 for CELT-only */
        let start_band = 0;

        let nb_compr_bytes = max_data_bytes - 1; /* - redundancy_bytes (0) */
        ec_enc_shrink(&mut enc, nb_compr_bytes as u32);

        /* CELT_SET_ANALYSIS: analysis_info.valid == 0 and the CELT copy is zeroed. */
        debug_assert!(self.celt_enc.analysis.valid == 0);

        celt_encoder_set_start_band(&mut self.celt_enc, start_band);

        // SAFETY (data_ptr accesses below): data_ptr[0..2] lies within `data`.
        unsafe { *data_ptr = 0 };
        let mut ret: i32 = 0;
        {
            celt_encoder_set_vbr(&mut self.celt_enc, 1); /* OPUS_SET_VBR(st->use_vbr) */
            /* CELT-only, use_vbr */
            celt_encoder_set_vbr(&mut self.celt_enc, 1);
            celt_encoder_set_vbr_constraint(&mut self.celt_enc, self.vbr_constraint);
            celt_encoder_set_bitrate(&mut self.celt_enc, self.bitrate_bps);

            /* If false, we already busted the budget and we'll end up with a "PLC frame" */
            if ec_tell(&enc) <= 8 * nb_compr_bytes {
                ret = celt_encode_with_ec(
                    &mut self.celt_enc,
                    pcm_buf,
                    frame_size,
                    core::ptr::null_mut(),
                    nb_compr_bytes,
                    Some(&mut enc),
                );
                if ret < 0 {
                    return OPUS_INTERNAL_ERROR;
                }
            }
            self.rangeFinal = celt_encoder_get_final_range(&self.celt_enc);
        }

        /* Signalling the mode in the first byte */
        unsafe { *data_ptr |= gen_toc(self.mode, FS / frame_size, curr_bandwidth, self.stream_channels) };

        /* rangeFinal ^= redundant_rng (0) */
        self.prev_mode = self.mode;

        self.first = 0;

        /* DTX decision */
        if self.use_dtx != 0 && self.silk_mode.useDTX == 0 {
            /* silk_mode.useDTX = use_dtx && !is_silence, so this is only reached for digital
            silence (activity == 0). */
            debug_assert!(is_silence && activity == 0);
            if decide_dtx_mode(activity, &mut self.nb_no_activity_ms_Q1, 2 * 1000 * frame_size / FS) != 0 {
                self.rangeFinal = 0;
                unsafe { *data_ptr = gen_toc(self.mode, FS / frame_size, curr_bandwidth, self.stream_channels) };
                return 1;
            }
        } else {
            self.nb_no_activity_ms_Q1 = 0;
        }

        /* In the unlikely case that the SILK encoder busted its target, tell
        the decoder to call the PLC */
        if ec_tell(&enc) > (max_data_bytes - 1) * 8 {
            if max_data_bytes < 2 {
                return OPUS_BUFFER_TOO_SMALL;
            }
            unsafe { *data_ptr.add(1) = 0 };
            ret = 1;
            self.rangeFinal = 0;
        }
        /* The trailing-zero stripping is SILK-only. */
        /* Count ToC and redundancy */
        ret += 1;
        /* use_vbr: no padding */
        ret
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{Rng, c_mode, music};
    use minicelt_oracle as c;
    use std::vec::Vec;

    fn bits(v: &[f32]) -> Vec<u32> {
        v.iter().map(|x| x.to_bits()).collect()
    }

    #[test]
    fn gen_toc_matches_c() {
        let cases: [(i32, &[i32], &[i32]); 3] = [
            (MODE_SILK_ONLY, &[10, 25, 50, 100], &[1101, 1102, 1103]),
            (MODE_HYBRID, &[50, 100], &[1104, 1105]),
            (MODE_CELT_ONLY, &[50, 100, 200, 400], &[1101, 1102, 1103, 1104, 1105]),
        ];
        for (mode, rates, bws) in cases {
            for &fr in rates {
                for &bw in bws {
                    for ch in 1..=2 {
                        assert_eq!(gen_toc(mode, fr, bw, ch), unsafe { c::oracle_gen_toc(mode, fr, bw, ch) }, "{mode} {fr} {bw} {ch}");
                    }
                }
            }
        }
    }

    #[test]
    fn dc_reject_matches_c() {
        let mut rng = Rng::new(11);
        for ch in 1..=2usize {
            let (mut mr, mut mc) = ([0f32; 4], [0f32; 4]);
            let frames = music(3, 20, 960, ch);
            for (k, f) in frames.iter().enumerate() {
                let mut x = f.clone();
                if k % 5 == 4 {
                    x = rng.f32_vec(960 * ch, 2.0);
                }
                let (mut or, mut oc) = (std::vec![0f32; 960 * ch], std::vec![0f32; 960 * ch]);
                dc_reject(&x, 3, &mut or, &mut mr, 960, ch as i32, FS);
                unsafe { c::oracle_dc_reject(x.as_ptr(), 3, oc.as_mut_ptr(), mc.as_mut_ptr(), 960, ch as i32, FS) };
                assert_eq!(bits(&or), bits(&oc), "ch={ch} k={k}");
                assert_eq!(bits(&mr), bits(&mc), "hp_mem ch={ch} k={k}");
            }
        }
    }

    #[test]
    fn stereo_fade_matches_c() {
        let mut rng = Rng::new(5);
        let mi = c::mode_info(c_mode());
        let window = unsafe { core::slice::from_raw_parts(mi.window, mi.overlap as usize) };
        for iter in 0..200 {
            let x = rng.f32_vec(960 * 2, 1.0);
            let q = |r: &mut Rng| (r.range(0, 16384) as f32) * (1.0f32 / 16384.0f32);
            let (g1, g2) = if iter % 4 == 0 { (1.0, q(&mut rng)) } else { (q(&mut rng), q(&mut rng)) };
            let (mut br, mut bc) = (x.clone(), x.clone());
            stereo_fade(&mut br, g1, g2, 120, 960, 2, window, FS);
            unsafe { c::oracle_stereo_fade(bc.as_ptr(), bc.as_mut_ptr(), g1, g2, 120, 960, 2, window.as_ptr(), FS) };
            assert_eq!(bits(&br), bits(&bc), "g1={g1} g2={g2}");
        }
    }

    #[test]
    fn user_bitrate_to_bitrate_matches_c() {
        for ch in 1..=2 {
            let mut r = OpusEncoder::new_zeroed();
            assert_eq!(r.init(ch), OPUS_OK);
            let mut e = c::RefEncoder::new(ch as usize);
            for b in [OPUS_AUTO, OPUS_BITRATE_MAX, 501, 6000, 32000, 128000, 510000, 1500000] {
                assert_eq!(r.set_bitrate(b), OPUS_OK);
                e.set_bitrate(b);
                for fs in [0, 960] {
                    for mdb in [1, 3, 20, 100, 1276, 1276 * 6] {
                        let c = unsafe { c::oracle_user_bitrate_to_bitrate(e.as_ptr(), fs, mdb) };
                        assert_eq!(r.user_bitrate_to_bitrate(fs, mdb), c, "ch={ch} b={b} fs={fs} mdb={mdb}");
                    }
                }
            }
        }
    }

    #[test]
    fn compute_equiv_rate_matches_c() {
        let mut rng = Rng::new(9);
        for _ in 0..20000 {
            let bitrate = rng.range(500, 3_062_400);
            let ch = rng.range(1, 2);
            let fr = [50, 100, 200, 400, 25][rng.range(0, 4) as usize];
            let vbr = rng.range(0, 1);
            let mode = [0, MODE_SILK_ONLY, MODE_HYBRID, MODE_CELT_ONLY][rng.range(0, 3) as usize];
            let cx = rng.range(0, 10);
            let loss = rng.range(0, 100);
            assert_eq!(compute_equiv_rate(bitrate, ch, fr, vbr, mode, cx, loss), unsafe {
                c::oracle_compute_equiv_rate(bitrate, ch, fr, vbr, mode, cx, loss)
            });
        }
    }

    #[test]
    fn compute_frame_energy_matches_c() {
        let mut rng = Rng::new(13);
        for ch in 1..=2 {
            for (k, f) in music(4, 10, 960, ch as usize).iter().enumerate() {
                let x = if k % 3 == 2 { rng.f32_vec(960 * ch as usize, 1.5) } else { f.clone() };
                let a = compute_frame_energy(&x, 960, ch);
                let b = unsafe { c::oracle_compute_frame_energy(x.as_ptr(), 960, ch, 0) };
                assert_eq!(a.to_bits(), b.to_bits(), "ch={ch} k={k}");
            }
        }
    }

    #[test]
    fn decide_dtx_mode_matches_c() {
        let mut rng = Rng::new(17);
        let (mut nr, mut nc) = (0i32, 0i32);
        for i in 0..20000 {
            let act = if (i / 50) % 2 == 0 { 0 } else { (rng.range(0, 9) == 0) as i32 };
            let fms = [5, 10, 20, 40, 120][rng.range(0, 4) as usize] * 2;
            let a = decide_dtx_mode(act, &mut nr, fms);
            let b = unsafe { c::oracle_decide_dtx_mode(act, &mut nc, fms) };
            assert_eq!((a, nr), (b, nc), "i={i}");
        }
    }

    #[test]
    fn is_digital_silence_matches_c() {
        let mut rng = Rng::new(19);
        for i in 0..4000 {
            let lsb = rng.range(8, 24);
            let ch = rng.range(1, 2);
            let thr = 1.0f32 / (1i32 << lsb) as f32;
            let scale = [0.0, thr * 0.5, thr, thr * 1.0001, thr * 2.0, 1.0][(i % 6) as usize];
            let mut x = rng.f32_vec(960 * ch as usize, scale);
            if i % 7 == 0 {
                let j = rng.range(0, 960 * ch - 1) as usize;
                x[j] = if i % 2 == 0 { thr } else { -thr };
            }
            let a = is_digital_silence(&x, 960, ch, lsb) as i32;
            let b = unsafe { c::is_digital_silence(x.as_ptr(), 960, ch, lsb) };
            assert_eq!(a, b, "i={i} lsb={lsb}");
        }
    }
}
