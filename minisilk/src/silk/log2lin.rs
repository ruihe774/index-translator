//! Port of silk/log2lin.c.

use crate::silk::macros::*;

/// Approximation of 2^() (very close inverse of silk_lin2log()).
/// Convert input to a linear scale.
pub fn silk_log2lin(inLog_Q7: i32) -> i32 {
    if inLog_Q7 < 0 {
        return 0;
    } else if inLog_Q7 >= 3967 {
        return silk_int32_MAX;
    }

    let mut out = silk_LSHIFT(1, silk_RSHIFT(inLog_Q7, 7));
    let frac_Q7 = inLog_Q7 & 0x7F;
    if inLog_Q7 < 2048 {
        /* Piece-wise parabolic approximation */
        out = silk_ADD_RSHIFT32(out, silk_MUL(out, silk_SMLAWB(frac_Q7, silk_SMULBB(frac_Q7, 128 - frac_Q7), -174)), 7);
    } else {
        /* Piece-wise parabolic approximation */
        out = silk_MLA(out, silk_RSHIFT(out, 7), silk_SMLAWB(frac_Q7, silk_SMULBB(frac_Q7, 128 - frac_Q7), -174));
    }
    out
}
