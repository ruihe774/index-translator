//! Port of silk/gain_quant.c.

use crate::silk::define::*;
use crate::silk::lin2log::silk_lin2log;
use crate::silk::log2lin::silk_log2lin;
use crate::silk::macros::*;

const OFFSET: i32 = (MIN_QGAIN_DB * 128) / 6 + 16 * 128;
const SCALE_Q16: i32 = (65536 * (N_LEVELS_QGAIN - 1)) / (((MAX_QGAIN_DB - MIN_QGAIN_DB) * 128) / 6);
const INV_SCALE_Q16: i32 = (65536 * (((MAX_QGAIN_DB - MIN_QGAIN_DB) * 128) / 6)) / (N_LEVELS_QGAIN - 1);

/// Gain scalar quantization with hysteresis, uniform on log scale.
///
/// `ind`: gain indices (O); `gain_Q16`: gains, quantized out (I/O); `prev_ind`: last index in
/// previous frame (I/O). The first gain is always coded independently (full index).
pub fn silk_gains_quant(ind: &mut [i8], gain_Q16: &mut [i32], prev_ind: &mut i8) {
    for k in 0..MAX_NB_SUBFR as usize {
        /* Convert to log scale, scale, floor() */
        ind[k] = silk_SMULWB(SCALE_Q16, silk_lin2log(gain_Q16[k]) - OFFSET) as i8;

        /* Round towards previous quantized gain (hysteresis) */
        if ind[k] < *prev_ind {
            ind[k] += 1;
        }
        ind[k] = silk_LIMIT_int!(ind[k] as i32, 0, N_LEVELS_QGAIN - 1) as i8;

        /* Compute delta indices and limit */
        if k == 0 {
            /* Full index */
            ind[k] = silk_LIMIT_int!(ind[k] as i32, *prev_ind as i32 + MIN_DELTA_GAIN_QUANT, N_LEVELS_QGAIN - 1) as i8;
            *prev_ind = ind[k];
        } else {
            /* Delta index */
            ind[k] = (ind[k] as i32 - *prev_ind as i32) as i8;

            /* Double the quantization step size for large gain increases, so that the max gain level can be reached */
            let double_step_size_threshold = 2 * MAX_DELTA_GAIN_QUANT - N_LEVELS_QGAIN + *prev_ind as i32;
            if ind[k] as i32 > double_step_size_threshold {
                ind[k] = (double_step_size_threshold + silk_RSHIFT(ind[k] as i32 - double_step_size_threshold + 1, 1)) as i8;
            }

            ind[k] = silk_LIMIT_int!(ind[k] as i32, MIN_DELTA_GAIN_QUANT, MAX_DELTA_GAIN_QUANT) as i8;

            /* Accumulate deltas */
            if ind[k] as i32 > double_step_size_threshold {
                *prev_ind = (*prev_ind as i32 + (silk_LSHIFT(ind[k] as i32, 1) - double_step_size_threshold)) as i8;
                *prev_ind = silk_min_int(*prev_ind as i32, N_LEVELS_QGAIN - 1) as i8;
            } else {
                *prev_ind = (*prev_ind as i32 + ind[k] as i32) as i8;
            }

            /* Shift to make non-negative */
            ind[k] = (ind[k] as i32 - MIN_DELTA_GAIN_QUANT) as i8;
        }

        /* Scale and convert to linear scale */
        gain_Q16[k] = silk_log2lin(silk_min_32(silk_SMULWB(INV_SCALE_Q16, *prev_ind as i32) + OFFSET, 3967)); /* 3967 = 31 in Q7 */
    }
}

/// Compute unique identifier of gain indices vector.
pub fn silk_gains_ID(ind: &[i8]) -> i32 {
    let mut gainsID = 0;
    for k in 0..MAX_NB_SUBFR as usize {
        gainsID = silk_ADD_LSHIFT32(ind[k] as i32, gainsID, 8);
    }
    gainsID
}
