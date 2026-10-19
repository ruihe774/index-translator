//! Port of celt/modes.h and the static-mode part of celt/modes.c: only the standard
//! 48 kHz / 960-sample mode exists (`static_modes_float::mode48000_960_120`).

use super::mdct::mdct_lookup;

pub struct PulseCache {
    pub size: i32,
    pub index: &'static [i16],
    pub bits: &'static [u8],
    pub caps: &'static [u8],
}

/// OpusCustomMode
pub struct CELTMode {
    pub Fs: i32,
    pub overlap: i32,

    pub nbEBands: i32,
    pub effEBands: i32,
    pub preemph: [f32; 4],
    /// Definition for each "pseudo-critical band"
    pub eBands: &'static [i16],

    pub maxLM: i32,
    pub nbShortMdcts: i32,
    pub shortMdctSize: i32,

    /// Number of lines in the matrix below
    pub nbAllocVectors: i32,
    /// Number of bits in each band for several rates
    pub allocVectors: &'static [u8],
    pub logN: &'static [i16],

    pub window: &'static [f32],
    pub mdct: mdct_lookup,
    pub cache: PulseCache,
}

pub use super::static_modes_float::mode48000_960_120;
