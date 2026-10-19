//! Port of src/opus_encoder.c for `OPUS_APPLICATION_RESTRICTED_SILK`, specialised to
//! 16 kHz mono, wideband, 20 ms frames, VBR, DTX supported.
//!
//! What C executes in this configuration is ported as is; the rest is removed:
//! - no CELT/hybrid/redundancy/repacketizer/padding (CBR), no multi-frame packets, no FEC
//!   (`useInBandFEC == 0`, so `decide_fec` always yields `LBRR_coded = 0`);
//! - no analysis (`run_analysis` is never used for RESTRICTED_SILK) and no
//!   mode/bandwidth/channel decisions: they always give SILK-only, WB, mono. Their state
//!   (`peak_signal_energy`, `equiv_rate`, `auto_bandwidth`, `stereoWidth_Q14`, the
//!   `delay_buffer`, `variable_HP_smth2_Q15`, which only feeds the VOIP high-pass) cannot
//!   influence the output and is omitted;
//! - the bandwidth is fixed to WB as with `OPUS_SET_BANDWIDTH(OPUS_BANDWIDTH_WIDEBAND)`.
//!
//! Deviation from C: when `effective_max_rate < 8000` (an output buffer under 20 bytes)
//! C lowers SILK's maximum internal rate to 12/8 kHz, which minisilk cannot do. Such
//! buffers are rejected with `OPUS_BUFFER_TOO_SMALL`. Buffers under 3 bytes still yield
//! the one byte "PLC" (TOC only) packet as in C, since that path does not involve SILK.
//!
//! `OpusEncoder` is statically sizable (`new_zeroed` is `const`, no allocation); call
//! `init` before use.

use crate::celt::entcode::{ec_enc, ec_tell};
use crate::celt::entenc::{ec_enc_done, ec_enc_init};
use crate::celt::pitch::celt_inner_prod;
use crate::opus::defines::*;
use crate::silk::define::{MAX_CONSECUTIVE_DTX, NB_SPEECH_FRAMES_BEFORE_DTX, VAD_NO_DECISION};
use crate::silk::enc_API::{silk_Encode, silk_InitEncoder};
use crate::silk::float::structs_flp::silk_encoder;
use crate::silk::structs::silk_EncControlStruct;

/* Fixed configuration. */
const FS: i32 = 16000;
const FRAME_SIZE: i32 = 320;
const FRAME_RATE: i32 = FS / FRAME_SIZE;
/// `st->Fs/400 + st->delay_compensation` with `delay_compensation = Fs/250`.
const LOOKAHEAD: i32 = FS / 400 + FS / 250;
const PACKET_SIZE_CAP: i32 = 1276;

pub struct OpusEncoder {
    silk_enc: silk_encoder,
    silk_mode: silk_EncControlStruct,
    use_dtx: i32,
    user_bitrate_bps: i32,
    bitrate_bps: i32,
    hp_mem: [f32; 4],
    mode: i32,
    prev_mode: i32,
    bandwidth: i32,
    first: i32,
    nb_no_activity_ms_Q1: i32,
    rangeFinal: u32,
}

#[inline]
fn bits_to_bitrate(bits: i32, Fs: i32, frame_size: i32) -> i32 {
    bits * (6 * Fs / frame_size) / 6
}

