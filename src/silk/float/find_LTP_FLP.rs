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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::silk::float::encode_frame_FLP::tests::{c, for_each_frame};
    use crate::testutil::Rng;

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(71);
        let mut n = 0;
        for_each_frame(|fr, what| {
            let mut fr = fr.clone();
            c::find_pitch_lags(&mut fr);
            let off = fr.st.sCmn.ltp_mem_length as usize;
            let mut lags = fr.ctrl.pitchL;
            if fr.st.sCmn.indices.signalType as i32 != TYPE_VOICED {
                // Unvoiced frame: random lags in the encoder's range.
                lags = core::array::from_fn(|_| rng.range(32, 288 - 3));
            } else {
                n += 1;
            }
            let (mut XX_r, mut XX_c) = ([0f32; 100], [0f32; 100]);
            let (mut xX_r, mut xX_c) = ([0f32; 20], [0f32; 20]);
            silk_find_LTP_FLP(&mut XX_r, &mut xX_r, &fr.res_pitch, off, &lags, 80, 4);
            unsafe {
                c::silk_find_LTP_FLP(XX_c.as_mut_ptr(), xX_c.as_mut_ptr(), fr.res_pitch.as_ptr().add(off), lags.as_ptr(), 80, 4, 0)
            };
            assert_eq!(XX_r.map(f32::to_bits), XX_c.map(f32::to_bits), "{what}");
            assert_eq!(xX_r.map(f32::to_bits), xX_c.map(f32::to_bits), "{what}");
        });
        assert!(n > 50, "{n} voiced frames");
    }
}
