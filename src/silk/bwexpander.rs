//! Port of silk/bwexpander.c.

use crate::silk::macros::*;

/// Chirp (bandwidth expand) LP AR filter.
/// `ar`: AR filter to be expanded (without leading 1) (I/O); `d`: length of ar;
/// `chirp_Q16`: chirp factor (typically in the range 0 to 1).
pub fn silk_bwexpander(ar: &mut [i16], d: i32, mut chirp_Q16: i32) {
    let chirp_minus_one_Q16 = chirp_Q16 - 65536;

    /* NB: Dont use silk_SMULWB, instead of silk_RSHIFT_ROUND( silk_MUL(), 16 ), below.  */
    /* Bias in silk_SMULWB can lead to unstable filters                                */
    for i in 0..(d - 1) as usize {
        ar[i] = silk_RSHIFT_ROUND(silk_MUL(chirp_Q16, ar[i] as i32), 16) as i16;
        chirp_Q16 += silk_RSHIFT_ROUND(silk_MUL(chirp_Q16, chirp_minus_one_Q16), 16);
    }
    ar[(d - 1) as usize] = silk_RSHIFT_ROUND(silk_MUL(chirp_Q16, ar[(d - 1) as usize] as i32), 16) as i16;
}
