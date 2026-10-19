//! Port of silk/NLSF_encode.c.

use crate::silk::NLSF_VQ::silk_NLSF_VQ;
use crate::silk::NLSF_decode::silk_NLSF_decode;
use crate::silk::NLSF_del_dec_quant::silk_NLSF_del_dec_quant;
use crate::silk::NLSF_stabilize::silk_NLSF_stabilize;
use crate::silk::NLSF_unpack::silk_NLSF_unpack;
use crate::silk::define::*;
use crate::silk::lin2log::silk_lin2log;
use crate::silk::macros::*;
use crate::silk::sort::silk_insertion_sort_increasing;
use crate::silk::structs::silk_NLSF_CB_struct;
use crate::stack;

/***********************/
/* NLSF vector encoder */
/***********************/
/// Returns RD value in Q25.
/// `NLSFIndices`: codebook path vector [ LPC_ORDER + 1 ] (O); `pNLSF_Q15`: (un)quantized NLSF
/// vector [ LPC_ORDER ] (I/O); `psNLSF_CB`: codebook object; `pW_Q2`: NLSF weight vector
/// [ LPC_ORDER ]; `NLSF_mu_Q20`: rate weight for the RD optimization; `nSurvivors`: max
/// survivors after first stage; `signalType`: signal type: 0/1/2.
pub fn silk_NLSF_encode(
    NLSFIndices: &mut [i8],
    pNLSF_Q15: &mut [i16],
    psNLSF_CB: &silk_NLSF_CB_struct,
    pW_Q2: &[i16],
    NLSF_mu_Q20: i32,
    nSurvivors: i32,
    signalType: i32,
) -> i32 {
    let mut res_Q10 = [0i16; MAX_LPC_ORDER as usize];
    let mut NLSF_tmp_Q15 = [0i16; MAX_LPC_ORDER as usize];
    let mut W_adj_Q5 = [0i16; MAX_LPC_ORDER as usize];
    let mut pred_Q8 = [0u8; MAX_LPC_ORDER as usize];
    let mut ec_ix = [0i16; MAX_LPC_ORDER as usize];
    let order = psNLSF_CB.order as i32;
    let nVectors = psNLSF_CB.nVectors as i32;
    let st = stack::save();

    debug_assert!(signalType >= 0 && signalType <= 2);
    debug_assert!(NLSF_mu_Q20 <= 32767 && NLSF_mu_Q20 >= 0);

    /* NLSF stabilization */
    silk_NLSF_stabilize(pNLSF_Q15, unsafe { core::slice::from_raw_parts(psNLSF_CB.deltaMin_Q15, order as usize + 1) }, order);

    unsafe {
        let CB1_NLSF_Q8 = core::slice::from_raw_parts(psNLSF_CB.CB1_NLSF_Q8, (nVectors * order) as usize);
        let CB1_Wght_Q9 = core::slice::from_raw_parts(psNLSF_CB.CB1_Wght_Q9, (nVectors * order) as usize);

        /* First stage: VQ */
        let err_Q24 = st.alloc::<i32>(nVectors as usize);
        silk_NLSF_VQ(err_Q24, pNLSF_Q15, CB1_NLSF_Q8, CB1_Wght_Q9, nVectors, order);

        /* Sort the quantization errors */
        let tempIndices1 = st.alloc::<i32>(nSurvivors as usize);
        silk_insertion_sort_increasing(err_Q24, tempIndices1, nVectors, nSurvivors);

        let RD_Q25 = st.alloc::<i32>(nSurvivors as usize);
        let tempIndices2 = st.alloc::<i8>(nSurvivors as usize * MAX_LPC_ORDER as usize);

        /* Loop over survivors */
        for s in 0..nSurvivors as usize {
            let ind1 = tempIndices1[s];

            /* Residual after first stage */
            let pCB_element = &CB1_NLSF_Q8[(ind1 * order) as usize..];
            let pCB_Wght_Q9 = &CB1_Wght_Q9[(ind1 * order) as usize..];
            for i in 0..order as usize {
                NLSF_tmp_Q15[i] = ((pCB_element[i] as i16) << 7) as i16; /* silk_LSHIFT16 */
                let W_tmp_Q9 = pCB_Wght_Q9[i] as i32;
                res_Q10[i] =
                    silk_RSHIFT(silk_SMULBB(pNLSF_Q15[i] as i32 - NLSF_tmp_Q15[i] as i32, W_tmp_Q9), 14) as i16;
                W_adj_Q5[i] = silk_DIV32_varQ(pW_Q2[i] as i32, silk_SMULBB(W_tmp_Q9, W_tmp_Q9), 21) as i16;
            }

            /* Unpack entropy table indices and predictor for current CB1 index */
            silk_NLSF_unpack(&mut ec_ix, &mut pred_Q8, psNLSF_CB, ind1);

            /* Trellis quantizer */
            RD_Q25[s] = silk_NLSF_del_dec_quant(
                &mut tempIndices2[s * MAX_LPC_ORDER as usize..],
                &res_Q10,
                &W_adj_Q5,
                &pred_Q8,
                &ec_ix,
                core::slice::from_raw_parts(psNLSF_CB.ec_Rates_Q5, 72),
                psNLSF_CB.quantStepSize_Q16 as i32,
                psNLSF_CB.invQuantStepSize_Q6,
                NLSF_mu_Q20,
                psNLSF_CB.order,
            );

            /* Add rate for first stage */
            let iCDF_ptr = psNLSF_CB.CB1_iCDF.add(((signalType >> 1) * nVectors) as usize);
            let prob_Q8: i32 = if ind1 == 0 {
                256 - *iCDF_ptr.add(ind1 as usize) as i32
            } else {
                *iCDF_ptr.add(ind1 as usize - 1) as i32 - *iCDF_ptr.add(ind1 as usize) as i32
            };
            let bits_q7 = (8 << 7) - silk_lin2log(prob_Q8);
            RD_Q25[s] = silk_SMLABB(RD_Q25[s], bits_q7, silk_RSHIFT(NLSF_mu_Q20, 2));
        }

        /* Find the lowest rate-distortion error */
        let mut bestIndex = [0i32; 1];
        silk_insertion_sort_increasing(RD_Q25, &mut bestIndex, nSurvivors, 1);
        let bestIndex = bestIndex[0] as usize;

        NLSFIndices[0] = tempIndices1[bestIndex] as i8;
        NLSFIndices[1..1 + order as usize]
            .copy_from_slice(&tempIndices2[bestIndex * MAX_LPC_ORDER as usize..][..order as usize]);

        /* Decode */
        silk_NLSF_decode(pNLSF_Q15, NLSFIndices, psNLSF_CB);

        RD_Q25[0]
    }
}

