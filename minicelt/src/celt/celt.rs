//! Port of celt/celt.h and the encoder-side parts of celt/celt.c.

pub const LEAK_BANDS: usize = 19;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct AnalysisInfo {
    pub valid: i32,
    pub tonality: f32,
    pub tonality_slope: f32,
    pub noisiness: f32,
    pub activity: f32,
    pub music_prob: f32,
    pub music_prob_min: f32,
    pub music_prob_max: f32,
    pub bandwidth: i32,
    pub activity_probability: f32,
    pub max_pitch_ratio: f32,
    /* Store as Q6 char to save space. */
    pub leak_boost: [u8; LEAK_BANDS],
}

impl AnalysisInfo {
    pub const fn new_zeroed() -> Self {
        AnalysisInfo {
            valid: 0,
            tonality: 0.0,
            tonality_slope: 0.0,
            noisiness: 0.0,
            activity: 0.0,
            music_prob: 0.0,
            music_prob_min: 0.0,
            music_prob_max: 0.0,
            bandwidth: 0,
            activity_probability: 0.0,
            max_pitch_ratio: 0.0,
            leak_boost: [0; LEAK_BANDS],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct SILKInfo {
    pub signalType: i32,
    pub offset: i32,
}

#[inline(always)]
pub fn bits_to_bitrate(bits: i32, Fs: i32, frame_size: i32) -> i32 {
    bits * (6 * Fs / frame_size) / 6
}

#[inline(always)]
pub fn bitrate_to_bits(bitrate: i32, Fs: i32, frame_size: i32) -> i32 {
    bitrate * 6 / (6 * Fs / frame_size)
}

pub static trim_icdf: [u8; 11] = [126, 124, 119, 109, 87, 41, 19, 9, 4, 2, 0];
/* Probs: NONE: 21.875%, LIGHT: 6.25%, NORMAL: 65.625%, AGGRESSIVE: 6.25% */
pub static spread_icdf: [u8; 4] = [25, 23, 2, 0];
pub static tapset_icdf: [u8; 3] = [2, 1, 0];

pub const COMBFILTER_MAXPERIOD: i32 = 1024;
pub const COMBFILTER_MINPERIOD: i32 = 15;

// group A: init_caps; group D: comb_filter (+ comb_filter_const in pitch);
// group E: tf_select_table, celt_preemphasis (celt_encoder.c), resampling_factor is not needed (48 kHz only).
