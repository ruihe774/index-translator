//! Port of silk/LPC_fit.c.

use crate::silk::bwexpander_32::silk_bwexpander_32;
use crate::silk::macros::*;

/// Convert int32 coefficients to int16 coefs and make sure there's no wrap-around.
/// This logic is reused in _celt_lpc(). Any bug fixes should also be applied there.
/// `a_QOUT`: output (O); `a_QIN`: input (I/O); `QOUT`/`QIN`: Q domains; `d`: filter order.
pub fn silk_LPC_fit(a_QOUT: &mut [i16], a_QIN: &mut [i32], QOUT: i32, QIN: i32, d: i32) {
    let mut idx: i32 = 0;

    /* Limit the maximum absolute value of the prediction coefficients, so that they'll fit in int16 */
    let mut i = 0;
    while i < 10 {
        /* Find maximum absolute value and its index */
        let mut maxabs: i32 = 0;
        for k in 0..d {
            let absval = silk_abs!(a_QIN[k as usize]);
            if absval > maxabs {
                maxabs = absval;
                idx = k;
            }
        }
        maxabs = silk_RSHIFT_ROUND(maxabs, QIN - QOUT);

        if maxabs > silk_int16_MAX {
            /* Reduce magnitude of prediction coefficients */
            maxabs = silk_min!(maxabs, 163838); /* ( silk_int32_MAX >> 14 ) + silk_int16_MAX = 163838 */
            let chirp_Q16 = SILK_FIX_CONST(0.999, 16)
                - silk_DIV32(
                    silk_LSHIFT(maxabs - silk_int16_MAX, 14),
                    silk_RSHIFT32(silk_MUL(maxabs, idx + 1), 2),
                );
            silk_bwexpander_32(a_QIN, d, chirp_Q16);
        } else {
            break;
        }
        i += 1;
    }

    if i == 10 {
        /* Reached the last iteration, clip the coefficients */
        for k in 0..d as usize {
            a_QOUT[k] = silk_SAT16(silk_RSHIFT_ROUND(a_QIN[k], QIN - QOUT)) as i16;
            a_QIN[k] = silk_LSHIFT(a_QOUT[k] as i32, QIN - QOUT);
        }
    } else {
        for k in 0..d as usize {
            a_QOUT[k] = silk_RSHIFT_ROUND(a_QIN[k], QIN - QOUT) as i16;
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_LPC_fit(a_QOUT: *mut i16, a_QIN: *mut i32, QOUT: i32, QIN: i32, d: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(13);
        for t in 0..4000 {
            let d = [10, 16][rng.range(0, 1) as usize];
            // Q17 -> Q12 as in NLSF2A; ranges from small to far beyond int16 in Q12
            // (including the clipping case, where the chirp loop does not converge).
            let bits = [14, 17, 19, 21, 24, 28][t % 6];
            let a0 = rng.i32_vec(d as usize, bits);
            let (qout, qin) = if t % 5 == 0 { (12, 24) } else { (12, 17) };
            let (mut a1, mut a2) = (a0.clone(), a0.clone());
            let (mut o1, mut o2) = (vec![0i16; 16], vec![0i16; 16]);
            super::silk_LPC_fit(&mut o1, &mut a1, qout, qin, d);
            unsafe { c::silk_LPC_fit(o2.as_mut_ptr(), a2.as_mut_ptr(), qout, qin, d) };
            assert_eq!(o1, o2, "out, in={a0:?}");
            assert_eq!(a1, a2, "in/out, in={a0:?}");
        }
    }
}
