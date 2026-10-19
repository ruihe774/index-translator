//! Port of silk/NLSF_stabilize.c.

/* NLSF stabilizer:                                         */
/*                                                          */
/* - Moves NLSFs further apart if they are too close        */
/* - Moves NLSFs away from borders if they are too close    */
/* - High effort to achieve a modification with minimum     */
/*     Euclidean distance to input vector                   */
/* - Output are sorted NLSF coefficients                    */
/*                                                          */

use crate::silk::macros::*;
use crate::silk::sort::silk_insertion_sort_increasing_all_values_int16;

/* Constant Definitions */
const MAX_LOOPS: i32 = 20;

/// NLSF stabilizer, for a single input data vector.
/// `NLSF_Q15`: unstable/stabilized normalized LSF vector in Q15 [L] (I/O);
/// `NDeltaMin_Q15`: min distance vector, NDeltaMin_Q15[L] must be >= 1 [L+1];
/// `L`: number of NLSF parameters in the input vector.
pub fn silk_NLSF_stabilize(NLSF_Q15: &mut [i16], NDeltaMin_Q15: &[i16], L: i32) {
    let Lu = L as usize;


    /* This is necessary to ensure an output within range of a opus_int16 */
    debug_assert!(NDeltaMin_Q15[Lu] >= 1);

    let mut loops = 0;
    while loops < MAX_LOOPS {
        /**************************/
        /* Find smallest distance */
        /**************************/
        /* First element */
        let mut min_diff_Q15 = NLSF_Q15[0] as i32 - NDeltaMin_Q15[0] as i32;
        let mut I: usize = 0;
        /* Middle elements */
        for i in 1..=Lu - 1 {
            let diff_Q15 = NLSF_Q15[i] as i32 - (NLSF_Q15[i - 1] as i32 + NDeltaMin_Q15[i] as i32);
            if diff_Q15 < min_diff_Q15 {
                min_diff_Q15 = diff_Q15;
                I = i;
            }
        }
        /* Last element */
        let diff_Q15 = (1 << 15) - (NLSF_Q15[Lu - 1] as i32 + NDeltaMin_Q15[Lu] as i32);
        if diff_Q15 < min_diff_Q15 {
            min_diff_Q15 = diff_Q15;
            I = Lu;
        }

        /***************************************************/
        /* Now check if the smallest distance non-negative */
        /***************************************************/
        if min_diff_Q15 >= 0 {
            return;
        }

        if I == 0 {
            /* Move away from lower limit */
            NLSF_Q15[0] = NDeltaMin_Q15[0];
        } else if I == Lu {
            /* Move away from higher limit */
            NLSF_Q15[Lu - 1] = ((1 << 15) - NDeltaMin_Q15[Lu] as i32) as i16;
        } else {
            /* Find the lower extreme for the location of the current center frequency */
            let mut min_center_Q15: i32 = 0;
            for k in 0..I {
                min_center_Q15 += NDeltaMin_Q15[k] as i32;
            }
            min_center_Q15 += silk_RSHIFT(NDeltaMin_Q15[I] as i32, 1);

            /* Find the upper extreme for the location of the current center frequency */
            let mut max_center_Q15: i32 = 1 << 15;
            for k in ((I + 1)..=Lu).rev() {
                max_center_Q15 -= NDeltaMin_Q15[k] as i32;
            }
            max_center_Q15 -= silk_RSHIFT(NDeltaMin_Q15[I] as i32, 1);

            /* Move apart, sorted by value, keeping the same center frequency */
            let center_freq_Q15 = silk_LIMIT_32!(
                silk_RSHIFT_ROUND(NLSF_Q15[I - 1] as i32 + NLSF_Q15[I] as i32, 1),
                min_center_Q15,
                max_center_Q15
            ) as i16;
            NLSF_Q15[I - 1] = (center_freq_Q15 as i32 - silk_RSHIFT(NDeltaMin_Q15[I] as i32, 1)) as i16;
            NLSF_Q15[I] = (NLSF_Q15[I - 1] as i32 + NDeltaMin_Q15[I] as i32) as i16;
        }
        loops += 1;
    }

    /* Safe and simple fall back method, which is less ideal than the above */
    if loops == MAX_LOOPS {
        /* Insertion sort (fast for already almost sorted arrays):   */
        /* Best case:  O(n)   for an already sorted array            */
        /* Worst case: O(n^2) for an inversely sorted array          */
        silk_insertion_sort_increasing_all_values_int16(NLSF_Q15, L);

        /* First NLSF should be no less than NDeltaMin[0] */
        NLSF_Q15[0] = silk_max_int(NLSF_Q15[0] as i32, NDeltaMin_Q15[0] as i32) as i16;

        /* Keep delta_min distance between the NLSFs */
        for i in 1..Lu {
            NLSF_Q15[i] = silk_max_int(
                NLSF_Q15[i] as i32,
                silk_ADD_SAT16(NLSF_Q15[i - 1] as i32, NDeltaMin_Q15[i] as i32) as i32,
            ) as i16;
        }

        /* Last NLSF should be no higher than 1 - NDeltaMin[L] */
        NLSF_Q15[Lu - 1] = silk_min_int(NLSF_Q15[Lu - 1] as i32, (1 << 15) - NDeltaMin_Q15[Lu] as i32) as i16;

        /* Keep NDeltaMin distance between the NLSFs */
        for i in (0..=Lu - 2).rev() {
            NLSF_Q15[i] =
                silk_min_int(NLSF_Q15[i] as i32, NLSF_Q15[i + 1] as i32 - NDeltaMin_Q15[i + 1] as i32) as i16;
        }
    }
}
