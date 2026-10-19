//! Port of silk/NLSF_VQ.c.

use crate::silk::macros::*;

/// Compute quantization errors for an LPC_order element input vector for a VQ codebook.
/// `err_Q24`: quantization errors [K] (O); `in_Q15`: input vectors to be quantized [LPC_order];
/// `pCB_Q8`: codebook vectors [K*LPC_order]; `pWght_Q9`: codebook weights [K*LPC_order];
/// `K`: number of codebook vectors; `LPC_order`: number of LPCs.
pub fn silk_NLSF_VQ(err_Q24: &mut [i32], in_Q15: &[i16], pCB_Q8: &[u8], pWght_Q9: &[i16], K: i32, LPC_order: i32) {
    debug_assert!((LPC_order & 1) == 0);

    /* Loop over codebook */
    let mut cb_Q8_ptr = 0usize;
    let mut w_Q9_ptr = 0usize;
    for i in 0..K as usize {
        let mut sum_error_Q24: i32 = 0;
        let mut pred_Q24: i32 = 0;
        let mut m = LPC_order - 2;
        while m >= 0 {
            let mu = m as usize;
            /* Compute weighted absolute predictive quantization error for index m + 1 */
            let mut diff_Q15 = silk_SUB_LSHIFT32(in_Q15[mu + 1] as i32, pCB_Q8[cb_Q8_ptr + mu + 1] as i32, 7); /* range: [ -32767 : 32767 ]*/
            let mut diffw_Q24 = silk_SMULBB(diff_Q15, pWght_Q9[w_Q9_ptr + mu + 1] as i32);
            sum_error_Q24 = silk_ADD32(sum_error_Q24, silk_abs!(silk_SUB_RSHIFT32(diffw_Q24, pred_Q24, 1)));
            pred_Q24 = diffw_Q24;

            /* Compute weighted absolute predictive quantization error for index m */
            diff_Q15 = silk_SUB_LSHIFT32(in_Q15[mu] as i32, pCB_Q8[cb_Q8_ptr + mu] as i32, 7); /* range: [ -32767 : 32767 ]*/
            diffw_Q24 = silk_SMULBB(diff_Q15, pWght_Q9[w_Q9_ptr + mu] as i32);
            sum_error_Q24 = silk_ADD32(sum_error_Q24, silk_abs!(silk_SUB_RSHIFT32(diffw_Q24, pred_Q24, 1)));
            pred_Q24 = diffw_Q24;

            debug_assert!(sum_error_Q24 >= 0);
            m -= 2;
        }
        err_Q24[i] = sum_error_Q24;
        cb_Q8_ptr += LPC_order as usize;
        w_Q9_ptr += LPC_order as usize;
    }
}
