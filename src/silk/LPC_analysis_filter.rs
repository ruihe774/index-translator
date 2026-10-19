//! Port of silk/LPC_analysis_filter.c.

use crate::silk::macros::*;

/*******************************************/
/* LPC analysis filter                     */
/* NB! State is kept internally and the    */
/* filter always starts with zero state    */
/* first d output samples are set to zero  */
/*******************************************/

/* C has `USE_CELT_FIR 0` and the celt_fir path only exists in FIXED_POINT builds; the generic
   scalar version below is what the (float) oracle compiles. */

/// `out`: output signal (O); `in_`: input signal; `B`: MA prediction coefficients, Q12 [order];
/// `len`: signal length; `d`: filter order.
pub fn silk_LPC_analysis_filter(out: &mut [i16], in_: &[i16], B: &[i16], len: i32, d: i32) {
    debug_assert!(d >= 6);
    debug_assert!((d & 1) == 0);
    debug_assert!(d <= len);

    for ix in d as usize..len as usize {
        /* in_ptr = &in[ ix - 1 ]; in_ptr[ -j ] == in_[ ix - 1 - j ] */
        let ip = ix - 1;

        let mut out32_Q12 = silk_SMULBB(in_[ip] as i32, B[0] as i32);
        /* Allowing wrap around so that two wraps can cancel each other. The rare
        cases where the result wraps around can only be triggered by invalid streams*/
        out32_Q12 = silk_SMLABB_ovflw(out32_Q12, in_[ip - 1] as i32, B[1] as i32);
        out32_Q12 = silk_SMLABB_ovflw(out32_Q12, in_[ip - 2] as i32, B[2] as i32);
        out32_Q12 = silk_SMLABB_ovflw(out32_Q12, in_[ip - 3] as i32, B[3] as i32);
        out32_Q12 = silk_SMLABB_ovflw(out32_Q12, in_[ip - 4] as i32, B[4] as i32);
        out32_Q12 = silk_SMLABB_ovflw(out32_Q12, in_[ip - 5] as i32, B[5] as i32);
        let mut j = 6usize;
        while j < d as usize {
            out32_Q12 = silk_SMLABB_ovflw(out32_Q12, in_[ip - j] as i32, B[j] as i32);
            out32_Q12 = silk_SMLABB_ovflw(out32_Q12, in_[ip - j - 1] as i32, B[j + 1] as i32);
            j += 2;
        }

        /* Subtract prediction */
        out32_Q12 = silk_SUB32_ovflw(silk_LSHIFT(in_[ip + 1] as i32, 12), out32_Q12);

        /* Scale to Q0 */
        let out32 = silk_RSHIFT_ROUND(out32_Q12, 12);

        /* Saturate output */
        out[ix] = silk_SAT16(out32) as i16;
    }

    /* Set first d output samples to zero */
    out[..d as usize].fill(0);
}

#[cfg(test)]
mod tests {
    use crate::silk::NLSF2A::tests::random_stable_a_Q12;
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_LPC_analysis_filter(out: *mut i16, in_: *const i16, B: *const i16, len: i32, d: i32, arch: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(100);
        for t in 0..1500 {
            let d = [10, 16, 6, 12][t % 4];
            let len = [100, 136, 320, 21][(t / 4) % 4].max(d);
            let b: Vec<i16> = match t % 3 {
                0 => random_stable_a_Q12(&mut rng, d as usize),
                1 => rng.i16_vec(d as usize, 13),
                _ => rng.i16_vec(d as usize, 16),
            };
            let inp = rng.i16_vec(len as usize, [8, 12, 16][(t / 3) % 3]);
            let (mut o1, mut o2) = (vec![0x55i16; len as usize], vec![0x55i16; len as usize]);
            super::silk_LPC_analysis_filter(&mut o1, &inp, &b, len, d);
            unsafe { c::silk_LPC_analysis_filter(o2.as_mut_ptr(), inp.as_ptr(), b.as_ptr(), len, d, 0) };
            assert_eq!(o1, o2, "d={d} len={len}");
        }
    }
}
