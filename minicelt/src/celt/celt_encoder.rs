//! Port of celt/celt_encoder.c (48 kHz, 20 ms frames, mono/stereo, VBR / constrained VBR).

use super::celt::{AnalysisInfo, COMBFILTER_MAXPERIOD, SILKInfo};
use super::modes::{CELTMode, mode48000_960_120};

/// Maximum channel count; the trailing arrays are sized for it.
pub const MAX_CHANNELS: usize = 2;
/// mode48000_960_120.overlap
pub const OVERLAP: usize = 120;
/// mode48000_960_120.nbEBands
pub const NB_EBANDS: usize = 21;

/// OpusCustomEncoder / CELTEncoder. The C struct ends in variable-size arrays laid out after
/// `in_mem` (each `channels` times its per-channel size); here they are fixed-size fields
/// sized for `MAX_CHANNELS` and indexed with the same per-channel strides as in C.
#[repr(C)]
pub struct CELTEncoder {
    /// Mode used by the encoder
    pub mode: &'static CELTMode,
    pub channels: i32,
    pub stream_channels: i32,

    pub force_intra: i32,
    pub clip: i32,
    pub disable_pf: i32,
    pub complexity: i32,
    pub upsample: i32,
    pub start: i32,
    pub end: i32,

    pub bitrate: i32,
    pub vbr: i32,
    pub signalling: i32,
    /// If zero, VBR can do whatever it likes with the rate
    pub constrained_vbr: i32,
    pub loss_rate: i32,
    pub lsb_depth: i32,
    pub lfe: i32,
    pub disable_inv: i32,
    pub arch: i32,

    /* Everything beyond this point gets cleared on a reset */
    pub rng: u32,
    pub spread_decision: i32,
    pub delayedIntra: f32,
    pub tonal_average: i32,
    pub lastCodedBands: i32,
    pub hf_average: i32,
    pub tapset_decision: i32,

    pub prefilter_period: i32,
    pub prefilter_gain: f32,
    pub prefilter_tapset: i32,
    pub consec_transient: i32,
    pub analysis: AnalysisInfo,
    pub silk_info: SILKInfo,

    pub preemph_memE: [f32; 2],
    pub preemph_memD: [f32; 2],

    /* VBR-related parameters */
    pub vbr_reservoir: i32,
    pub vbr_drift: i32,
    pub vbr_offset: i32,
    pub vbr_count: i32,
    pub overlap_max: f32,
    pub stereo_saving: f32,
    pub intensity: i32,
    /// Always null (OPUS_SET_ENERGY_MASK is only used by the multistream encoder).
    pub energy_mask: *const f32,
    pub spec_avg: f32,

    /// Size = channels*mode->overlap
    pub in_mem: [f32; MAX_CHANNELS * OVERLAP],
    /// Size = channels*COMBFILTER_MAXPERIOD
    pub prefilter_mem: [f32; MAX_CHANNELS * COMBFILTER_MAXPERIOD as usize],
    /// Size = channels*mode->nbEBands
    pub oldBandE: [f32; MAX_CHANNELS * NB_EBANDS],
    /// Size = channels*mode->nbEBands
    pub oldLogE: [f32; MAX_CHANNELS * NB_EBANDS],
    /// Size = channels*mode->nbEBands
    pub oldLogE2: [f32; MAX_CHANNELS * NB_EBANDS],
    /// Size = channels*mode->nbEBands
    pub energyError: [f32; MAX_CHANNELS * NB_EBANDS],
}

