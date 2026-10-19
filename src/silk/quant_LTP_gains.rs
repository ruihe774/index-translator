//! Port of silk/quant_LTP_gains.c.

use crate::silk::VQ_WMat_EC::silk_VQ_WMat_EC;
use crate::silk::define::*;
use crate::silk::lin2log::silk_lin2log;
use crate::silk::log2lin::silk_log2lin;
use crate::silk::macros::*;
use crate::silk::tables::*;
use crate::silk::tuning_parameters::*;

const LTP_ORDER_: usize = LTP_ORDER as usize;
const MAX_NB_SUBFR_: usize = MAX_NB_SUBFR as usize;

pub fn silk_quant_LTP_gains(
    B_Q14: &mut [i16; MAX_NB_SUBFR_ * LTP_ORDER_], /* O    Quantized LTP gains             */
    cbk_index: &mut [i8; MAX_NB_SUBFR_],           /* O    Codebook Index                  */
    periodicity_index: &mut i8,                    /* O    Periodicity Index               */
    sum_log_gain_Q7: &mut i32,                     /* I/O  Cumulative max prediction gain  */
    pred_gain_dB_Q7: &mut i32,                     /* O    LTP prediction gain             */
    XX_Q17: &[i32],                                /* I    Correlation matrix in Q18       [MAX_NB_SUBFR*LTP_ORDER*LTP_ORDER] */
    xX_Q17: &[i32],                                /* I    Correlation vector in Q18       [MAX_NB_SUBFR*LTP_ORDER] */
    subfr_len: i32,                                /* I    Number of samples per subframe  */
    nb_subfr: i32,                                 /* I    Number of subframes             */
) {
    let mut temp_idx = [0i8; MAX_NB_SUBFR_];
    let mut res_nrg_Q15_subfr = 0i32;
    let mut rate_dist_Q7_subfr = 0i32;
    let mut gain_Q7 = 0i32;
    let mut res_nrg_Q15: i32 = 0;

    /***************************************************/
    /* iterate over different codebooks with different */
    /* rates/distortions, and choose best */
    /***************************************************/
    let mut min_rate_dist_Q7 = silk_int32_MAX;
    let mut best_sum_log_gain_Q7 = 0;
    for k in 0..3usize {
        /* Safety margin for pitch gain control, to take into account factors
           such as state rescaling/rewhitening. */
        let gain_safety = SILK_FIX_CONST(0.4, 7);

        let cl_ptr_Q5 = silk_LTP_gain_BITS_Q5_ptrs[k];
        let cbk_ptr_Q7 = silk_LTP_vq_ptrs_Q7[k];
        let cbk_gain_ptr_Q7 = silk_LTP_vq_gain_ptrs_Q7[k];
        let cbk_size = silk_LTP_vq_sizes[k] as i32;

        res_nrg_Q15 = 0;
        let mut rate_dist_Q7: i32 = 0;
        let mut sum_log_gain_tmp_Q7 = *sum_log_gain_Q7;
        for j in 0..nb_subfr as usize {
            let max_gain_Q7 = silk_log2lin(
                (SILK_FIX_CONST(MAX_SUM_LOG_GAIN_DB as f64 / 6.0, 7) - sum_log_gain_tmp_Q7) + SILK_FIX_CONST(7.0, 7),
            ) - gain_safety;
            silk_VQ_WMat_EC(
                &mut temp_idx[j],         /* O    index of best codebook vector                           */
                &mut res_nrg_Q15_subfr,   /* O    residual energy                                         */
                &mut rate_dist_Q7_subfr,  /* O    best weighted quantization error + mu * rate            */
                &mut gain_Q7,             /* O    sum of absolute LTP coefficients                        */
                &XX_Q17[j * LTP_ORDER_ * LTP_ORDER_..], /* I    correlation matrix                        */
                &xX_Q17[j * LTP_ORDER_..], /* I    correlation vector                                     */
                cbk_ptr_Q7,               /* I    codebook                                                */
                cbk_gain_ptr_Q7,          /* I    codebook effective gains                                */
                cl_ptr_Q5,                /* I    code length for each codebook vector                    */
                subfr_len,                /* I    number of samples per subframe                          */
                max_gain_Q7,              /* I    maximum sum of absolute LTP coefficients                */
                cbk_size,                 /* I    number of vectors in codebook                           */
            );

            res_nrg_Q15 = silk_ADD_POS_SAT32(res_nrg_Q15, res_nrg_Q15_subfr);
            rate_dist_Q7 = silk_ADD_POS_SAT32(rate_dist_Q7, rate_dist_Q7_subfr);
            sum_log_gain_tmp_Q7 =
                silk_max!(0, sum_log_gain_tmp_Q7 + silk_lin2log(gain_safety + gain_Q7) - SILK_FIX_CONST(7.0, 7));
        }

        if rate_dist_Q7 <= min_rate_dist_Q7 {
            min_rate_dist_Q7 = rate_dist_Q7;
            *periodicity_index = k as i8;
            cbk_index[..nb_subfr as usize].copy_from_slice(&temp_idx[..nb_subfr as usize]);
            best_sum_log_gain_Q7 = sum_log_gain_tmp_Q7;
        }
    }

    let cbk_ptr_Q7 = silk_LTP_vq_ptrs_Q7[*periodicity_index as usize];
    for j in 0..nb_subfr as usize {
        for k in 0..LTP_ORDER_ {
            B_Q14[j * LTP_ORDER_ + k] = silk_LSHIFT(cbk_ptr_Q7[cbk_index[j] as usize][k] as i32, 7) as i16;
        }
    }

    /* nb_subfr == 2 (10 ms frames) would shift by 1 */
    debug_assert!(nb_subfr == MAX_NB_SUBFR);
    res_nrg_Q15 = silk_RSHIFT32(res_nrg_Q15, 2);

    *sum_log_gain_Q7 = best_sum_log_gain_Q7;
    *pred_gain_dB_Q7 = silk_SMULBB(-3, silk_lin2log(res_nrg_Q15) - (15 << 7));
}
