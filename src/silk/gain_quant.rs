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
/// previous frame (I/O); `conditional`: first gain is delta coded if 1.
pub fn silk_gains_quant(ind: &mut [i8], gain_Q16: &mut [i32], prev_ind: &mut i8, conditional: i32, nb_subfr: i32) {
    for k in 0..nb_subfr as usize {
        /* Convert to log scale, scale, floor() */
        ind[k] = silk_SMULWB(SCALE_Q16, silk_lin2log(gain_Q16[k]) - OFFSET) as i8;

        /* Round towards previous quantized gain (hysteresis) */
        if ind[k] < *prev_ind {
            ind[k] += 1;
        }
        ind[k] = silk_LIMIT_int!(ind[k] as i32, 0, N_LEVELS_QGAIN - 1) as i8;

        /* Compute delta indices and limit */
        if k == 0 && conditional == 0 {
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

/// Gains scalar dequantization, uniform on log scale.
pub fn silk_gains_dequant(gain_Q16: &mut [i32], ind: &[i8], prev_ind: &mut i8, conditional: i32, nb_subfr: i32) {
    for k in 0..nb_subfr as usize {
        if k == 0 && conditional == 0 {
            /* Gain index is not allowed to go down more than 16 steps (~21.8 dB) */
            *prev_ind = silk_max_int(ind[k] as i32, *prev_ind as i32 - 16) as i8;
        } else {
            /* Delta index */
            let ind_tmp = ind[k] as i32 + MIN_DELTA_GAIN_QUANT;

            /* Accumulate deltas */
            let double_step_size_threshold = 2 * MAX_DELTA_GAIN_QUANT - N_LEVELS_QGAIN + *prev_ind as i32;
            if ind_tmp > double_step_size_threshold {
                *prev_ind = (*prev_ind as i32 + (silk_LSHIFT(ind_tmp, 1) - double_step_size_threshold)) as i8;
            } else {
                *prev_ind = (*prev_ind as i32 + ind_tmp) as i8;
            }
        }
        *prev_ind = silk_LIMIT_int!(*prev_ind as i32, 0, N_LEVELS_QGAIN - 1) as i8;

        /* Scale and convert to linear scale */
        gain_Q16[k] = silk_log2lin(silk_min_32(silk_SMULWB(INV_SCALE_Q16, *prev_ind as i32) + OFFSET, 3967)); /* 3967 = 31 in Q7 */
    }
}

/// Compute unique identifier of gain indices vector.
pub fn silk_gains_ID(ind: &[i8], nb_subfr: i32) -> i32 {
    let mut gainsID = 0;
    for k in 0..nb_subfr as usize {
        gainsID = silk_ADD_LSHIFT32(ind[k] as i32, gainsID, 8);
    }
    gainsID
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_gains_quant(ind: *mut i8, gain_Q16: *mut i32, prev_ind: *mut i8, conditional: i32, nb_subfr: i32);
            pub fn silk_gains_dequant(gain_Q16: *mut i32, ind: *const i8, prev_ind: *mut i8, conditional: i32, nb_subfr: i32);
            pub fn silk_gains_ID(ind: *const i8, nb_subfr: i32) -> i32;
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(99);
        for _ in 0..20000 {
            let nb_subfr = if rng.range(0, 3) == 0 { 2 } else { 4 };
            let cond = rng.range(0, 1);
            let prev = rng.range(0, 63) as i8;
            let mut gains = [0i32; 4];
            for g in gains.iter_mut() {
                // log2lin outputs for the full quantizer range, plus occasional extremes
                *g = match rng.range(0, 9) {
                    0 => rng.range(1, 1 << 20),
                    1 => rng.range(1 << 20, i32::MAX),
                    _ => silk_log2lin(rng.range(1000, 3967)),
                };
            }
            let (mut gr, mut gc) = (gains, gains);
            let (mut ir, mut ic) = ([0i8; 4], [0i8; 4]);
            let (mut pr, mut pc) = (prev, prev);
            silk_gains_quant(&mut ir, &mut gr, &mut pr, cond, nb_subfr);
            unsafe { c::silk_gains_quant(ic.as_mut_ptr(), gc.as_mut_ptr(), &mut pc, cond, nb_subfr) };
            assert_eq!((ir, gr, pr), (ic, gc, pc));
            assert_eq!(silk_gains_ID(&ir, nb_subfr), unsafe { c::silk_gains_ID(ic.as_ptr(), nb_subfr) });

            // dequant on valid indices
            let mut ind = [0i8; 4];
            for (k, v) in ind.iter_mut().enumerate() {
                *v = if k == 0 && cond == 0 { rng.range(0, 63) } else { rng.range(0, MAX_DELTA_GAIN_QUANT - MIN_DELTA_GAIN_QUANT) } as i8;
            }
            let (mut gr, mut gc) = ([0i32; 4], [0i32; 4]);
            let (mut pr, mut pc) = (prev, prev);
            silk_gains_dequant(&mut gr, &ind, &mut pr, cond, nb_subfr);
            unsafe { c::silk_gains_dequant(gc.as_mut_ptr(), ind.as_ptr(), &mut pc, cond, nb_subfr) };
            assert_eq!((gr, pr), (gc, pc));
        }
    }
}
