//! Port of silk/bwexpander_32.c.

use crate::silk::macros::*;

/// Chirp (bandwidth expand) LP AR filter.
/// `ar`: AR filter to be expanded (without leading 1) (I/O); `d`: length of ar;
/// `chirp_Q16`: chirp factor in Q16.
pub fn silk_bwexpander_32(ar: &mut [i32], d: i32, mut chirp_Q16: i32) {
    let chirp_minus_one_Q16 = chirp_Q16 - 65536;

    for i in 0..(d - 1) as usize {
        ar[i] = silk_SMULWW(chirp_Q16, ar[i]);
        chirp_Q16 += silk_RSHIFT_ROUND(silk_MUL(chirp_Q16, chirp_minus_one_Q16), 16);
    }
    ar[(d - 1) as usize] = silk_SMULWW(chirp_Q16, ar[(d - 1) as usize]);
}
