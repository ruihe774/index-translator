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

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_bwexpander(ar: *mut i16, d: i32, chirp_Q16: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(10);
        for _ in 0..3000 {
            let d = [10, 16, 6, 12][rng.range(0, 3) as usize];
            let bits = [8, 13, 16][rng.range(0, 2) as usize];
            let ar0 = rng.i16_vec(d as usize, bits);
            let chirp = match rng.range(0, 2) {
                0 => rng.range(0, 65536),
                1 => rng.range(60000, 65535),
                _ => 65536 - (1 << rng.range(1, 10)),
            };
            let (mut a, mut b) = (ar0.clone(), ar0.clone());
            super::silk_bwexpander(&mut a, d, chirp);
            unsafe { c::silk_bwexpander(b.as_mut_ptr(), d, chirp) };
            assert_eq!(a, b, "d={d} chirp={chirp} in={ar0:?}");
        }
    }
}