impl CELTEncoder {
    /// All-zero state (as after the C memset), with the static mode.
    pub const fn new_zeroed() -> Self {
        CELTEncoder {
            mode: &mode48000_960_120,
            channels: 0,
            stream_channels: 0,
            force_intra: 0,
            clip: 0,
            disable_pf: 0,
            complexity: 0,
            upsample: 0,
            start: 0,
            end: 0,
            bitrate: 0,
            vbr: 0,
            signalling: 0,
            constrained_vbr: 0,
            loss_rate: 0,
            lsb_depth: 0,
            lfe: 0,
            disable_inv: 0,
            arch: 0,
            rng: 0,
            spread_decision: 0,
            delayedIntra: 0.0,
            tonal_average: 0,
            lastCodedBands: 0,
            hf_average: 0,
            tapset_decision: 0,
            prefilter_period: 0,
            prefilter_gain: 0.0,
            prefilter_tapset: 0,
            consec_transient: 0,
            analysis: AnalysisInfo::new_zeroed(),
            silk_info: SILKInfo { signalType: 0, offset: 0 },
            preemph_memE: [0.0; 2],
            preemph_memD: [0.0; 2],
            vbr_reservoir: 0,
            vbr_drift: 0,
            vbr_offset: 0,
            vbr_count: 0,
            overlap_max: 0.0,
            stereo_saving: 0.0,
            intensity: 0,
            energy_mask: core::ptr::null(),
            spec_avg: 0.0,
            in_mem: [0.0; MAX_CHANNELS * OVERLAP],
            prefilter_mem: [0.0; MAX_CHANNELS * COMBFILTER_MAXPERIOD as usize],
            oldBandE: [0.0; MAX_CHANNELS * NB_EBANDS],
            oldLogE: [0.0; MAX_CHANNELS * NB_EBANDS],
            oldLogE2: [0.0; MAX_CHANNELS * NB_EBANDS],
            energyError: [0.0; MAX_CHANNELS * NB_EBANDS],
        }
    }
}

// group E: everything else.

/* ------------------------------------------------------------------------------------------
 * group G: encoder API used by src/opus_encoder.c (CELT-only).
 *
 * celt_encoder_init / opus_custom_encoder_init_arch and the subset of opus_custom_encoder_ctl
 * that the Opus layer uses, one function per request. Not ported: CELT_SET_ANALYSIS (the
 * analysis is never valid, st.analysis stays zeroed from the reset), CELT_SET_SILK_INFO
 * (hybrid only), OPUS_SET_ENERGY_MASK, OPUS_SET_LFE, OPUS_SET_QEXT, CELT_GET_MODE (always
 * `st.mode`), CELT_SET_INPUT_CLIPPING (custom modes only).
 * ---------------------------------------------------------------------------------------- */

/* Paths are spelled out in this section (no `use`) so it cannot clash with the imports of
the encoder body above. */

/// opus_custom_encoder_init_arch(st, mode48000_960_120, channels) followed by the
/// `upsample = resampling_factor(sampling_rate)` of celt_encoder_init. Only 48 kHz is
/// supported (upsample == 1).
pub fn celt_encoder_init(st: &mut CELTEncoder, sampling_rate: i32, channels: i32) -> i32 {
    debug_assert!(sampling_rate == 48000);
    if sampling_rate != 48000 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    /* opus_custom_encoder_init_arch() */
    if channels < 0 || channels > 2 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }

    *st = CELTEncoder::new_zeroed();

    st.mode = &mode48000_960_120;
    st.channels = channels;
    st.stream_channels = channels;

    st.upsample = 1;
    st.start = 0;
    st.end = st.mode.effEBands;
    st.signalling = 1;
    st.arch = 0;

    st.constrained_vbr = 1;
    st.clip = 1;

    st.bitrate = crate::opus::defines::OPUS_BITRATE_MAX;
    st.vbr = 0;
    st.force_intra = 0;
    st.complexity = 5;
    st.lsb_depth = 24;

    celt_encoder_reset_state(st);

    /* celt_encoder_init(): resampling_factor(48000) */
    st.upsample = 1;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_COMPLEXITY
pub fn celt_encoder_set_complexity(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 0 || value > 10 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.complexity = value;
    crate::opus::defines::OPUS_OK
}

