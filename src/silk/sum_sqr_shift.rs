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

#[cfg(test)]
mod tests {
    use crate::testutil::{Rng, SpeechGen};

    mod c {
        unsafe extern "C" {
            pub fn silk_sum_sqr_shift(energy: *mut i32, shift: *mut i32, x: *const i16, len: i32);
        }
    }

    fn check(x: &[i16]) {
        let len = x.len() as i32;
        let (mut e, mut s) = (0, 0);
        super::silk_sum_sqr_shift(&mut e, &mut s, x, len);
        let (mut ce, mut cs) = (0, 0);
        unsafe { c::silk_sum_sqr_shift(&mut ce, &mut cs, x.as_ptr(), len) };
        assert_eq!((e, s), (ce, cs), "len = {len}");
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(3);
        let mut sig = SpeechGen::new(5);
        for it in 0..3000 {
            let len = rng.range(1, 640) as usize;
            let bits = 1 + (it % 16) as u32;
            check(&rng.i16_vec(len, bits));
        }
        for _ in 0..50 {
            check(&sig.frame_i16());
        }
        for len in 1..700 {
            check(&std::vec![i16::MIN; len]);
            check(&std::vec![i16::MAX; len]);
            check(&std::vec![0; len]);
        }
    }
}
