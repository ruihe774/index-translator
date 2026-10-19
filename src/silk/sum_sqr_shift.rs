//! Port of silk/sum_sqr_shift.c.

use crate::silk::macros::*;

/// Compute number of bits to right shift the sum of squares of a vector
/// of int16s to make it fit in an int32
pub fn silk_sum_sqr_shift(
    energy: &mut i32, /* O   Energy of x, after shifting to the right                     */
    shift: &mut i32,  /* O   Number of bits right shift applied to energy                 */
    x: &[i16],        /* I   Input vector                                                 */
    len: i32,         /* I   Length of input vector                                       */
) {
    let mut i: i32;
    let mut nrg_tmp: u32;

    /* Do a first run with the maximum shift we could have. */
    let mut shft = 31 - silk_CLZ32(len);
    /* Let's be conservative with rounding and start with nrg=len. */
    let mut nrg: i32 = len;
    i = 0;
    while i < len - 1 {
        nrg_tmp = silk_SMULBB(x[i as usize] as i32, x[i as usize] as i32) as u32;
        nrg_tmp = silk_SMLABB_ovflw(nrg_tmp as i32, x[i as usize + 1] as i32, x[i as usize + 1] as i32) as u32;
        nrg = silk_ADD_RSHIFT_uint(nrg as u32, nrg_tmp, shft) as i32;
        i += 2;
    }
    if i < len {
        /* One sample left to process */
        nrg_tmp = silk_SMULBB(x[i as usize] as i32, x[i as usize] as i32) as u32;
        nrg = silk_ADD_RSHIFT_uint(nrg as u32, nrg_tmp, shft) as i32;
    }
    debug_assert!(nrg >= 0);
    /* Make sure the result will fit in a 32-bit signed integer with two bits
       of headroom. */
    shft = silk_max_32(0, shft + 3 - silk_CLZ32(nrg));
    nrg = 0;
    i = 0;
    while i < len - 1 {
        nrg_tmp = silk_SMULBB(x[i as usize] as i32, x[i as usize] as i32) as u32;
        nrg_tmp = silk_SMLABB_ovflw(nrg_tmp as i32, x[i as usize + 1] as i32, x[i as usize + 1] as i32) as u32;
        nrg = silk_ADD_RSHIFT_uint(nrg as u32, nrg_tmp, shft) as i32;
        i += 2;
    }
    if i < len {
        /* One sample left to process */
        nrg_tmp = silk_SMULBB(x[i as usize] as i32, x[i as usize] as i32) as u32;
        nrg = silk_ADD_RSHIFT_uint(nrg as u32, nrg_tmp, shft) as i32;
    }

    debug_assert!(nrg >= 0);

    /* Output arguments */
    *shift = shft;
    *energy = nrg;
}
