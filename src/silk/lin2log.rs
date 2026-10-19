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

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;

    mod c {
        unsafe extern "C" {
            pub fn silk_lin2log(inLin: i32) -> i32;
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(1);
        for i in 0..20000 {
            let x = if i < 1000 { i as i32 } else { rng.i32_bits(1 + i % 31) & i32::MAX };
            assert_eq!(super::silk_lin2log(x), unsafe { c::silk_lin2log(x) }, "inLin = {x}");
        }
    }
}
