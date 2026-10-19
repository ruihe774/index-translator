//! Port of silk/float/residual_energy_FLP.c.

use crate::silk::define::*;
use crate::silk::float::LPC_analysis_filter_FLP::silk_LPC_analysis_filter_FLP;
use crate::silk::float::energy_FLP::silk_energy_FLP;

/// Calculates residual energies of input subframes where all subframes have LPC_order
/// of preceding samples
pub fn silk_residual_energy_FLP(
    nrgs: &mut [f32],                         /* O    Residual energy per subframe [MAX_NB_SUBFR] */
    x: &[f32],                                /* I    Input signal                                */
    a: &[[f32; MAX_LPC_ORDER as usize]; 2],   /* I    AR coefs for each frame half                */
    gains: &[f32],                            /* I    Quantization gains                          */
    subfr_length: i32,                        /* I    Subframe length                             */
    LPC_order: i32,                           /* I    LPC order                                   */
) {
    let mut LPC_res = [0f32; ((MAX_FRAME_LENGTH + MAX_NB_SUBFR * MAX_LPC_ORDER) / 2) as usize];

    let LPC_res_ptr = LPC_order as usize;
    let shift = LPC_order + subfr_length;
    let sh = shift as usize;

    /* Filter input to create the LPC residual for each frame half, and measure subframe energies */
    silk_LPC_analysis_filter_FLP(&mut LPC_res, &a[0], &x[0 * sh..], 2 * shift, LPC_order);
    nrgs[0] = ((gains[0] * gains[0]) as f64 * silk_energy_FLP(&LPC_res[LPC_res_ptr + 0 * sh..], subfr_length)) as f32;
    nrgs[1] = ((gains[1] * gains[1]) as f64 * silk_energy_FLP(&LPC_res[LPC_res_ptr + 1 * sh..], subfr_length)) as f32;

    silk_LPC_analysis_filter_FLP(&mut LPC_res, &a[1], &x[2 * sh..], 2 * shift, LPC_order);
    nrgs[2] = ((gains[2] * gains[2]) as f64 * silk_energy_FLP(&LPC_res[LPC_res_ptr + 0 * sh..], subfr_length)) as f32;
    nrgs[3] = ((gains[3] * gains[3]) as f64 * silk_energy_FLP(&LPC_res[LPC_res_ptr + 1 * sh..], subfr_length)) as f32;
}
