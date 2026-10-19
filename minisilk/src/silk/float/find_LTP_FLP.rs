//! Port of silk/float/find_LTP_FLP.c.

use crate::silk::define::*;
use crate::silk::float::corrMatrix_FLP::{silk_corrMatrix_FLP, silk_corrVector_FLP};
use crate::silk::float::energy_FLP::silk_energy_FLP;
use crate::silk::float::scale_vector_FLP::silk_scale_vector_FLP;
use crate::silk::macros::*;
use crate::silk::tuning_parameters::*;

const LTP_ORDER_: usize = LTP_ORDER as usize;

/// The LPC residual `r_ptr` of C is `&r[r_off..]`; it is read from `r_off - (lag + LTP_ORDER / 2)`.
pub fn silk_find_LTP_FLP(
    XX: &mut [f32; (MAX_NB_SUBFR * LTP_ORDER * LTP_ORDER) as usize], /* O    Weight for LTP quantization         */
    xX: &mut [f32; (MAX_NB_SUBFR * LTP_ORDER) as usize],             /* O    Weight for LTP quantization                 */
    r: &[f32],                                                       /* I    LPC residual                                */
    r_off: usize,                                                    /* I    Start of the residual of the frame: r_ptr   */
    lag: &[i32],                                                     /* I    LTP lags [ MAX_NB_SUBFR ]                   */
    subfr_length: i32,                                               /* I    Subframe length                             */
    nb_subfr: i32,                                                   /* I    number of subframes                         */
) {
    let mut r_ptr = r_off;
    let mut xX_ptr = 0usize;
    let mut XX_ptr = 0usize;
    for k in 0..nb_subfr as usize {
        let lag_ptr = r_ptr - (lag[k] + LTP_ORDER / 2) as usize;
        silk_corrMatrix_FLP(&r[lag_ptr..], subfr_length, LTP_ORDER, &mut XX[XX_ptr..XX_ptr + LTP_ORDER_ * LTP_ORDER_]);
        silk_corrVector_FLP(&r[lag_ptr..], &r[r_ptr..], subfr_length, LTP_ORDER, &mut xX[xX_ptr..xX_ptr + LTP_ORDER_]);
        let xx = silk_energy_FLP(&r[r_ptr..], subfr_length + LTP_ORDER) as f32;
        let temp = 1.0f32 / silk_max!(xx, LTP_CORR_INV_MAX * 0.5f32 * (XX[XX_ptr] + XX[XX_ptr + 24]) + 1.0f32);
        silk_scale_vector_FLP(&mut XX[XX_ptr..], temp, LTP_ORDER * LTP_ORDER);
        silk_scale_vector_FLP(&mut xX[xX_ptr..], temp, LTP_ORDER);

        r_ptr += subfr_length as usize;
        XX_ptr += LTP_ORDER_ * LTP_ORDER_;
        xX_ptr += LTP_ORDER_;
    }
}
