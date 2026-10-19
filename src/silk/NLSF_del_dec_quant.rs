//! Port of silk/NLSF_del_dec_quant.c.

use crate::silk::define::*;
use crate::silk::macros::*;

const NSTATES: usize = NLSF_QUANT_DEL_DEC_STATES as usize;
const MAXO: usize = MAX_LPC_ORDER as usize;

/// Delayed-decision quantizer for NLSF residuals. Returns RD value in Q25.
/// `indices`: quantization indices [ order ] (O); `x_Q10`: input [ order ]; `w_Q5`: weights
/// [ order ]; `pred_coef_Q8`: backward predictor coefs [ order ]; `ec_ix`: indices to entropy
/// coding tables [ order ]; `ec_rates_Q5`: rates []; `quant_step_size_Q16`: quantization step
/// size; `inv_quant_step_size_Q6`: inverse quantization step size; `mu_Q20`: R/D tradeoff;
/// `order`: number of input values.
pub fn silk_NLSF_del_dec_quant(
    indices: &mut [i8],
    x_Q10: &[i16],
    w_Q5: &[i16],
    pred_coef_Q8: &[u8],
    ec_ix: &[i16],
    ec_rates_Q5: &[u8],
    quant_step_size_Q16: i32,
    inv_quant_step_size_Q6: i16,
    mu_Q20: i32,
    order: i16,
) -> i32 {
    let mut ind_sort = [0i32; NSTATES];
    /* zero-initialized (C leaves it uninitialized, but every value read has been written) */
    let mut ind = [[0i8; MAXO]; NSTATES];
    let mut prev_out_Q10 = [0i16; 2 * NSTATES];
    let mut RD_Q25 = [0i32; 2 * NSTATES];
    let mut RD_min_Q25 = [0i32; NSTATES];
    let mut RD_max_Q25 = [0i32; NSTATES];

    let mut out0_Q10_table = [0i32; (2 * NLSF_QUANT_MAX_AMPLITUDE_EXT) as usize];
    let mut out1_Q10_table = [0i32; (2 * NLSF_QUANT_MAX_AMPLITUDE_EXT) as usize];

    for i in -NLSF_QUANT_MAX_AMPLITUDE_EXT..=NLSF_QUANT_MAX_AMPLITUDE_EXT - 1 {
        let adj = SILK_FIX_CONST(NLSF_QUANT_LEVEL_ADJ, 10);
        let mut out0_Q10 = silk_LSHIFT(i, 10) as i16;
        let mut out1_Q10 = out0_Q10.wrapping_add(1024);
        if i > 0 {
            out0_Q10 = out0_Q10.wrapping_sub(adj as i16);
            out1_Q10 = out1_Q10.wrapping_sub(adj as i16);
        } else if i == 0 {
            out1_Q10 = out1_Q10.wrapping_sub(adj as i16);
        } else if i == -1 {
            out0_Q10 = out0_Q10.wrapping_add(adj as i16);
        } else {
            out0_Q10 = out0_Q10.wrapping_add(adj as i16);
            out1_Q10 = out1_Q10.wrapping_add(adj as i16);
        }
        out0_Q10_table[(i + NLSF_QUANT_MAX_AMPLITUDE_EXT) as usize] =
            silk_RSHIFT(silk_SMULBB(out0_Q10 as i32, quant_step_size_Q16), 16);
        out1_Q10_table[(i + NLSF_QUANT_MAX_AMPLITUDE_EXT) as usize] =
            silk_RSHIFT(silk_SMULBB(out1_Q10 as i32, quant_step_size_Q16), 16);
    }

    debug_assert!((NLSF_QUANT_DEL_DEC_STATES & (NLSF_QUANT_DEL_DEC_STATES - 1)) == 0); /* must be power of two */

    let mut nStates: usize = 1;
    RD_Q25[0] = 0;
    prev_out_Q10[0] = 0;
    for i in (0..order as usize).rev() {
        let rates_Q5 = &ec_rates_Q5[ec_ix[i] as usize..];
        let in_Q10 = x_Q10[i] as i32;
        for j in 0..nStates {
            let pred_Q10 = silk_RSHIFT(silk_SMULBB(pred_coef_Q8[i] as i32, prev_out_Q10[j] as i32), 8);
            let res_Q10 = (in_Q10 - pred_Q10) as i16 as i32; /* silk_SUB16 */
            let mut ind_tmp = silk_RSHIFT(silk_SMULBB(inv_quant_step_size_Q6 as i32, res_Q10), 16);
            ind_tmp = silk_LIMIT!(ind_tmp, -NLSF_QUANT_MAX_AMPLITUDE_EXT, NLSF_QUANT_MAX_AMPLITUDE_EXT - 1);
            ind[j][i] = ind_tmp as i8;

            /* compute outputs for ind_tmp and ind_tmp + 1 */
            let mut out0_Q10 = out0_Q10_table[(ind_tmp + NLSF_QUANT_MAX_AMPLITUDE_EXT) as usize] as i16;
            let mut out1_Q10 = out1_Q10_table[(ind_tmp + NLSF_QUANT_MAX_AMPLITUDE_EXT) as usize] as i16;

            out0_Q10 = out0_Q10.wrapping_add(pred_Q10 as i16);
            out1_Q10 = out1_Q10.wrapping_add(pred_Q10 as i16);
            prev_out_Q10[j] = out0_Q10;
            prev_out_Q10[j + nStates] = out1_Q10;

            /* compute RD for ind_tmp and ind_tmp + 1 */
            let rate0_Q5: i32;
            let rate1_Q5: i32;
            if ind_tmp + 1 >= NLSF_QUANT_MAX_AMPLITUDE {
                if ind_tmp + 1 == NLSF_QUANT_MAX_AMPLITUDE {
                    rate0_Q5 = rates_Q5[(ind_tmp + NLSF_QUANT_MAX_AMPLITUDE) as usize] as i32;
                    rate1_Q5 = 280;
                } else {
                    rate0_Q5 = silk_SMLABB(280 - 43 * NLSF_QUANT_MAX_AMPLITUDE, 43, ind_tmp);
                    rate1_Q5 = (rate0_Q5 + 43) as i16 as i32; /* silk_ADD16 */
                }
            } else if ind_tmp <= -NLSF_QUANT_MAX_AMPLITUDE {
                if ind_tmp == -NLSF_QUANT_MAX_AMPLITUDE {
                    rate0_Q5 = 280;
                    rate1_Q5 = rates_Q5[(ind_tmp + 1 + NLSF_QUANT_MAX_AMPLITUDE) as usize] as i32;
                } else {
                    rate0_Q5 = silk_SMLABB(280 - 43 * NLSF_QUANT_MAX_AMPLITUDE, -43, ind_tmp);
                    rate1_Q5 = (rate0_Q5 - 43) as i16 as i32; /* silk_SUB16 */
                }
            } else {
                rate0_Q5 = rates_Q5[(ind_tmp + NLSF_QUANT_MAX_AMPLITUDE) as usize] as i32;
                rate1_Q5 = rates_Q5[(ind_tmp + 1 + NLSF_QUANT_MAX_AMPLITUDE) as usize] as i32;
            }
            let RD_tmp_Q25 = RD_Q25[j];
            let mut diff_Q10 = (in_Q10 - out0_Q10 as i32) as i16 as i32; /* silk_SUB16 */
            RD_Q25[j] = silk_SMLABB(
                silk_MLA(RD_tmp_Q25, silk_SMULBB(diff_Q10, diff_Q10), w_Q5[i] as i32),
                mu_Q20,
                rate0_Q5,
            );
            diff_Q10 = (in_Q10 - out1_Q10 as i32) as i16 as i32; /* silk_SUB16 */
            RD_Q25[j + nStates] = silk_SMLABB(
                silk_MLA(RD_tmp_Q25, silk_SMULBB(diff_Q10, diff_Q10), w_Q5[i] as i32),
                mu_Q20,
                rate1_Q5,
            );
        }

        if nStates <= NSTATES / 2 {
            /* double number of states and copy */
            for j in 0..nStates {
                ind[j + nStates][i] = ind[j][i] + 1;
            }
            nStates <<= 1;
            for j in nStates..NSTATES {
                ind[j][i] = ind[j - nStates][i];
            }
        } else {
            /* sort lower and upper half of RD_Q25, pairwise */
            for j in 0..NSTATES {
                if RD_Q25[j] > RD_Q25[j + NSTATES] {
                    RD_max_Q25[j] = RD_Q25[j];
                    RD_min_Q25[j] = RD_Q25[j + NSTATES];
                    RD_Q25[j] = RD_min_Q25[j];
                    RD_Q25[j + NSTATES] = RD_max_Q25[j];
                    /* swap prev_out values */
                    let out0_Q10 = prev_out_Q10[j];
                    prev_out_Q10[j] = prev_out_Q10[j + NSTATES];
                    prev_out_Q10[j + NSTATES] = out0_Q10;
                    ind_sort[j] = (j + NSTATES) as i32;
                } else {
                    RD_min_Q25[j] = RD_Q25[j];
                    RD_max_Q25[j] = RD_Q25[j + NSTATES];
                    ind_sort[j] = j as i32;
                }
            }
            /* compare the highest RD values of the winning half with the lowest one in the losing half, and copy if necessary */
            /* afterwards ind_sort[] will contain the indices of the NLSF_QUANT_DEL_DEC_STATES winning RD values */
            loop {
                let mut min_max_Q25 = silk_int32_MAX;
                let mut max_min_Q25: i32 = 0;
                let mut ind_min_max = 0usize;
                let mut ind_max_min = 0usize;
                for j in 0..NSTATES {
                    if min_max_Q25 > RD_max_Q25[j] {
                        min_max_Q25 = RD_max_Q25[j];
                        ind_min_max = j;
                    }
                    if max_min_Q25 < RD_min_Q25[j] {
                        max_min_Q25 = RD_min_Q25[j];
                        ind_max_min = j;
                    }
                }
                if min_max_Q25 >= max_min_Q25 {
                    break;
                }
                /* copy ind_min_max to ind_max_min */
                ind_sort[ind_max_min] = ind_sort[ind_min_max] ^ NLSF_QUANT_DEL_DEC_STATES;
                RD_Q25[ind_max_min] = RD_Q25[ind_min_max + NSTATES];
                prev_out_Q10[ind_max_min] = prev_out_Q10[ind_min_max + NSTATES];
                RD_min_Q25[ind_max_min] = 0;
                RD_max_Q25[ind_min_max] = silk_int32_MAX;
                ind[ind_max_min] = ind[ind_min_max];
            }
            /* increment index if it comes from the upper half */
            for j in 0..NSTATES {
                ind[j][i] += silk_RSHIFT(ind_sort[j], NLSF_QUANT_DEL_DEC_STATES_LOG2) as i8;
            }
        }
    }

    /* last sample: find winner, copy indices and return RD value */
    let mut ind_tmp: usize = 0;
    let mut min_Q25 = silk_int32_MAX;
    for j in 0..2 * NSTATES {
        if min_Q25 > RD_Q25[j] {
            min_Q25 = RD_Q25[j];
            ind_tmp = j;
        }
    }
    for j in 0..order as usize {
        indices[j] = ind[ind_tmp & (NSTATES - 1)][j];
        debug_assert!(indices[j] as i32 >= -NLSF_QUANT_MAX_AMPLITUDE_EXT);
        debug_assert!(indices[j] as i32 <= NLSF_QUANT_MAX_AMPLITUDE_EXT);
    }
    indices[0] += silk_RSHIFT(ind_tmp as i32, NLSF_QUANT_DEL_DEC_STATES_LOG2) as i8;
    debug_assert!(indices[0] as i32 <= NLSF_QUANT_MAX_AMPLITUDE_EXT);
    debug_assert!(min_Q25 >= 0);
    min_Q25
}