#[inline]
fn bitrate_to_bits(bitrate: i32, Fs: i32, frame_size: i32) -> i32 {
    bitrate * 6 / (6 * Fs / frame_size)
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

/// Float `dc_reject` (mono). `hp_mem[0]` is the filter state.
fn dc_reject(input: &[f32], cutoff_Hz: i32, out: &mut [f32], hp_mem: &mut [f32; 4], len: usize, Fs: i32) {
    const VERY_SMALL: f32 = 1e-30;
    let coef: f32 = 6.3f32 * cutoff_Hz as f32 / Fs as f32;
    let coef2: f32 = 1.0 - coef;
    let mut m0 = hp_mem[0];
    for i in 0..len {
        let x = input[i];
        let y = x - m0;
        m0 = coef * x + VERY_SMALL + coef2 * m0;
        out[i] = y;
    }
    hp_mem[0] = m0;
}

/// `celt_maxabs16` for floats, including its NaN behaviour (MAX16/MIN16 are `?:` macros).
fn celt_maxabs_res(x: &[f32]) -> f32 {
    let mut maxval = 0.0f32;
    let mut minval = 0.0f32;
    for &v in x {
        maxval = if maxval > v { maxval } else { v };
        minval = if minval < v { minval } else { v };
    }
    if maxval > -minval { maxval } else { -minval }
}

fn is_digital_silence(pcm: &[f32], lsb_depth: i32) -> bool {
    let sample_max = celt_maxabs_res(pcm);
    sample_max <= 1.0f32 / (1i32 << lsb_depth) as f32
}

/// Decides if DTX should be turned on (=1) or off (=0).
fn decide_dtx_mode(activity: i32, nb_no_activity_ms_Q1: &mut i32, frame_size_ms_Q1: i32) -> i32 {
    if activity == 0 {
        /* The number of consecutive DTX frames should be within the allowed bounds.
        The allowed bound is defined in the SILK headers and assumes 20 ms frames. */
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
    /// All-zero state, usable in a `static`. Call `init` before encoding.
    pub const fn new_zeroed() -> Self {
        // SAFETY: every field is an integer, float or array of those; zero is valid.
        unsafe { core::mem::zeroed() }
    }

    /// `opus_encoder_init(st, 16000, 1, OPUS_APPLICATION_RESTRICTED_SILK)` followed by
    /// `OPUS_SET_BANDWIDTH(WB)`. Defaults as in C: bitrate `OPUS_AUTO`, complexity 9, DTX off.
    pub fn init(&mut self) -> i32 {
        // SAFETY: see `new_zeroed`.
        unsafe { core::ptr::write_bytes(self as *mut Self, 0, 1) };
        if silk_InitEncoder(&mut self.silk_enc, &mut self.silk_mode) != 0 {
            return OPUS_INTERNAL_ERROR;
        }
        /* default SILK parameters */
        let m = &mut self.silk_mode;
        m.nChannelsAPI = 1;
        m.nChannelsInternal = 1;
        m.API_sampleRate = FS;
        m.maxInternalSampleRate = 16000;
        m.minInternalSampleRate = 8000;
        m.desiredInternalSampleRate = 16000;
        m.payloadSize_ms = 20;
        m.bitRate = 25000;
        m.packetLossPercentage = 0;
        m.complexity = 9;
        m.useInBandFEC = 0;
        m.useDRED = 0;
        m.useDTX = 0;
        m.useCBR = 0;
        m.reducedDependency = 0;

        self.user_bitrate_bps = OPUS_AUTO;
        self.bitrate_bps = 3000 + FS;
        self.mode = MODE_HYBRID;
        self.bandwidth = OPUS_BANDWIDTH_FULLBAND;
        self.first = 1;
        OPUS_OK
    }

    /// `OPUS_SET_BITRATE`: `OPUS_AUTO`, `OPUS_BITRATE_MAX` or a rate in bits/s (clamped to
    /// 500..=750000).
    pub fn set_bitrate(&mut self, value: i32) -> i32 {
        let mut value = value;
        if value != OPUS_AUTO && value != OPUS_BITRATE_MAX {
            if value <= 0 {
                return OPUS_BAD_ARG;
            } else if value <= 500 {
                value = 500;
            } else if value > 750000 {
                value = 750000;
            }
        }
        self.user_bitrate_bps = value;
        OPUS_OK
    }

    /// `OPUS_SET_COMPLEXITY` (0..=10).
    pub fn set_complexity(&mut self, value: i32) -> i32 {
        if !(0..=10).contains(&value) {
            return OPUS_BAD_ARG;
        }
        self.silk_mode.complexity = value;
        OPUS_OK
    }

    /// `OPUS_SET_DTX` (0 or 1).
    pub fn set_dtx(&mut self, value: i32) -> i32 {
        if !(0..=1).contains(&value) {
            return OPUS_BAD_ARG;
        }
        self.use_dtx = value;
        OPUS_OK
    }

    /// `OPUS_SET_PACKET_LOSS_PERC` (0..=100).
    pub fn set_packet_loss_perc(&mut self, value: i32) -> i32 {
        if !(0..=100).contains(&value) {
            return OPUS_BAD_ARG;
        }
        self.silk_mode.packetLossPercentage = value;
        OPUS_OK
    }

    /// `OPUS_GET_LOOKAHEAD` (samples at 16 kHz).
    pub fn get_lookahead(&self) -> i32 {
        LOOKAHEAD
    }

    /// `OPUS_GET_FINAL_RANGE`: range coder state after the last `encode*` call.
    pub fn get_final_range(&self) -> u32 {
        self.rangeFinal
    }

    /// `OPUS_GET_IN_DTX`.
    pub fn get_in_dtx(&self) -> i32 {
        if self.silk_mode.useDTX != 0 && (self.prev_mode == MODE_SILK_ONLY || self.prev_mode == MODE_HYBRID) {
            /* DTX determined by Silk. */
            (self.silk_enc.state_Fxx[0].sCmn.noSpeechCounter >= NB_SPEECH_FRAMES_BEFORE_DTX) as i32
        } else if self.use_dtx != 0 {
            /* DTX determined by Opus. */
            (self.nb_no_activity_ms_Q1 >= NB_SPEECH_FRAMES_BEFORE_DTX * 20 * 2) as i32
        } else {
            0
        }
    }

    /// `opus_encode`: 320 samples of 16 kHz mono i16 PCM. Returns the packet length or a
    /// negative Opus error code.
    pub fn encode(&mut self, pcm: &[i16], out: &mut [u8]) -> i32 {
        if pcm.len() != FRAME_SIZE as usize {
            return OPUS_BAD_ARG;
        }
        let mut input = [0f32; FRAME_SIZE as usize];
        for i in 0..FRAME_SIZE as usize {
            /* INT16TORES */
            input[i] = pcm[i] as f32 * (1.0f32 / 32768.0f32);
        }
        self.encode_native(&input, out, 16)
    }

    /// `opus_encode_float`: 320 samples of 16 kHz mono f32 PCM (nominal range +-1).
    pub fn encode_float(&mut self, pcm: &[f32], out: &mut [u8]) -> i32 {
        if pcm.len() != FRAME_SIZE as usize {
            return OPUS_BAD_ARG;
        }
        self.encode_native(pcm, out, 24)
    }

    /// `opus_encode_native`, up to the frame encoder.
    fn encode_native(&mut self, pcm: &[f32], out: &mut [u8], lsb_depth: i32) -> i32 {
        let frame_size = FRAME_SIZE;
        /* Just avoid insane packet sizes here, but the real bounds are applied later on. */
        let max_data_bytes = (PACKET_SIZE_CAP * 6).min(out.len().min(i32::MAX as usize) as i32);

        self.rangeFinal = 0;
        if max_data_bytes <= 0 {
            return OPUS_BAD_ARG;
        }

        let lsb_depth = lsb_depth.min(24);
        let is_silence = is_digital_silence(pcm, lsb_depth);

        self.bitrate_bps = self.user_bitrate_to_bitrate(frame_size, max_data_bytes);

        let frame_rate = FRAME_RATE;
        if max_data_bytes < 3 || self.bitrate_bps < 3 * frame_rate * 8 {
            /* If the space is too low to do something useful, emit 'PLC' frames. */
            let mut tocmode = self.mode;
            let mut bw = if self.bandwidth == 0 { OPUS_BANDWIDTH_NARROWBAND } else { self.bandwidth };
            if tocmode == 0 {
                tocmode = MODE_SILK_ONLY;
            }
            if tocmode == MODE_SILK_ONLY && bw > OPUS_BANDWIDTH_WIDEBAND {
                bw = OPUS_BANDWIDTH_WIDEBAND;
            } else if tocmode == MODE_HYBRID && bw <= OPUS_BANDWIDTH_SUPERWIDEBAND {
                bw = OPUS_BANDWIDTH_SUPERWIDEBAND;
            }
            out[0] = gen_toc(tocmode, frame_rate, bw, 1);
            return 1;
        }

        /* Allow SILK DTX if DTX is enabled but the generalized DTX cannot be used,
        i.e. when the frame is not digital silence. */
        self.silk_mode.useDTX = (self.use_dtx != 0 && !is_silence) as i32;

        /* Mode selection: RESTRICTED_SILK is always SILK-only, mono, WB (user bandwidth). */
        self.mode = MODE_SILK_ONLY;
        self.bandwidth = OPUS_BANDWIDTH_WIDEBAND;
        self.silk_mode.LBRR_coded = 0; /* decide_fec with useInBandFEC == 0 */
        self.silk_mode.toMono = 0;

        self.encode_frame_native(pcm, out, max_data_bytes, is_silence)
    }

    fn user_bitrate_to_bitrate(&self, frame_size: i32, max_data_bytes: i32) -> i32 {
        let max_bitrate = bits_to_bitrate(max_data_bytes * 8, FS, frame_size);
        let user_bitrate = if self.user_bitrate_bps == OPUS_AUTO {
            60 * FS / frame_size + FS
        } else if self.user_bitrate_bps == OPUS_BITRATE_MAX {
            1500000
        } else {
            self.user_bitrate_bps
        };
        user_bitrate.min(max_bitrate)
    }

    /// `opus_encode_frame_native`.
    fn encode_frame_native(&mut self, pcm: &[f32], out: &mut [u8], orig_max_data_bytes: i32, is_silence: bool) -> i32 {
        let frame_size = FRAME_SIZE;
        let max_data_bytes = orig_max_data_bytes.min(PACKET_SIZE_CAP);
        self.rangeFinal = 0;
        let mut curr_bandwidth = self.bandwidth;

        let mut activity = VAD_NO_DECISION;
        if is_silence {
            activity = 0;
        }

        let effective_max_rate = bits_to_bitrate(max_data_bytes * 8, FS, frame_size);
        if effective_max_rate < 8000 {
            /* C would lower SILK's max internal rate to 12/8 kHz here; unsupported. */
            return OPUS_BUFFER_TOO_SMALL;
        }

        let bits_target = (8 * max_data_bytes).min(bitrate_to_bits(self.bitrate_bps, FS, frame_size)) - 8;

        /* DC reject (not the VOIP high-pass); delay_compensation is 0 for RESTRICTED_SILK. */
        let mut pcm_buf = [0f32; FRAME_SIZE as usize];
        dc_reject(pcm, 3, &mut pcm_buf, &mut self.hp_mem, FRAME_SIZE as usize, FS);

        /* This should filter out both NaNs and ridiculous signals that could
        cause NaNs further down. */
        let sum = celt_inner_prod(&pcm_buf, &pcm_buf, FRAME_SIZE);
        if !(sum < 1e9f32) || sum.is_nan() {
            pcm_buf = [0f32; FRAME_SIZE as usize];
            self.hp_mem = [0.0; 4];
        }

        /* SILK processing: SILK gets all bits. */
        self.silk_mode.bitRate = bits_to_bitrate(bits_target, FS, frame_size);
        self.silk_mode.payloadSize_ms = 1000 * frame_size / FS;
        self.silk_mode.nChannelsAPI = 1;
        self.silk_mode.nChannelsInternal = 1;
        self.silk_mode.desiredInternalSampleRate = 16000;
        self.silk_mode.minInternalSampleRate = 8000;
        self.silk_mode.maxInternalSampleRate = 16000;
        self.silk_mode.useCBR = 0;

        /* Max bits for SILK, counting the ToC. */
        self.silk_mode.maxBits = (max_data_bytes - 1) * 8;

        /* Call SILK encoder. The range coder writes after the ToC byte. */
        let mut enc: ec_enc = unsafe { core::mem::zeroed() };
        // SAFETY: out.len() >= orig_max_data_bytes >= 3; the coder gets
        // orig_max_data_bytes - 1 bytes starting at out[1].
        unsafe { ec_enc_init(&mut enc, out.as_mut_ptr().add(1), (orig_max_data_bytes - 1) as u32) };
        let mut nBytes: i32 = 0;
        let ret = silk_Encode(&mut self.silk_enc, &mut self.silk_mode, &pcm_buf, frame_size, &mut enc, &mut nBytes, 0, activity);
        if ret != 0 {
            return OPUS_INTERNAL_ERROR;
        }

        /* Extract SILK internal bandwidth for signaling in first byte */
        if self.silk_mode.internalSampleRate == 8000 {
            curr_bandwidth = OPUS_BANDWIDTH_NARROWBAND;
        } else if self.silk_mode.internalSampleRate == 12000 {
            curr_bandwidth = OPUS_BANDWIDTH_MEDIUMBAND;
        } else if self.silk_mode.internalSampleRate == 16000 {
            curr_bandwidth = OPUS_BANDWIDTH_WIDEBAND;
        }

        /* nonfinal_frame is always 0 */
        self.silk_mode.opusCanSwitch = self.silk_mode.switchReady;

        if activity == VAD_NO_DECISION {
            activity = (self.silk_mode.signalType != 0) as i32; /* TYPE_NO_VOICE_ACTIVITY */
        }
        if nBytes == 0 {
            self.rangeFinal = 0;
            out[0] = gen_toc(self.mode, FRAME_RATE, curr_bandwidth, 1);
            return 1;
        }
        /* opusCanSwitch would set silk_bw_switch, which is reset again since redundancy is
        always off for RESTRICTED_SILK. */

        /* SILK-only: the redundancy flag is inferred from the length (no redundancy). */
        let mut ret = (ec_tell(&enc) + 7) >> 3;
        ec_enc_done(&mut enc);
        self.rangeFinal = enc.rng;

        /* Signalling the mode in the first byte */
        out[0] = gen_toc(self.mode, FRAME_RATE, curr_bandwidth, 1);

        self.prev_mode = self.mode;
        self.first = 0;

        /* DTX decision */
        if self.use_dtx != 0 && self.silk_mode.useDTX == 0 {
            if decide_dtx_mode(activity, &mut self.nb_no_activity_ms_Q1, 2 * 1000 * frame_size / FS) != 0 {
                self.rangeFinal = 0;
                out[0] = gen_toc(self.mode, FRAME_RATE, curr_bandwidth, 1);
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
            out[1] = 0;
            ret = 1;
            self.rangeFinal = 0;
        } else {
            /* When in LPC only mode it's perfectly reasonable to strip off trailing zero
            bytes as the required range decoder behavior is to fill these in. */
            while ret > 2 && out[ret as usize] == 0 {
                ret -= 1;
            }
        }
        /* Count ToC */
        ret + 1
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use crate::testutil::{Rng, SpeechGen, zeroed_box};
    use oracle::{RefDecoder, RefEncoder};
    use std::boxed::Box;
    use std::vec;
    use std::vec::Vec;

    fn new_rust() -> Box<OpusEncoder> {
        let mut e = zeroed_box::<OpusEncoder>();
        assert_eq!(e.init(), OPUS_OK);
        e
    }

    /// Frame source: speech, digital silence, near-silence (+-2 LSB noise) and noise
    /// segments, so that both the generalized (digital silence) and SILK DTX trigger.
    fn scenario(n: usize, seed: u64, gain: f64) -> Vec<[i16; 320]> {
        let mut sp = SpeechGen::new(seed);
        sp.gain = gain;
        let mut rng = Rng::new(seed ^ 0xabcdef);
        let mut v = Vec::new();
        let mut seg = 0;
        while v.len() < n {
            let (kind, len) = match seg % 6 {
                0 => (0, 30),
                1 => (1, 40),
                2 => (0, 20),
                3 => (2, 40),
                4 => (3, 15),
                _ => (0, 15),
            };
            for _ in 0..len {
                let f: [i16; 320] = match kind {
                    0 => sp.frame_i16(),
                    1 => [0; 320],
                    2 => core::array::from_fn(|_| rng.range(-2, 2) as i16),
                    _ => core::array::from_fn(|_| (rng.f32_unit() * 2000.0 * gain as f32) as i16),
                };
                v.push(f);
            }
            seg += 1;
        }
        v.truncate(n);
        v
    }

    #[derive(Default, Debug)]
    struct Stats {
        frames: usize,
        dtx: usize,
        bytes: usize,
        in_dtx: usize,
    }

    /// Encodes `frames` with both encoders (`float` selects the API), asserting identical
    /// results, and decodes the Rust packets. `hook(i, rust, c)` runs before frame `i`.
    fn compare_with(
        rs: &mut OpusEncoder,
        c: &mut RefEncoder,
        frames: &[[i16; 320]],
        float: bool,
        mut hook: impl FnMut(usize, &mut OpusEncoder, &mut RefEncoder),
    ) -> Stats {
        let mut dec = RefDecoder::new();
        let mut st = Stats::default();
        for (i, f) in frames.iter().enumerate() {
            hook(i, rs, c);
            let mut ra = [0u8; 1275];
            let mut ca = [0u8; 1275];
            let (rr, cr) = if float {
                let x: Vec<f32> = f.iter().map(|&s| s as f32 * (1.0 / 32768.0)).collect();
                (rs.encode_float(&x, &mut ra), c.encode_float_any(&x, &mut ca))
            } else {
                (rs.encode(f, &mut ra), c.encode(f, &mut ca))
            };
            assert_eq!(rr, cr, "frame {i} length");
            assert!(rr > 0, "frame {i} error {rr}");
            let n = rr as usize;
            assert_eq!(&ra[..n], &ca[..n], "frame {i} payload");
            assert_eq!(rs.get_final_range(), c.final_range(), "frame {i} final range");
            assert_eq!(rs.get_in_dtx(), c.in_dtx(), "frame {i} in_dtx");
            let mut pcm = [0i16; 320];
            assert_eq!(dec.decode(&ra[..n], &mut pcm), 320, "frame {i} decode");
            st.frames += 1;
            st.bytes += n;
            st.dtx += (n == 1) as usize;
            st.in_dtx += (rs.get_in_dtx() == 1) as usize;
        }
        st
    }

    fn compare(bitrate: i32, complexity: i32, dtx: bool, float: bool, frames: &[[i16; 320]]) -> Stats {
        let mut rs = new_rust();
        assert_eq!(rs.set_bitrate(bitrate), OPUS_OK);
        assert_eq!(rs.set_complexity(complexity), OPUS_OK);
        assert_eq!(rs.set_dtx(dtx as i32), OPUS_OK);
        let mut c = RefEncoder::new(bitrate, complexity, dtx);
        compare_with(&mut rs, &mut c, frames, float, |_, _, _| {})
    }

    #[test]
    fn lookahead_matches_c() {
        let rs = new_rust();
        let c = RefEncoder::new(20000, 10, false);
        assert_eq!(rs.get_lookahead(), c.lookahead());
    }

    #[test]
    fn bitrates() {
        let frames = scenario(200, 1, 1.0);
        let rates = [
            6000, 7000, 8000, 10000, 12000, 16000, 20000, 24000, 32000, 40000, OPUS_AUTO, OPUS_BITRATE_MAX, 500, 1000,
            1199, 1200, 750000,
        ];
        for (i, &r) in rates.iter().enumerate() {
            let cx = (i as i32 * 3) % 11;
            let s = compare(r, cx, false, i % 2 == 1, &frames);
            std::println!("bitrate {r} cx {cx}: {s:?}");
        }
    }

    #[test]
    fn complexities() {
        let frames = scenario(120, 2, 1.0);
        for cx in 0..=10 {
            compare(20000, cx, false, false, &frames);
            compare(12000, cx, true, true, &frames);
        }
    }

    #[test]
    fn dtx() {
        let frames = scenario(300, 3, 1.0);
        for &r in &[8000, 20000, OPUS_AUTO] {
            for &float in &[false, true] {
                let off = compare(r, 9, false, float, &frames);
                let on = compare(r, 9, true, float, &frames);
                std::println!("dtx rate {r} float {float}: off {off:?} on {on:?}");
                assert_eq!(off.dtx, 0);
                assert!(on.dtx > 10, "no DTX packets: {on:?}");
                assert!(on.in_dtx > 0);
                assert!(on.bytes < off.bytes);
            }
        }
    }

    #[test]
    fn signals_and_gains() {
        for (k, &g) in [0.02, 0.2, 1.0, 4.0, 20.0].iter().enumerate() {
            let frames = scenario(150, 10 + k as u64, g);
            compare(24000, 10, true, false, &frames);
            compare(14000, 4, false, true, &frames);
        }
        // white noise (full scale and low level) and digital silence
        let mut rng = Rng::new(77);
        for &bits in &[16u32, 12, 6, 2] {
            let frames: Vec<[i16; 320]> =
                (0..80).map(|_| core::array::from_fn(|_| rng.i32_bits(bits) as i16)).collect();
            compare(20000, 10, false, false, &frames);
            compare(32000, 6, true, true, &frames);
        }
        let silence = vec![[0i16; 320]; 100];
        let s = compare(20000, 10, true, false, &silence);
        assert!(s.dtx > 0);
        compare(20000, 10, false, true, &silence);
    }

    #[test]
    fn float_special_values() {
        // Float-only inputs: out of range, tiny (below the 24-bit silence threshold, and
        // between it and 16-bit), NaN and huge values (the sum >= 1e9 filter).
        let mut sp = SpeechGen::new(5);
        let mut rs = new_rust();
        rs.set_dtx(1);
        let mut c = RefEncoder::new(OPUS_AUTO, 9, true);
        let mut dec = RefDecoder::new();
        let mut rng = Rng::new(9);
        for i in 0..160 {
            let base: Vec<f32> = sp.frame_i16().iter().map(|&s| s as f32 / 32768.0).collect();
            let x: Vec<f32> = match i % 16 {
                3 => base.iter().map(|v| v * 3.0).collect(),
                5 => vec![1e-8; 320],
                6 => vec![3e-8; 320],
                7 => (0..320).map(|_| rng.f32_unit() * 1e-5).collect(),
                9 => base.iter().map(|v| v * 1e4).collect(),
                11 => {
                    let mut b = base.clone();
                    b[100] = f32::NAN;
                    b
                }
                13 => vec![0.0; 320],
                _ => base,
            };
            let mut ra = [0u8; 1275];
            let mut ca = [0u8; 1275];
            let rr = rs.encode_float(&x, &mut ra);
            let cr = c.encode_float_any(&x, &mut ca);
            assert_eq!(rr, cr, "frame {i}");
            let n = rr as usize;
            assert_eq!(&ra[..n], &ca[..n], "frame {i}");
            assert_eq!(rs.get_final_range(), c.final_range(), "frame {i}");
            let mut pcm = [0i16; 320];
            assert_eq!(dec.decode(&ra[..n], &mut pcm), 320);
        }
    }

    #[test]
    fn midstream_changes() {
        let frames = scenario(400, 4, 1.0);
        for &float in &[false, true] {
            let mut rs = new_rust();
            rs.set_bitrate(20000);
            rs.set_complexity(10);
            let mut c = RefEncoder::new(20000, 10, false);
            let mut rng = Rng::new(31);
            compare_with(&mut rs, &mut c, &frames, float, |i, rs, c| {
                if i % 17 != 5 {
                    return;
                }
                let op = rng.range(0, 3);
                match op {
                    0 => {
                        let r = [6000, 9000, 13000, 20000, 30000, 40000, OPUS_AUTO, OPUS_BITRATE_MAX][rng.range(0, 7) as usize];
                        assert_eq!(rs.set_bitrate(r), c.set_bitrate(r));
                    }
                    1 => {
                        let v = rng.range(0, 10);
                        assert_eq!(rs.set_complexity(v), c.set_complexity(v));
                    }
                    2 => {
                        let v = rng.range(0, 1);
                        assert_eq!(rs.set_dtx(v), c.set_dtx(v));
                    }
                    _ => {
                        let v = [0, 10, 25, 100][rng.range(0, 3) as usize];
                        assert_eq!(rs.set_packet_loss_perc(v), c.set_packet_loss_perc(v));
                    }
                }
            });
        }
    }

    #[test]
    fn packet_loss() {
        let frames = scenario(150, 6, 1.0);
        for &loss in &[0, 10] {
            for &float in &[false, true] {
                let mut rs = new_rust();
                rs.set_bitrate(16000);
                rs.set_complexity(9);
                assert_eq!(rs.set_packet_loss_perc(loss), OPUS_OK);
                let mut c = RefEncoder::new(16000, 9, false);
                assert_eq!(c.set_packet_loss_perc(loss), OPUS_OK);
                compare_with(&mut rs, &mut c, &frames, float, |_, _, _| {});
            }
        }
    }

    #[test]
    fn ctl_ranges_match_c() {
        let mut rs = new_rust();
        let mut c = RefEncoder::new(20000, 10, false);
        for &v in &[-5000, -1000, -2, -1, 0, 1, 499, 500, 501, 750000, 750001, i32::MAX] {
            assert_eq!(rs.set_bitrate(v), c.set_bitrate(v), "bitrate {v}");
        }
        for &v in &[-1, 0, 5, 10, 11] {
            assert_eq!(rs.set_complexity(v), c.set_complexity(v));
            assert_eq!(rs.set_packet_loss_perc(v * 10), c.set_packet_loss_perc(v * 10));
            assert_eq!(rs.set_dtx(v), c.set_dtx(v));
        }
        assert_eq!(rs.set_packet_loss_perc(101), c.set_packet_loss_perc(101));
    }

    #[test]
    fn errors_and_buffers() {
        let mut sp = SpeechGen::new(8);
        let f = sp.frame_i16();
        let ff: Vec<f32> = f.iter().map(|&s| s as f32 / 32768.0).collect();
        let mut rs = new_rust();
        let mut c = RefEncoder::new(OPUS_AUTO, 9, false);
        let mut buf = [0u8; 1275];
        // wrong frame sizes (C rejects these too)
        for &n in &[0usize, 1, 100, 159, 319, 321] {
            let big = [0i16; 321];
            let bigf = [0f32; 321];
            assert_eq!(rs.encode(&big[..n], &mut buf), OPUS_BAD_ARG, "{n}");
            assert_eq!(c.encode_any(&big[..n], &mut buf), OPUS_BAD_ARG, "{n}");
            assert_eq!(rs.encode_float(&bigf[..n], &mut buf), OPUS_BAD_ARG, "{n}");
            assert_eq!(c.encode_float_any(&bigf[..n], &mut buf), OPUS_BAD_ARG, "{n}");
        }
        // other multiples of 20 ms are unsupported here
        assert_eq!(rs.encode(&[0i16; 640], &mut buf), OPUS_BAD_ARG);
        // empty output buffer
        assert_eq!(rs.encode(&f, &mut []), OPUS_BAD_ARG);
        assert_eq!(c.encode_any(&f, &mut []), OPUS_BAD_ARG);
        // 1 and 2 byte buffers: TOC-only frame; the very first call has C's initial
        // HYBRID/fullband mode, later calls SILK/WB
        for round in 0..3 {
            for &n in &[1usize, 2] {
                let mut a = [0u8; 2];
                let mut b = [0u8; 2];
                let rr = rs.encode(&f, &mut a[..n]);
                let cr = c.encode_any(&f, &mut b[..n]);
                assert_eq!(rr, cr, "round {round} n {n}");
                assert_eq!(a[0], b[0], "round {round} n {n}");
                assert_eq!(rs.get_final_range(), c.final_range());
            }
            // a normal frame in between
            let mut a = [0u8; 1275];
            let mut b = [0u8; 1275];
            let rr = rs.encode(&f, &mut a);
            let cr = c.encode_any(&f, &mut b);
            assert_eq!(rr, cr);
            assert_eq!(a[..rr as usize], b[..rr as usize]);
        }
        // documented deviation: buffers under 20 bytes (C would drop SILK to 12/8 kHz)
        for n in 3..20usize {
            let mut a = [0u8; 20];
            assert_eq!(rs.encode(&f, &mut a[..n]), OPUS_BUFFER_TOO_SMALL, "{n}");
            assert_eq!(rs.encode_float(&ff, &mut a[..n]), OPUS_BUFFER_TOO_SMALL, "{n}");
        }
        // 20 bytes and up match C, including buffers larger than the 1276 byte cap
        for &n in &[20usize, 21, 40, 100, 1275, 1276, 1277, 2000, 7656, 9000] {
            let mut rs = new_rust();
            let mut c = RefEncoder::new(OPUS_BITRATE_MAX, 10, false);
            rs.set_bitrate(OPUS_BITRATE_MAX);
            let mut sp = SpeechGen::new(n as u64);
            for i in 0..40 {
                let f = sp.frame_i16();
                let mut a = vec![0u8; n];
                let mut b = vec![0u8; n];
                let rr = rs.encode(&f, &mut a);
                let cr = c.encode_any(&f, &mut b);
                assert_eq!(rr, cr, "n {n} frame {i}");
                assert!(rr as usize <= n);
                assert_eq!(a[..rr as usize], b[..rr as usize], "n {n} frame {i}");
                assert_eq!(rs.get_final_range(), c.final_range());
            }
        }
    }
}
