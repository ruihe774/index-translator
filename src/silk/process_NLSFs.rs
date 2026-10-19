//! Port of silk/process_NLSFs.c.

use crate::silk::NLSF2A::silk_NLSF2A;
use crate::silk::NLSF_VQ_weights_laroia::silk_NLSF_VQ_weights_laroia;
use crate::silk::NLSF_encode::silk_NLSF_encode;
use crate::silk::define::*;
use crate::silk::interpolate::silk_interpolate;
use crate::silk::macros::*;
use crate::silk::structs::silk_encoder_state;

/// Limit, stabilize, convert and quantize NLSFs.
/// `psEncC`: encoder state (I/O); `PredCoef_Q12`: prediction coefficients (O);
/// `pNLSF_Q15`: normalized LSFs (quant out) (0 - (2^15-1)) [MAX_LPC_ORDER] (I/O);
/// `prev_NLSFq_Q15`: previous normalized LSFs (0 - (2^15-1)) [MAX_LPC_ORDER] (I).
pub fn silk_process_NLSFs(
    psEncC: &mut silk_encoder_state,
    PredCoef_Q12: &mut [[i16; MAX_LPC_ORDER as usize]; 2],
    pNLSF_Q15: &mut [i16],
    prev_NLSFq_Q15: &[i16],
) {
    let mut pNLSF0_temp_Q15 = [0i16; MAX_LPC_ORDER as usize];
    let mut pNLSFW_QW = [0i16; MAX_LPC_ORDER as usize];
    let mut pNLSFW0_temp_QW = [0i16; MAX_LPC_ORDER as usize];

    debug_assert!(psEncC.speech_activity_Q8 >= 0);
    debug_assert!(psEncC.speech_activity_Q8 <= SILK_FIX_CONST(1.0, 8));
    debug_assert!(psEncC.useInterpolatedNLSFs == 1 || psEncC.indices.NLSFInterpCoef_Q2 == (1 << 2));
    /* minisilk is fixed to 16 kHz, 20 ms frames (4 subframes) */
    debug_assert!(psEncC.nb_subfr == MAX_NB_SUBFR);

    let predictLPCOrder = psEncC.predictLPCOrder;

    /***********************/
    /* Calculate mu values */
    /***********************/
    /* NLSF_mu  = 0.003 - 0.0015 * psEnc->speech_activity; */
    let NLSF_mu_Q20 =
        silk_SMLAWB(SILK_FIX_CONST(0.003, 20), SILK_FIX_CONST(-0.001, 28), psEncC.speech_activity_Q8);
    /* (nb_subfr == 2, i.e. 10 ms packets, would multiply by 1.5; not supported) */

    debug_assert!(NLSF_mu_Q20 > 0);
    debug_assert!(NLSF_mu_Q20 <= SILK_FIX_CONST(0.005, 20));

    /* Calculate NLSF weights */
    silk_NLSF_VQ_weights_laroia(&mut pNLSFW_QW, pNLSF_Q15, predictLPCOrder);

    /* Update NLSF weights for interpolated NLSFs */
    let NLSFInterpCoef_Q2 = psEncC.indices.NLSFInterpCoef_Q2 as i32;
    let doInterpolate = (psEncC.useInterpolatedNLSFs == 1) && (NLSFInterpCoef_Q2 < 4);
    if doInterpolate {
        /* Calculate the interpolated NLSF vector for the first half */
        silk_interpolate(&mut pNLSF0_temp_Q15, prev_NLSFq_Q15, pNLSF_Q15, NLSFInterpCoef_Q2, predictLPCOrder);

        /* Calculate first half NLSF weights for the interpolated NLSFs */
        silk_NLSF_VQ_weights_laroia(&mut pNLSFW0_temp_QW, &pNLSF0_temp_Q15, predictLPCOrder);

        /* Update NLSF weights with contribution from first half */
        let i_sqr_Q15 = silk_LSHIFT(silk_SMULBB(NLSFInterpCoef_Q2, NLSFInterpCoef_Q2), 11) as i16;
        for i in 0..predictLPCOrder as usize {
            pNLSFW_QW[i] = (silk_RSHIFT(pNLSFW_QW[i] as i32, 1)
                + silk_RSHIFT(silk_SMULBB(pNLSFW0_temp_QW[i] as i32, i_sqr_Q15 as i32), 16)) as i16; /* silk_ADD16 */
            debug_assert!(pNLSFW_QW[i] >= 1);
        }
    }

    let signalType = psEncC.indices.signalType as i32;
    let survivors = psEncC.NLSF_MSVQ_Survivors;
    let psNLSF_CB = unsafe { &*psEncC.psNLSF_CB };
    silk_NLSF_encode(
        &mut psEncC.indices.NLSFIndices,
        pNLSF_Q15,
        psNLSF_CB,
        &pNLSFW_QW,
        NLSF_mu_Q20,
        survivors,
        signalType,
    );

    /* Convert quantized NLSFs back to LPC coefficients */
    silk_NLSF2A(&mut PredCoef_Q12[1], pNLSF_Q15, predictLPCOrder);

    if doInterpolate {
        /* Calculate the interpolated, quantized LSF vector for the first half */
        silk_interpolate(&mut pNLSF0_temp_Q15, prev_NLSFq_Q15, pNLSF_Q15, NLSFInterpCoef_Q2, predictLPCOrder);

        /* Convert back to LPC coefficients */
        silk_NLSF2A(&mut PredCoef_Q12[0], &pNLSF0_temp_Q15, predictLPCOrder);
    } else {
        /* Copy LPC coefficients for first half from second half */
        debug_assert!(predictLPCOrder <= MAX_LPC_ORDER);
        let (first, second) = PredCoef_Q12.split_at_mut(1);
        first[0][..predictLPCOrder as usize].copy_from_slice(&second[0][..predictLPCOrder as usize]);
    }
}

