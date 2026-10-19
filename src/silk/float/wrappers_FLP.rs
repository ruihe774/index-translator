//! Port of silk/float/wrappers_FLP.c.

use crate::silk::A2NLSF::silk_A2NLSF;
use crate::silk::NLSF2A::silk_NLSF2A;
use crate::silk::NSQ::silk_NSQ;
use crate::silk::NSQ_del_dec::silk_NSQ_del_dec;
use crate::silk::define::*;
use crate::silk::float::sigproc_flp::silk_float2int;
use crate::silk::float::structs_flp::{silk_encoder_control_FLP, silk_encoder_state_FLP};
use crate::silk::macros::*;
use crate::silk::process_NLSFs::silk_process_NLSFs;
use crate::silk::quant_LTP_gains::silk_quant_LTP_gains;
use crate::silk::structs::{SideInfoIndices, silk_encoder_state, silk_nsq_state};
use crate::silk::tables::silk_LTPScales_table_Q14;

const MAX_LPC_ORDER_: usize = MAX_LPC_ORDER as usize;
const MAX_NB_SUBFR_: usize = MAX_NB_SUBFR as usize;
const LTP_ORDER_: usize = LTP_ORDER as usize;
const MAX_SHAPE_LPC_ORDER_: usize = MAX_SHAPE_LPC_ORDER as usize;

/* Wrappers. Calls flp / fix code */

/// Convert AR filter coefficients to NLSF parameters
pub fn silk_A2NLSF_FLP(
    NLSF_Q15: &mut [i16], /* O    NLSF vector      [ LPC_order ]              */
    pAR: &[f32],          /* I    LPC coefficients [ LPC_order ]              */
    LPC_order: i32,       /* I    LPC order                                   */
) {
    let mut a_fix_Q16 = [0i32; MAX_LPC_ORDER_];

    for i in 0..LPC_order as usize {
        a_fix_Q16[i] = silk_float2int(pAR[i] * 65536.0f32);
    }

    silk_A2NLSF(NLSF_Q15, &mut a_fix_Q16, LPC_order);
}

/// Convert LSF parameters to AR prediction filter coefficients
pub fn silk_NLSF2A_FLP(
    pAR: &mut [f32],   /* O    LPC coefficients [ LPC_order ]              */
    NLSF_Q15: &[i16],  /* I    NLSF vector      [ LPC_order ]              */
    LPC_order: i32,    /* I    LPC order                                   */
) {
    let mut a_fix_Q12 = [0i16; MAX_LPC_ORDER_];

    silk_NLSF2A(&mut a_fix_Q12, NLSF_Q15, LPC_order);

    for i in 0..LPC_order as usize {
        pAR[i] = a_fix_Q12[i] as f32 * (1.0f32 / 4096.0f32);
    }
}

/// Floating-point NLSF processing wrapper
pub fn silk_process_NLSFs_FLP(
    psEncC: &mut silk_encoder_state,              /* I/O  Encoder state                               */
    PredCoef: &mut [[f32; MAX_LPC_ORDER_]; 2],    /* O    Prediction coefficients                     */
    NLSF_Q15: &mut [i16],                         /* I/O  Normalized LSFs (quant out) (0 - (2^15-1))  */
    prev_NLSF_Q15: &[i16],                        /* I    Previous Normalized LSFs (0 - (2^15-1))     */
) {
    let mut PredCoef_Q12 = [[0i16; MAX_LPC_ORDER_]; 2];

    silk_process_NLSFs(psEncC, &mut PredCoef_Q12, NLSF_Q15, prev_NLSF_Q15);

    for j in 0..2 {
        for i in 0..psEncC.predictLPCOrder as usize {
            PredCoef[j][i] = PredCoef_Q12[j][i] as f32 * (1.0f32 / 4096.0f32);
        }
    }
}

