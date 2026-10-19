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

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_bwexpander_32(ar: *mut i32, d: i32, chirp_Q16: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(11);
        for _ in 0..3000 {
            let d = [10, 16, 6, 12][rng.range(0, 3) as usize];
            let bits = [12, 20, 25][rng.range(0, 2) as usize];
            let ar0 = rng.i32_vec(d as usize, bits);
            let chirp = match rng.range(0, 2) {
                0 => rng.range(0, 65536),
                1 => rng.range(60000, 65535),
                _ => 65536 - (1 << rng.range(1, 10)),
            };
            let (mut a, mut b) = (ar0.clone(), ar0.clone());
            super::silk_bwexpander_32(&mut a, d, chirp);
            unsafe { c::silk_bwexpander_32(b.as_mut_ptr(), d, chirp) };
            assert_eq!(a, b, "d={d} chirp={chirp} in={ar0:?}");
        }
    }
}