/// CELT_SET_START_BAND
pub fn celt_encoder_set_start_band(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 0 || value >= st.mode.nbEBands {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.start = value;
    crate::opus::defines::OPUS_OK
}

/// CELT_SET_END_BAND
pub fn celt_encoder_set_end_band(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 1 || value > st.mode.nbEBands {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.end = value;
    crate::opus::defines::OPUS_OK
}

/// CELT_SET_PREDICTION
pub fn celt_encoder_set_prediction(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 0 || value > 2 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.disable_pf = (value <= 1) as i32;
    st.force_intra = (value == 0) as i32;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_PACKET_LOSS_PERC
pub fn celt_encoder_set_packet_loss_perc(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 0 || value > 100 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.loss_rate = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_VBR_CONSTRAINT (no validation, as in C)
pub fn celt_encoder_set_vbr_constraint(st: &mut CELTEncoder, value: i32) -> i32 {
    st.constrained_vbr = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_VBR (no validation, as in C). minicelt only supports VBR (`value == 1`) when
/// encoding.
pub fn celt_encoder_set_vbr(st: &mut CELTEncoder, value: i32) -> i32 {
    st.vbr = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_BITRATE
pub fn celt_encoder_set_bitrate(st: &mut CELTEncoder, value: i32) -> i32 {
    if value <= 500 && value != crate::opus::defines::OPUS_BITRATE_MAX {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    let value = super::arch::IMIN(value, 750000 * st.channels);
    st.bitrate = value;
    crate::opus::defines::OPUS_OK
}

/// CELT_SET_CHANNELS
pub fn celt_encoder_set_channels(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 1 || value > 2 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.stream_channels = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_LSB_DEPTH
pub fn celt_encoder_set_lsb_depth(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 8 || value > 24 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.lsb_depth = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_SET_PHASE_INVERSION_DISABLED
pub fn celt_encoder_set_phase_inversion_disabled(st: &mut CELTEncoder, value: i32) -> i32 {
    if value < 0 || value > 1 {
        return crate::opus::defines::OPUS_BAD_ARG;
    }
    st.disable_inv = value;
    crate::opus::defines::OPUS_OK
}

/// CELT_SET_SIGNALLING (no validation, as in C). The Opus layer sets 0; minicelt does not
/// support the Opus custom header (`signalling != 0`) when encoding.
pub fn celt_encoder_set_signalling(st: &mut CELTEncoder, value: i32) -> i32 {
    st.signalling = value;
    crate::opus::defines::OPUS_OK
}

/// OPUS_RESET_STATE
pub fn celt_encoder_reset_state(st: &mut CELTEncoder) {
    /* Clears everything from ENCODER_RESET_START (rng) to the end of the struct, including
    the trailing arrays (here sized for MAX_CHANNELS; C clears channels' worth). */
    let start = core::mem::offset_of!(CELTEncoder, rng);
    let size = core::mem::size_of::<CELTEncoder>();
    // SAFETY: every field from rng on is an integer, a float, an array of those, a struct of
    // those (AnalysisInfo, SILKInfo) or a raw pointer (energy_mask), for all of which the
    // all-zero bit pattern is valid (null for the pointer); `mode` lies before `rng`.
    unsafe {
        core::ptr::write_bytes((st as *mut CELTEncoder as *mut u8).add(start), 0, size - start);
    }
    let n = (st.channels * st.mode.nbEBands) as usize;
    for i in 0..n {
        st.oldLogE2[i] = -28.0f32;
        st.oldLogE[i] = st.oldLogE2[i];
    }
    st.vbr_offset = 0;
    st.delayedIntra = 1.0;
    st.spread_decision = crate::celt::bands::SPREAD_NORMAL;
    st.tonal_average = 256;
    st.hf_average = 0;
    st.tapset_decision = 0;
}

/// OPUS_GET_FINAL_RANGE
pub fn celt_encoder_get_final_range(st: &CELTEncoder) -> u32 {
    st.rng
}

/// Encodes one frame (celt/celt_encoder.c, implemented by the CELT port).
///
/// Contract: `pcm` holds `frame_size` interleaved samples of `st.channels` channels
/// (`pcm.len() >= frame_size * st.channels`, float scale +-1 i.e. opus_res); `frame_size`
/// is 960 here. If `enc` is `None`, the function creates its own range coder over
/// `compressed[0..nbCompressedBytes]`; otherwise it continues coding into `enc` (which the
/// caller initialised, e.g. on `data + 1` after the TOC byte) and `compressed` may be null.
/// Returns the number of bytes written (`nbCompressedBytes` after ec_enc_shrink in VBR)
/// or a negative Opus error code; on return `st.rng` holds the final range.
pub fn celt_encode_with_ec(
    st: &mut CELTEncoder,
    pcm: &[f32],
    frame_size: i32,
    compressed: *mut u8,
    nbCompressedBytes: i32,
    enc: Option<&mut crate::celt::entcode::ec_enc>,
) -> i32 {
    let _ = (st, pcm, frame_size, compressed, nbCompressedBytes, enc);
    todo!("celt_encode_with_ec: ported by the CELT encoder group")
}

#[cfg(test)]
mod api_tests {
    use super::*;
    use minicelt_oracle as c;
    use std::vec::Vec;

    /// The Rust state in the C memory layout for `channels` (fixed fields from `channels`
    /// on, i.e. without the mode pointer, then the trailing arrays at `channels` size).
    fn rust_bytes(st: &CELTEncoder, channels: usize) -> Vec<u8> {
        fn raw<T>(v: &[T]) -> &[u8] {
            unsafe { core::slice::from_raw_parts(v.as_ptr() as *const u8, core::mem::size_of_val(v)) }
        }
        let base = st as *const CELTEncoder as *const u8;
        let (a, b) = (core::mem::offset_of!(CELTEncoder, channels), core::mem::offset_of!(CELTEncoder, in_mem));
        let mut out = unsafe { core::slice::from_raw_parts(base.add(a), b - a) }.to_vec();
        let cb = COMBFILTER_MAXPERIOD as usize;
        out.extend_from_slice(raw(&st.in_mem[..channels * OVERLAP]));
        out.extend_from_slice(raw(&st.prefilter_mem[..channels * cb]));
        out.extend_from_slice(raw(&st.oldBandE[..channels * NB_EBANDS]));
        out.extend_from_slice(raw(&st.oldLogE[..channels * NB_EBANDS]));
        out.extend_from_slice(raw(&st.oldLogE2[..channels * NB_EBANDS]));
        out.extend_from_slice(raw(&st.energyError[..channels * NB_EBANDS]));
        out
    }

    fn c_init(channels: usize) -> Vec<u8> {
        let n = unsafe { c::celt_encoder_get_size(channels as i32) } as usize;
        let mut buf = std::vec![0xA5u8; n + 16];
        let p = ((buf.as_mut_ptr() as usize + 15) & !15) as *mut u8;
        let r = unsafe { c::oracle_opus_custom_encoder_init_arch(p as *mut _, crate::testutil::c_mode(), channels as i32, 0) };
        assert_eq!(r, crate::opus::defines::OPUS_OK);
        let off = core::mem::offset_of!(CELTEncoder, channels);
        unsafe { core::slice::from_raw_parts(p.add(off), n - off) }.to_vec()
    }

    #[test]
    fn celt_encoder_init_matches_c() {
        for ch in 1..=2usize {
            let mut st = CELTEncoder::new_zeroed();
            // Dirty state, so the test sees what init clears.
            unsafe {
                let start = core::mem::offset_of!(CELTEncoder, channels);
                let p = &mut st as *mut CELTEncoder as *mut u8;
                core::ptr::write_bytes(p.add(start), 0x5A, core::mem::size_of::<CELTEncoder>() - start);
            }
            assert_eq!(celt_encoder_init(&mut st, 48000, ch as i32), crate::opus::defines::OPUS_OK);
            assert_eq!(rust_bytes(&st, ch), c_init(ch), "channels={ch}");
            assert!(core::ptr::eq(st.mode, &mode48000_960_120));

            // OPUS_RESET_STATE on a dirty state gives the init state again (as in C, where
            // init ends with the reset and only the settings before `rng` survive).
            let want = rust_bytes(&st, ch);
            unsafe {
                let start = core::mem::offset_of!(CELTEncoder, rng);
                let p = &mut st as *mut CELTEncoder as *mut u8;
                core::ptr::write_bytes(p.add(start), 0x3C, core::mem::size_of::<CELTEncoder>() - start);
            }
            celt_encoder_reset_state(&mut st);
            assert_eq!(rust_bytes(&st, ch), want, "reset channels={ch}");
        }
    }
}