/// Floating-point Silk NSQ wrapper.
///
/// # Safety
/// As in C, `psIndices`, `psNSQ`, `pulses` and `x` may point into `*psEnc` (they do in
/// silk_encode_frame_FLP); all must be valid: `pulses` for frame_length writes, `x` for
/// frame_length reads.
pub unsafe fn silk_NSQ_wrapper_FLP(
    psEnc: *mut silk_encoder_state_FLP,          /* I/O  Encoder state FLP                           */
    psEncCtrl: *const silk_encoder_control_FLP,  /* I/O  Encoder control FLP                         */
    psIndices: *mut SideInfoIndices,             /* I/O  Quantization indices                        */
    psNSQ: *mut silk_nsq_state,                  /* I/O  Noise Shaping Quantzation state             */
    pulses: *mut i8,                             /* O    Quantized pulse signal                      */
    x: *const f32,                               /* I    Prefiltered input signal                    */
) {
    unsafe {
        let mut x16 = [0i16; MAX_FRAME_LENGTH as usize];
        let mut Gains_Q16 = [0i32; MAX_NB_SUBFR_];
        let mut PredCoef_Q12 = [[0i16; MAX_LPC_ORDER_]; 2];
        let mut LTPCoef_Q14 = [0i16; LTP_ORDER_ * MAX_NB_SUBFR_];

        /* Noise shaping parameters */
        let mut AR_Q13 = [0i16; MAX_NB_SUBFR_ * MAX_SHAPE_LPC_ORDER_];
        let mut LF_shp_Q14 = [0i32; MAX_NB_SUBFR_]; /* Packs two int16 coefficients per int32 value             */
        let mut Tilt_Q14 = [0i32; MAX_NB_SUBFR_];
        let mut HarmShapeGain_Q14 = [0i32; MAX_NB_SUBFR_];

        let psEncC: *const silk_encoder_state = core::ptr::addr_of!((*psEnc).sCmn);
        let nb_subfr = (*psEncC).nb_subfr as usize;
        let psEncCtrl = &*psEncCtrl;

        /* Convert control struct to fix control struct */
        /* Noise shape parameters */
        for i in 0..nb_subfr {
            for j in 0..(*psEncC).shapingLPCOrder as usize {
                AR_Q13[i * MAX_SHAPE_LPC_ORDER_ + j] =
                    silk_float2int(psEncCtrl.AR[i * MAX_SHAPE_LPC_ORDER_ + j] * 8192.0f32) as i16;
            }
        }

        for i in 0..nb_subfr {
            LF_shp_Q14[i] = silk_LSHIFT32(silk_float2int(psEncCtrl.LF_AR_shp[i] * 16384.0f32), 16)
                | silk_float2int(psEncCtrl.LF_MA_shp[i] * 16384.0f32) as u16 as i32;
            Tilt_Q14[i] = silk_float2int(psEncCtrl.Tilt[i] * 16384.0f32);
            HarmShapeGain_Q14[i] = silk_float2int(psEncCtrl.HarmShapeGain[i] * 16384.0f32);
        }
        let Lambda_Q10 = silk_float2int(psEncCtrl.Lambda * 1024.0f32);

        /* prediction and coding parameters */
        for i in 0..nb_subfr * LTP_ORDER_ {
            LTPCoef_Q14[i] = silk_float2int(psEncCtrl.LTPCoef[i] * 16384.0f32) as i16;
        }

        for j in 0..2 {
            for i in 0..(*psEncC).predictLPCOrder as usize {
                PredCoef_Q12[j][i] = silk_float2int(psEncCtrl.PredCoef[j][i] * 4096.0f32) as i16;
            }
        }

        for i in 0..nb_subfr {
            Gains_Q16[i] = silk_float2int(psEncCtrl.Gains[i] * 65536.0f32);
            debug_assert!(Gains_Q16[i] > 0);
        }

        let LTP_scale_Q14 = if (*psIndices).signalType as i32 == TYPE_VOICED {
            silk_LTPScales_table_Q14[(*psIndices).LTP_scaleIndex as usize] as i32
        } else {
            0
        };

        /* Convert input to fix */
        for i in 0..(*psEncC).frame_length as usize {
            x16[i] = silk_float2int(*x.add(i)) as i16;
        }

        /* PredCoef_Q12[ 0 ] in C, read as [ 2 * MAX_LPC_ORDER ] */
        let PredCoef_flat: &[i16] = core::slice::from_raw_parts(PredCoef_Q12.as_ptr() as *const i16, 2 * MAX_LPC_ORDER_);

        /* Call NSQ */
        if (*psEncC).nStatesDelayedDecision > 1 || (*psEncC).warping_Q16 > 0 {
            silk_NSQ_del_dec(
                psEncC,
                psNSQ,
                psIndices,
                &x16,
                pulses,
                PredCoef_flat,
                &LTPCoef_Q14,
                &AR_Q13,
                &HarmShapeGain_Q14,
                &Tilt_Q14,
                &LF_shp_Q14,
                &Gains_Q16,
                &psEncCtrl.pitchL,
                Lambda_Q10,
                LTP_scale_Q14,
            );
        } else {
            silk_NSQ(
                psEncC,
                psNSQ,
                psIndices,
                &x16,
                pulses,
                PredCoef_flat,
                &LTPCoef_Q14,
                &AR_Q13,
                &HarmShapeGain_Q14,
                &Tilt_Q14,
                &LF_shp_Q14,
                &Gains_Q16,
                &psEncCtrl.pitchL,
                Lambda_Q10,
                LTP_scale_Q14,
            );
        }
    }
}

