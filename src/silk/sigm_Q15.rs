//! Port of silk/sigm_Q15.c.

use crate::silk::macros::*;

/* Approximate sigmoid function */

/* fprintf(1, '%d, ', round(1024 * ([1 ./ (1 + exp(-(1:5))), 1] - 1 ./ (1 + exp(-(0:5)))))); */
static sigm_LUT_slope_Q10: [i32; 6] = [237, 153, 73, 30, 12, 7];
/* fprintf(1, '%d, ', round(32767 * 1 ./ (1 + exp(-(0:5))))); */
static sigm_LUT_pos_Q15: [i32; 6] = [16384, 23955, 28861, 31213, 32178, 32548];
/* fprintf(1, '%d, ', round(32767 * 1 ./ (1 + exp((0:5))))); */
static sigm_LUT_neg_Q15: [i32; 6] = [16384, 8812, 3906, 1554, 589, 219];

pub fn silk_sigm_Q15(mut in_Q5: i32) -> i32 {
    if in_Q5 < 0 {
        /* Negative input */
        in_Q5 = -in_Q5;
        if in_Q5 >= 6 * 32 {
            0 /* Clip */
        } else {
            /* Linear interpolation of look up table */
            let ind = silk_RSHIFT(in_Q5, 5) as usize;
            sigm_LUT_neg_Q15[ind] - silk_SMULBB(sigm_LUT_slope_Q10[ind], in_Q5 & 0x1F)
        }
    } else {
        /* Positive input */
        if in_Q5 >= 6 * 32 {
            32767 /* clip */
        } else {
            /* Linear interpolation of look up table */
            let ind = silk_RSHIFT(in_Q5, 5) as usize;
            sigm_LUT_pos_Q15[ind] + silk_SMULBB(sigm_LUT_slope_Q10[ind], in_Q5 & 0x1F)
        }
    }
}

#[cfg(test)]
mod tests {
    mod c {
        unsafe extern "C" {
            pub fn silk_sigm_Q15(in_Q5: i32) -> i32;
        }
    }

    #[test]
    fn matches_c() {
        for x in -300..300 {
            assert_eq!(super::silk_sigm_Q15(x), unsafe { c::silk_sigm_Q15(x) }, "in_Q5 = {x}");
        }
    }
}