#[cfg(test)]
mod tests {
    use crate::silk::NLSF2A::tests::random_nlsf;
    use crate::silk::structs::silk_encoder_state;
    use crate::testutil::{CSilkEncoder, Rng, SpeechGen};
    mod c {
        use crate::silk::structs::silk_encoder_state;
        unsafe extern "C" {
            pub fn silk_process_NLSFs(psEncC: *mut silk_encoder_state, PredCoef_Q12: *mut [i16; 16], pNLSF_Q15: *mut i16, prev_NLSFq_Q15: *const i16);
        }
    }

    unsafe fn copy_state(src: &silk_encoder_state) -> Box<silk_encoder_state> {
        let mut b = crate::testutil::zeroed_box::<silk_encoder_state>();
        unsafe { core::ptr::copy_nonoverlapping(src, &mut *b, 1) };
        b
    }

    fn indices_bytes(s: &silk_encoder_state) -> Vec<u8> {
        let i = &s.indices;
        let mut v: Vec<u8> = i.NLSFIndices.iter().map(|&x| x as u8).collect();
        v.push(i.signalType as u8);
        v.push(i.NLSFInterpCoef_Q2 as u8);
        v
    }

    #[test]
    fn matches_c_with_encoder_states() {
        let mut rng = Rng::new(110);
        for (cfg, &(bitrate, complexity)) in [(20000, 10), (12000, 6), (32000, 2), (60000, 8)].iter().enumerate() {
            let mut enc = CSilkEncoder::new(bitrate, complexity, false);
            let mut sig = SpeechGen::new(5 + cfg as u64);
            for frame in 0..30 {
                enc.encode(&sig.frame_i16());
                let base = &enc.st.state_Fxx[0].sCmn;
                assert_eq!(base.predictLPCOrder, 16);
                for rep in 0..8 {
                    let mut s1 = unsafe { copy_state(base) };
                    // vary the encoder's decisions around the real ones
                    s1.speech_activity_Q8 = if rep < 2 { base.speech_activity_Q8 } else { rng.range(0, 256) };
                    s1.indices.signalType = if rep < 2 { base.indices.signalType } else { rng.range(0, 2) as i8 };
                    if rep >= 2 {
                        s1.useInterpolatedNLSFs = rng.range(0, 1);
                        s1.NLSF_MSVQ_Survivors = rng.range(2, 16);
                    }
                    s1.indices.NLSFInterpCoef_Q2 =
                        if s1.useInterpolatedNLSFs == 1 { rng.range(0, 4) as i8 } else { 4 };
                    let mut s2 = unsafe { copy_state(&s1) };
                    let nlsf = random_nlsf(&mut rng);
                    let prev = s1.prev_NLSFq_Q15;
                    let (mut n1, mut n2) = (nlsf, nlsf);
                    let (mut p1, mut p2) = ([[0x7777i16; 16]; 2], [[0x7777i16; 16]; 2]);
                    super::silk_process_NLSFs(&mut s1, &mut p1, &mut n1, &prev);
                    unsafe { c::silk_process_NLSFs(&mut *s2, p2.as_mut_ptr(), n2.as_mut_ptr(), prev.as_ptr()) };
                    let ctx = format!("cfg={cfg} frame={frame} rep={rep} nlsf={nlsf:?} prev={prev:?}");
                    assert_eq!(n1, n2, "NLSF out, {ctx}");
                    assert_eq!(p1, p2, "PredCoef, {ctx}");
                    assert_eq!(indices_bytes(&s1), indices_bytes(&s2), "indices, {ctx}");
                }
            }
        }
    }
}