#[cfg(test)]
mod tests {
    use crate::silk::NLSF2A::tests::random_nlsf;
    use crate::silk::NLSF_VQ_weights_laroia::silk_NLSF_VQ_weights_laroia;
    use crate::silk::NLSF_unpack::silk_NLSF_unpack;
    use crate::silk::macros::*;
    use crate::silk::tables::silk_NLSF_CB_WB;
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_NLSF_del_dec_quant(
                indices: *mut i8,
                x_Q10: *const i16,
                w_Q5: *const i16,
                pred_coef_Q8: *const u8,
                ec_ix: *const i16,
                ec_rates_Q5: *const u8,
                quant_step_size_Q16: i32,
                inv_quant_step_size_Q6: i16,
                mu_Q20: i32,
                order: i16,
            ) -> i32;
        }
    }

    /// Inputs built the way silk_NLSF_encode builds them (residual after stage 1, adjusted
    /// weights, unpacked predictors), for every stage-1 vector, plus noisier residuals that
    /// exercise the escape-rate branches (|index| >= NLSF_QUANT_MAX_AMPLITUDE).
    #[test]
    fn matches_c() {
        let cb = &silk_NLSF_CB_WB;
        let o = cb.order as usize;
        let rates = unsafe { core::slice::from_raw_parts(cb.ec_Rates_Q5, 72) };
        let mut rng = Rng::new(80);
        for t in 0..4000 {
            let ind1 = (t % 32) as i32;
            let nlsf = random_nlsf(&mut rng);
            let mut w_q2 = [0i16; 16];
            silk_NLSF_VQ_weights_laroia(&mut w_q2, &nlsf, 16);
            let mut res = [0i16; 16];
            let mut w_adj = [0i16; 16];
            unsafe {
                let el = core::slice::from_raw_parts(cb.CB1_NLSF_Q8.add(ind1 as usize * o), o);
                let wg = core::slice::from_raw_parts(cb.CB1_Wght_Q9.add(ind1 as usize * o), o);
                for i in 0..o {
                    let tmp = (el[i] as i16) << 7;
                    let w = wg[i] as i32;
                    res[i] = silk_RSHIFT(silk_SMULBB(nlsf[i] as i32 - tmp as i32, w), 14) as i16;
                    w_adj[i] = silk_DIV32_varQ(w_q2[i] as i32, silk_SMULBB(w, w), 21) as i16;
                }
            }
            if t % 3 == 1 {
                // larger residuals: forces large quantization indices
                let s = rng.range(2, 4);
                for w in w_adj.iter_mut() {
                    *w = (*w).min(8);
                }
                for r in res.iter_mut() {
                    *r = (*r as i32 * s).clamp(-3000, 3000) as i16;
                }
            }
            let mut ec_ix = [0i16; 16];
            let mut pred = [0u8; 16];
            silk_NLSF_unpack(&mut ec_ix, &mut pred, cb, ind1);
            let mu = [0, 1500, 3000, 5243, 5000, 32767][rng.range(0, 5) as usize].max(rng.range(0, 6000)) as i32;
            let (mut i1, mut i2) = ([0i8; 16], [0i8; 16]);
            let r1 = super::silk_NLSF_del_dec_quant(
                &mut i1, &res, &w_adj, &pred, &ec_ix, rates, cb.quantStepSize_Q16 as i32, cb.invQuantStepSize_Q6, mu, cb.order,
            );
            let r2 = unsafe {
                c::silk_NLSF_del_dec_quant(
                    i2.as_mut_ptr(), res.as_ptr(), w_adj.as_ptr(), pred.as_ptr(), ec_ix.as_ptr(), rates.as_ptr(),
                    cb.quantStepSize_Q16 as i32, cb.invQuantStepSize_Q6, mu, cb.order,
                )
            };
            assert_eq!(r1, r2, "RD, t={t}");
            assert_eq!(i1, i2, "indices, t={t}");
        }
    }
}