#[cfg(test)]
mod tests {
    use crate::silk::NLSF2A::tests::random_nlsf;
    use crate::silk::NLSF_VQ_weights_laroia::silk_NLSF_VQ_weights_laroia;
    use crate::silk::structs::silk_NLSF_CB_struct;
    use crate::silk::tables::silk_NLSF_CB_WB;
    use crate::testutil::Rng;
    mod c {
        use crate::silk::structs::silk_NLSF_CB_struct;
        unsafe extern "C" {
            pub fn silk_NLSF_encode(
                NLSFIndices: *mut i8,
                pNLSF_Q15: *mut i16,
                psNLSF_CB: *const silk_NLSF_CB_struct,
                pW_Q2: *const i16,
                NLSF_mu_Q20: i32,
                nSurvivors: i32,
                signalType: i32,
            ) -> i32;
        }
    }

    pub(crate) fn run(nlsf: &[i16; 16], mu: i32, surv: i32, sig: i32) {
        let mut w = [0i16; 16];
        silk_NLSF_VQ_weights_laroia(&mut w, nlsf, 16);
        let (mut n1, mut n2) = (*nlsf, *nlsf);
        let (mut i1, mut i2) = ([0i8; 17], [0i8; 17]);
        let r1 = super::silk_NLSF_encode(&mut i1, &mut n1, &silk_NLSF_CB_WB, &w, mu, surv, sig);
        let r2 = unsafe {
            c::silk_NLSF_encode(i2.as_mut_ptr(), n2.as_mut_ptr(), &silk_NLSF_CB_WB as *const silk_NLSF_CB_struct, w.as_ptr(), mu, surv, sig)
        };
        assert_eq!(r1, r2, "RD nlsf={nlsf:?} mu={mu} surv={surv} sig={sig}");
        assert_eq!(i1, i2, "indices nlsf={nlsf:?} mu={mu} surv={surv} sig={sig}");
        assert_eq!(n1, n2, "NLSF out nlsf={nlsf:?} mu={mu} surv={surv} sig={sig}");
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(90);
        for t in 0..3000 {
            let nlsf = random_nlsf(&mut rng);
            // NLSF_mu_Q20 is 0.003 - 0.0015*activity in Q20, i.e. ~1573..3146 (up to 5243);
            // NLSF_MSVQ_Survivors is 2..16 depending on complexity.
            let mu = rng.range(1500, 5243);
            let surv = [2, 3, 4, 6, 8, 16, 32][t % 7];
            run(&nlsf, mu, surv, rng.range(0, 2));
        }
    }

    /// Unstabilized NLSF input, as A2NLSF produces on slightly bad filters: valid vectors with
    /// a few elements pushed too close together or to the borders.
    #[test]
    fn unstable_input_matches_c() {
        let mut rng = Rng::new(91);
        for t in 0..2000 {
            let mut n = random_nlsf(&mut rng);
            match t % 4 {
                0 => {
                    let i = rng.range(1, 15) as usize;
                    n[i] = (n[i - 1] as i32 + rng.range(12, 30)) as i16;
                }
                1 => n[0] = rng.range(12, 40) as i16,
                2 => n[15] = rng.range(32700, 32750) as i16,
                _ => {
                    let i = rng.range(1, 15) as usize;
                    n[i] = (n[i - 1] as i32 + rng.range(12, 40)).clamp(0, 32767) as i16;
                    n[0] = rng.range(12, 60) as i16;
                }
            }
            run(&n, rng.range(1500, 5243), [2, 4, 16][t % 3], rng.range(0, 2));
        }
    }
}
