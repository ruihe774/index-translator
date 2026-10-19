//! Port of celt/rate.h and celt/rate.c (encoder side; static pulse cache).

use super::modes::CELTMode;

pub const MAX_PSEUDO: i32 = 40;
pub const LOG_MAX_PSEUDO: i32 = 6;

pub const CELT_MAX_PULSES: i32 = 128;

pub const MAX_FINE_BITS: i32 = 8;

pub const FINE_OFFSET: i32 = 21;
pub const QTHETA_OFFSET: i32 = 4;
pub const QTHETA_OFFSET_TWOPHASE: i32 = 16;

/// Fixed interface (used by bands.rs).
#[inline]
pub fn get_pulses(i: i32) -> i32 {
    if i < 8 { i } else { (8 + (i & 7)) << ((i >> 3) - 1) }
}

/// Fixed interface (used by bands.rs).
pub fn bits2pulses(m: &CELTMode, band: i32, LM: i32, bits: i32) -> i32 {
    let _ = (m, band, LM, bits);
    todo!("group A")
}

/// Fixed interface (used by bands.rs).
pub fn pulses2bits(m: &CELTMode, band: i32, LM: i32, pulses: i32) -> i32 {
    let _ = (m, band, LM, pulses);
    todo!("group A")
}

// group A: clt_compute_allocation (+ interp_bits2pulses).