/// Floating-point Silk LTP quantiation wrapper
pub fn silk_quant_LTP_gains_FLP(
    B: &mut [f32; MAX_NB_SUBFR_ * LTP_ORDER_], /* O    Quantized LTP gains                         */
    cbk_index: &mut [i8; MAX_NB_SUBFR_],       /* O    Codebook index                              */
    periodicity_index: &mut i8,                /* O    Periodicity index                           */
    sum_log_gain_Q7: &mut i32,                 /* I/O  Cumulative max prediction gain              */
    pred_gain_dB: &mut f32,                    /* O    LTP prediction gain                         */
    XX: &[f32],                                /* I    Correlation matrix [ MAX_NB_SUBFR * LTP_ORDER * LTP_ORDER ] */
    xX: &[f32],                                /* I    Correlation vector [ MAX_NB_SUBFR * LTP_ORDER ] */
    subfr_len: i32,                            /* I    Number of samples per subframe              */
    nb_subfr: i32,                             /* I    Number of subframes                         */
) {
    let mut pred_gain_dB_Q7 = 0i32;
    let mut B_Q14 = [0i16; MAX_NB_SUBFR_ * LTP_ORDER_];
    let mut XX_Q17 = [0i32; MAX_NB_SUBFR_ * LTP_ORDER_ * LTP_ORDER_];
    let mut xX_Q17 = [0i32; MAX_NB_SUBFR_ * LTP_ORDER_];

    let nb_subfr_ = nb_subfr as usize;
    for i in 0..nb_subfr_ * LTP_ORDER_ * LTP_ORDER_ {
        XX_Q17[i] = silk_float2int(XX[i] * 131072.0f32);
    }
    for i in 0..nb_subfr_ * LTP_ORDER_ {
        xX_Q17[i] = silk_float2int(xX[i] * 131072.0f32);
    }

    silk_quant_LTP_gains(
        &mut B_Q14,
        cbk_index,
        periodicity_index,
        sum_log_gain_Q7,
        &mut pred_gain_dB_Q7,
        &XX_Q17,
        &xX_Q17,
        subfr_len,
        nb_subfr,
    );

    for i in 0..nb_subfr_ * LTP_ORDER_ {
        B[i] = B_Q14[i] as f32 * (1.0f32 / 16384.0f32);
    }

    *pred_gain_dB = pred_gain_dB_Q7 as f32 * (1.0f32 / 128.0f32);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::silk::float::encode_frame_FLP::tests::{c, for_each_frame, same_state};
    use crate::testutil::Rng;

    #[test]
    fn A2NLSF_NLSF2A_match_c() {
        let mut rng = Rng::new(61);
        for it in 0..3000 {
            let d = if it % 2 == 0 { 16 } else { 10 };
            let a_Q12 = crate::silk::NLSF2A::tests::random_stable_a_Q12(&mut rng, d);
            let a: std::vec::Vec<f32> = a_Q12.iter().map(|&v| v as f32 / 4096.0 * (1.0 + rng.f32_unit() * 1e-3)).collect();
            let (mut n_r, mut n_c) = ([0i16; 16], [0i16; 16]);
            silk_A2NLSF_FLP(&mut n_r, &a, d as i32);
            unsafe { c::silk_A2NLSF_FLP(n_c.as_mut_ptr(), a.as_ptr(), d as i32) };
            assert_eq!(n_r, n_c, "it {it}");
            let (mut a_r, mut a_c) = ([0f32; 16], [0f32; 16]);
            silk_NLSF2A_FLP(&mut a_r, &n_r, d as i32);
            unsafe { c::silk_NLSF2A_FLP(a_c.as_mut_ptr(), n_c.as_ptr(), d as i32, 0) };
            assert_eq!(a_r.map(f32::to_bits), a_c.map(f32::to_bits), "it {it}");
        }
    }

    #[test]
    fn quant_LTP_gains_FLP_matches_c() {
        let mut rng = Rng::new(62);
        for it in 0..2000 {
            let (XX_Q17, xX_Q17) = crate::silk::quant_LTP_gains::tests::random_corr(&mut rng);
            let XX: std::vec::Vec<f32> = XX_Q17.iter().map(|&v| v as f32 / 131072.0 * (1.0 + rng.f32_unit() * 1e-4)).collect();
            let xX: std::vec::Vec<f32> = xX_Q17.iter().map(|&v| v as f32 / 131072.0 * (1.0 + rng.f32_unit() * 1e-4)).collect();
            let s0 = rng.range(0, 5000);
            let (mut B_r, mut B_c) = ([0f32; 20], [0f32; 20]);
            let (mut ci_r, mut ci_c) = ([0i8; 4], [0i8; 4]);
            let (mut p_r, mut p_c) = (0i8, 0i8);
            let (mut s_r, mut s_c) = (s0, s0);
            let (mut g_r, mut g_c) = (0f32, 0f32);
            silk_quant_LTP_gains_FLP(&mut B_r, &mut ci_r, &mut p_r, &mut s_r, &mut g_r, &XX, &xX, 80, 4);
            unsafe {
                c::silk_quant_LTP_gains_FLP(
                    B_c.as_mut_ptr(), ci_c.as_mut_ptr(), &mut p_c, &mut s_c, &mut g_c, XX.as_ptr(), xX.as_ptr(), 80, 4, 0,
                )
            };
            assert_eq!(B_r.map(f32::to_bits), B_c.map(f32::to_bits), "it {it}");
            assert_eq!((ci_r, p_r, s_r, g_r.to_bits()), (ci_c, p_c, s_c, g_c.to_bits()), "it {it}");
        }
    }

    #[test]
    fn process_NLSFs_FLP_matches_c() {
        for_each_frame(|fr, what| {
            let mut fr = fr.clone();
            c::find_pitch_lags(&mut fr);
            c::noise_shape_analysis(&mut fr);
            // NLSFs from a full-frame LPC analysis of the frame, as find_pred_coefs computes them.
            let mut nlsf = [0i16; 16];
            let order = fr.st.sCmn.predictLPCOrder;
            let mut a = [0f32; 16];
            let off = fr.st.sCmn.ltp_mem_length as usize - order as usize;
            unsafe {
                c::silk_burg_modified_FLP(
                    a.as_mut_ptr(), fr.st.x_buf.as_ptr().add(off), 1e-4, 80 + order, 4, order, 0,
                );
                c::silk_A2NLSF_FLP(nlsf.as_mut_ptr(), a.as_ptr(), order);
            }
            for interp in [4, 2] {
                let mut r = fr.clone();
                let mut cc = fr.clone();
                r.st.sCmn.indices.NLSFInterpCoef_Q2 = if r.st.sCmn.useInterpolatedNLSFs != 0 { interp } else { 4 };
                cc.st.sCmn.indices.NLSFInterpCoef_Q2 = r.st.sCmn.indices.NLSFInterpCoef_Q2;
                let (mut n_r, mut n_c) = (nlsf, nlsf);
                let prev = r.st.sCmn.prev_NLSFq_Q15;
                silk_process_NLSFs_FLP(&mut r.st.sCmn, &mut r.ctrl.PredCoef, &mut n_r, &prev);
                unsafe {
                    c::silk_process_NLSFs_FLP(&mut cc.st.sCmn, cc.ctrl.PredCoef.as_mut_ptr(), n_c.as_mut_ptr(), prev.as_ptr())
                };
                assert_eq!(n_r, n_c, "{what}");
                assert_eq!(r.ctrl.PredCoef.map(|v| v.map(f32::to_bits)), cc.ctrl.PredCoef.map(|v| v.map(f32::to_bits)), "{what}");
                same_state(&r.st, &cc.st, what);
            }
        });
    }

    #[test]
    fn NSQ_wrapper_FLP_matches_c() {
        for_each_frame(|fr, what| {
            let mut fr = fr.clone();
            c::find_pitch_lags(&mut fr);
            c::noise_shape_analysis(&mut fr);
            c::find_pred_coefs(&mut fr, 0);
            c::process_gains(&mut fr, 0);
            let mut r = fr.clone();
            let mut cc = fr.clone();
            let off = fr.st.sCmn.ltp_mem_length as usize;
            unsafe {
                let p = &mut *r.st as *mut silk_encoder_state_FLP;
                silk_NSQ_wrapper_FLP(
                    p,
                    &r.ctrl,
                    core::ptr::addr_of_mut!((*p).sCmn.indices),
                    core::ptr::addr_of_mut!((*p).sCmn.sNSQ),
                    core::ptr::addr_of_mut!((*p).sCmn.pulses) as *mut i8,
                    core::ptr::addr_of!((*p).x_buf).cast::<f32>().add(off),
                );
                let p = &mut *cc.st as *mut silk_encoder_state_FLP;
                c::silk_NSQ_wrapper_FLP(
                    p,
                    &mut cc.ctrl,
                    core::ptr::addr_of_mut!((*p).sCmn.indices),
                    core::ptr::addr_of_mut!((*p).sCmn.sNSQ),
                    core::ptr::addr_of_mut!((*p).sCmn.pulses) as *mut i8,
                    core::ptr::addr_of!((*p).x_buf).cast::<f32>().add(off),
                );
            }
            same_state(&r.st, &cc.st, what);
        });
    }
}
