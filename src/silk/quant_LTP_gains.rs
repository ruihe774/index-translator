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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::testutil::Rng;

    pub(crate) mod c {
        unsafe extern "C" {
            pub fn silk_quant_LTP_gains(
                B_Q14: *mut i16,
                cbk_index: *mut i8,
                periodicity_index: *mut i8,
                sum_log_gain_Q7: *mut i32,
                pred_gain_dB_Q7: *mut i32,
                XX_Q17: *const i32,
                xX_Q17: *const i32,
                subfr_len: i32,
                nb_subfr: i32,
                arch: i32,
            );
        }
    }

    /// Correlations as silk_find_LTP_FLP produces them (normalized, Q17), from a random
    /// voiced-like residual.
    pub(crate) fn random_corr(rng: &mut Rng) -> ([i32; 100], [i32; 20]) {
        let mut XX = [0i32; 100];
        let mut xX = [0i32; 20];
        let n = 80 + 5;
        let lag = rng.range(32, 200) as usize;
        let scale = [0.0f32, 0.3, 0.8, 1.0, 1.2][rng.range(0, 4) as usize];
        let noise = rng.f32_unit().abs() + 0.05;
        let mut r = std::vec![0f32; 4 * 80 + lag + 10];
        for i in 0..r.len() {
            r[i] = rng.f32_unit() * noise + if i >= lag { scale * r[i - lag] } else { 0.0 };
        }
        for k in 0..4 {
            let t0 = lag + 5 + k * 80;
            let x: Vec<f64> = (0..n).map(|i| r[t0 + i] as f64).collect();
            let lagged = |c: usize, i: usize| r[t0 + i + 2 - c - lag] as f64;
            let xx: f64 = x.iter().map(|v| v * v).sum::<f64>() + 1e-3;
            for a in 0..5 {
                let mut s = 0.0;
                for i in 0..80 {
                    s += lagged(a, i) * x[i];
                }
                xX[k * 5 + a] = (s / xx * 131072.0).round() as i32;
                for b in 0..5 {
                    let mut s = 0.0;
                    for i in 0..80 {
                        s += lagged(a, i) * lagged(b, i);
                    }
                    XX[k * 25 + a * 5 + b] = (s / xx * 131072.0).round() as i32;
                }
            }
        }
        (XX, xX)
    }

    use std::vec::Vec;

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(31);
        for it in 0..3000 {
            let (XX, xX) = random_corr(&mut rng);
            let sum0 = if it % 3 == 0 { 0 } else { rng.range(0, 6000) };
            let (mut B_r, mut B_c) = ([0i16; 20], [0i16; 20]);
            let (mut ci_r, mut ci_c) = ([0i8; 4], [0i8; 4]);
            let (mut p_r, mut p_c) = (0i8, 0i8);
            let (mut s_r, mut s_c) = (sum0, sum0);
            let (mut g_r, mut g_c) = (0, 0);
            silk_quant_LTP_gains(&mut B_r, &mut ci_r, &mut p_r, &mut s_r, &mut g_r, &XX, &xX, 80, 4);
            unsafe {
                c::silk_quant_LTP_gains(
                    B_c.as_mut_ptr(), ci_c.as_mut_ptr(), &mut p_c, &mut s_c, &mut g_c, XX.as_ptr(), xX.as_ptr(), 80, 4, 0,
                )
            };
            assert_eq!((B_r, ci_r, p_r, s_r, g_r), (B_c, ci_c, p_c, s_c, g_c), "it {it}");
        }
    }
}
