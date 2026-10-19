//! Port of silk/lin2log.c.

use crate::silk::macros::*;

/// Approximation of 128 * log2() (very close inverse of silk_log2lin()).
/// Convert input to a log scale.
pub fn silk_lin2log(inLin: i32) -> i32 {
    let (mut lz, mut frac_Q7) = (0, 0);

    silk_CLZ_FRAC(inLin, &mut lz, &mut frac_Q7);

    /* Piece-wise parabolic approximation */
    silk_ADD_LSHIFT32(silk_SMLAWB(frac_Q7, silk_MUL(frac_Q7, 128 - frac_Q7), 179), 31 - lz, 7)
}
