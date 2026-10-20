//! Port of celt/modes.h and the static-mode part of celt/modes.c: only the standard
//! 48 kHz / 960-sample mode exists, so the fields of `OpusCustomMode` (`mode48000_960_120`)
//! are constants and statics of this module (C name kept: `mode->nbEBands` is
//! `modes::nbEBands`). scripts/gen_tables.py checks the constants against libopus.

pub use super::static_modes_float::{
    band_allocation as allocVectors, cache_bits50 as cache_bits, cache_caps50 as cache_caps,
    cache_index50 as cache_index, eband5ms as eBands, logN400 as logN, window120 as window,
};

/// mode->overlap
pub const overlap: i32 = 120;
/// mode->nbEBands
pub const nbEBands: i32 = 21;
/// mode->effEBands
pub const effEBands: i32 = 21;
/// mode->maxLM
pub const maxLM: i32 = 3;
/// mode->shortMdctSize
pub const shortMdctSize: i32 = 120;
/// mode->nbAllocVectors
pub const nbAllocVectors: i32 = 11;
/// mode->preemph[0] (`preemph[1]` is 0)
pub const preemph0: f32 = 0.8500061;
