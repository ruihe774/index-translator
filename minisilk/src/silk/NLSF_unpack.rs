//! Port of silk/NLSF_unpack.c.

use crate::silk::define::*;
use crate::silk::macros::*;
use crate::silk::structs::silk_NLSF_CB_struct;

/// Unpack predictor values and indices for entropy coding tables.
/// `ec_ix`: indices to entropy tables [ LPC_ORDER ] (O); `pred_Q8`: LSF predictor [ LPC_ORDER ] (O);
/// `psNLSF_CB`: codebook object; `CB1_index`: index of vector in first LSF codebook.
pub fn silk_NLSF_unpack(ec_ix: &mut [i16], pred_Q8: &mut [u8], psNLSF_CB: &silk_NLSF_CB_struct, CB1_index: i32) {
    let order = psNLSF_CB.order as i32;
    unsafe {
        let mut ec_sel_ptr = psNLSF_CB.ec_sel.add((CB1_index * order / 2) as usize);
        let mut i = 0;
        while i < order {
            let entry = *ec_sel_ptr as i32;
            ec_sel_ptr = ec_sel_ptr.add(1);
            ec_ix[i as usize] = silk_SMULBB(silk_RSHIFT(entry, 1) & 7, 2 * NLSF_QUANT_MAX_AMPLITUDE + 1) as i16;
            pred_Q8[i as usize] = *psNLSF_CB.pred_Q8.add((i + (entry & 1) * (order - 1)) as usize);
            ec_ix[i as usize + 1] = silk_SMULBB(silk_RSHIFT(entry, 5) & 7, 2 * NLSF_QUANT_MAX_AMPLITUDE + 1) as i16;
            pred_Q8[i as usize + 1] =
                *psNLSF_CB.pred_Q8.add((i + (silk_RSHIFT(entry, 4) & 1) * (order - 1) + 1) as usize);
            i += 2;
        }
    }
}
