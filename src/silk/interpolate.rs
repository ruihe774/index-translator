//! Port of silk/interpolate.c.

use crate::silk::macros::*;

/// Interpolate two vectors.
/// `xi`: interpolated vector (O); `x0`: first vector; `x1`: second vector;
/// `ifact_Q2`: interp. factor, weight on 2nd vector; `d`: number of parameters.
pub fn silk_interpolate(xi: &mut [i16], x0: &[i16], x1: &[i16], ifact_Q2: i32, d: i32) {
    debug_assert!(ifact_Q2 >= 0);
    debug_assert!(ifact_Q2 <= 4);

    for i in 0..d as usize {
        xi[i] = silk_ADD_RSHIFT(x0[i] as i32, silk_SMULBB(x1[i] as i32 - x0[i] as i32, ifact_Q2), 2) as i16;
    }
}
