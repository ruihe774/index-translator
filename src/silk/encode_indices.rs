//! Port of silk/encode_indices.c.

use crate::celt::entcode::ec_enc;
use crate::celt::entenc::{ec_enc_icdf, ec_enc_icdf_ptr};
use crate::silk::define::*;
use crate::silk::macros::*;
use crate::silk::structs::*;
use crate::silk::tables::*;

/// silk_NLSF_unpack (silk/NLSF_unpack.c), private copy so that this module does not depend
/// on the NLSF group: unpacks predictor values and indices for entropy coding tables.
unsafe fn NLSF_unpack(ec_ix: &mut [i16], pred_Q8: &mut [u8], psNLSF_CB: &silk_NLSF_CB_struct, CB1_index: i32) {
    unsafe {
        let order = psNLSF_CB.order as i32;
        let mut ec_sel_ptr = psNLSF_CB.ec_sel.add((CB1_index * order / 2) as usize);
        let mut i = 0;
        while i < order {
            let entry = *ec_sel_ptr as i32;
            ec_sel_ptr = ec_sel_ptr.add(1);
            ec_ix[i as usize] = silk_SMULBB(silk_RSHIFT(entry, 1) & 7, 2 * NLSF_QUANT_MAX_AMPLITUDE + 1) as i16;
            pred_Q8[i as usize] = *psNLSF_CB.pred_Q8.add((i + (entry & 1) * (order - 1)) as usize);
            ec_ix[i as usize + 1] = silk_SMULBB(silk_RSHIFT(entry, 5) & 7, 2 * NLSF_QUANT_MAX_AMPLITUDE + 1) as i16;
            pred_Q8[i as usize + 1] = *psNLSF_CB.pred_Q8.add((i + (silk_RSHIFT(entry, 4) & 1) * (order - 1) + 1) as usize);
            i += 2;
        }
    }
}

/// Encode side-information parameters to payload.
pub fn silk_encode_indices(psEncC: &mut silk_encoder_state, psRangeEnc: &mut ec_enc, FrameIndex: i32, encode_LBRR: i32, condCoding: i32) {
    let mut ec_ix = [0i16; MAX_LPC_ORDER as usize];
    let mut pred_Q8 = [0u8; MAX_LPC_ORDER as usize];

    /* The indices are only read; copy them so that psEncC can be updated below. */
    let psIndices: SideInfoIndices = if encode_LBRR != 0 {
        psEncC.indices_LBRR[FrameIndex as usize]
    } else {
        psEncC.indices
    };
    let signalType = psIndices.signalType as i32;

    /*******************************************/
    /* Encode signal type and quantizer offset */
    /*******************************************/
    let typeOffset = 2 * signalType + psIndices.quantOffsetType as i32;
    debug_assert!(typeOffset >= 0 && typeOffset < 6);
    debug_assert!(encode_LBRR == 0 || typeOffset >= 2);
    if encode_LBRR != 0 || typeOffset >= 2 {
        ec_enc_icdf(psRangeEnc, typeOffset - 2, &silk_type_offset_VAD_iCDF, 8);
    } else {
        ec_enc_icdf(psRangeEnc, typeOffset, &silk_type_offset_no_VAD_iCDF, 8);
    }

    /****************/
    /* Encode gains */
    /****************/
    /* first subframe */
    if condCoding == CODE_CONDITIONALLY {
        /* conditional coding */
        debug_assert!(psIndices.GainsIndices[0] >= 0 && (psIndices.GainsIndices[0] as i32) < MAX_DELTA_GAIN_QUANT - MIN_DELTA_GAIN_QUANT + 1);
        ec_enc_icdf(psRangeEnc, psIndices.GainsIndices[0] as i32, &silk_delta_gain_iCDF, 8);
    } else {
        /* independent coding, in two stages: MSB bits followed by 3 LSBs */
        debug_assert!(psIndices.GainsIndices[0] >= 0 && (psIndices.GainsIndices[0] as i32) < N_LEVELS_QGAIN);
        ec_enc_icdf(psRangeEnc, silk_RSHIFT(psIndices.GainsIndices[0] as i32, 3), &silk_gain_iCDF[signalType as usize], 8);
        ec_enc_icdf(psRangeEnc, psIndices.GainsIndices[0] as i32 & 7, &silk_uniform8_iCDF, 8);
    }

    /* remaining subframes */
    for i in 1..psEncC.nb_subfr as usize {
        debug_assert!(psIndices.GainsIndices[i] >= 0 && (psIndices.GainsIndices[i] as i32) < MAX_DELTA_GAIN_QUANT - MIN_DELTA_GAIN_QUANT + 1);
        ec_enc_icdf(psRangeEnc, psIndices.GainsIndices[i] as i32, &silk_delta_gain_iCDF, 8);
    }

    /****************/
    /* Encode NLSFs */
    /****************/
    let psNLSF_CB = unsafe { &*psEncC.psNLSF_CB };
    unsafe {
        ec_enc_icdf_ptr(
            psRangeEnc,
            psIndices.NLSFIndices[0] as i32,
            psNLSF_CB.CB1_iCDF.add(((signalType >> 1) * psNLSF_CB.nVectors as i32) as usize),
            8,
        );
        NLSF_unpack(&mut ec_ix, &mut pred_Q8, psNLSF_CB, psIndices.NLSFIndices[0] as i32);
    }
    debug_assert!(psNLSF_CB.order as i32 == psEncC.predictLPCOrder);
    for i in 0..psNLSF_CB.order as usize {
        let nlsf = psIndices.NLSFIndices[i + 1] as i32;
        unsafe {
            let cdf = psNLSF_CB.ec_iCDF.add(ec_ix[i] as usize);
            if nlsf >= NLSF_QUANT_MAX_AMPLITUDE {
                ec_enc_icdf_ptr(psRangeEnc, 2 * NLSF_QUANT_MAX_AMPLITUDE, cdf, 8);
                ec_enc_icdf(psRangeEnc, nlsf - NLSF_QUANT_MAX_AMPLITUDE, &silk_NLSF_EXT_iCDF, 8);
            } else if nlsf <= -NLSF_QUANT_MAX_AMPLITUDE {
                ec_enc_icdf_ptr(psRangeEnc, 0, cdf, 8);
                ec_enc_icdf(psRangeEnc, -nlsf - NLSF_QUANT_MAX_AMPLITUDE, &silk_NLSF_EXT_iCDF, 8);
            } else {
                ec_enc_icdf_ptr(psRangeEnc, nlsf + NLSF_QUANT_MAX_AMPLITUDE, cdf, 8);
            }
        }
    }

    /* Encode NLSF interpolation factor */
    if psEncC.nb_subfr == MAX_NB_SUBFR {
        debug_assert!(psIndices.NLSFInterpCoef_Q2 >= 0 && psIndices.NLSFInterpCoef_Q2 < 5);
        ec_enc_icdf(psRangeEnc, psIndices.NLSFInterpCoef_Q2 as i32, &silk_NLSF_interpolation_factor_iCDF, 8);
    }

    if signalType == TYPE_VOICED {
        /*********************/
        /* Encode pitch lags */
        /*********************/
        /* lag index */
        let mut encode_absolute_lagIndex = 1;
        if condCoding == CODE_CONDITIONALLY && psEncC.ec_prevSignalType == TYPE_VOICED {
            /* Delta Encoding */
            let mut delta_lagIndex = psIndices.lagIndex as i32 - psEncC.ec_prevLagIndex as i32;
            if delta_lagIndex < -8 || delta_lagIndex > 11 {
                delta_lagIndex = 0;
            } else {
                delta_lagIndex = delta_lagIndex + 9;
                encode_absolute_lagIndex = 0; /* Only use delta */
            }
            debug_assert!(delta_lagIndex >= 0 && delta_lagIndex < 21);
            ec_enc_icdf(psRangeEnc, delta_lagIndex, &silk_pitch_delta_iCDF, 8);
        }
        if encode_absolute_lagIndex != 0 {
            /* Absolute encoding */
            let pitch_high_bits = silk_DIV32_16(psIndices.lagIndex as i32, silk_RSHIFT(psEncC.fs_kHz, 1));
            let pitch_low_bits = psIndices.lagIndex as i32 - silk_SMULBB(pitch_high_bits, silk_RSHIFT(psEncC.fs_kHz, 1));
            debug_assert!(pitch_low_bits < psEncC.fs_kHz / 2);
            debug_assert!(pitch_high_bits < 32);
            ec_enc_icdf(psRangeEnc, pitch_high_bits, &silk_pitch_lag_iCDF, 8);
            unsafe { ec_enc_icdf_ptr(psRangeEnc, pitch_low_bits, psEncC.pitch_lag_low_bits_iCDF, 8) };
        }
        psEncC.ec_prevLagIndex = psIndices.lagIndex;

        /* Contour index */
        debug_assert!(psIndices.contourIndex >= 0);
        debug_assert!(
            (psIndices.contourIndex < 34 && psEncC.fs_kHz > 8 && psEncC.nb_subfr == 4)
                || (psIndices.contourIndex < 11 && psEncC.fs_kHz == 8 && psEncC.nb_subfr == 4)
                || (psIndices.contourIndex < 12 && psEncC.fs_kHz > 8 && psEncC.nb_subfr == 2)
                || (psIndices.contourIndex < 3 && psEncC.fs_kHz == 8 && psEncC.nb_subfr == 2)
        );
        unsafe { ec_enc_icdf_ptr(psRangeEnc, psIndices.contourIndex as i32, psEncC.pitch_contour_iCDF, 8) };

        /********************/
        /* Encode LTP gains */
        /********************/
        /* PERIndex value */
        debug_assert!(psIndices.PERIndex >= 0 && psIndices.PERIndex < 3);
        ec_enc_icdf(psRangeEnc, psIndices.PERIndex as i32, &silk_LTP_per_index_iCDF, 8);

        /* Codebook Indices */
        for k in 0..psEncC.nb_subfr as usize {
            debug_assert!(psIndices.LTPIndex[k] >= 0 && (psIndices.LTPIndex[k] as i32) < (8 << psIndices.PERIndex));
            ec_enc_icdf(psRangeEnc, psIndices.LTPIndex[k] as i32, silk_LTP_gain_iCDF_ptrs[psIndices.PERIndex as usize], 8);
        }

        /**********************/
        /* Encode LTP scaling */
        /**********************/
        if condCoding == CODE_INDEPENDENTLY {
            debug_assert!(psIndices.LTP_scaleIndex >= 0 && psIndices.LTP_scaleIndex < 3);
            ec_enc_icdf(psRangeEnc, psIndices.LTP_scaleIndex as i32, &silk_LTPscale_iCDF, 8);
        }
        debug_assert!(condCoding == 0 || psIndices.LTP_scaleIndex == 0);
    }

    psEncC.ec_prevSignalType = signalType;

    /***************/
    /* Encode seed */
    /***************/
    debug_assert!(psIndices.Seed >= 0 && psIndices.Seed < 4);
    ec_enc_icdf(psRangeEnc, psIndices.Seed as i32, &silk_uniform4_iCDF, 8);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::celt::entcode::tests_support::*;
    use crate::testutil::{CSilkEncoder, Rng, SpeechGen, zeroed_box};
    mod c {
        use crate::celt::entcode::ec_enc;
        use crate::silk::structs::silk_encoder_state;
        unsafe extern "C" {
            pub fn silk_encode_indices(psEncC: *mut silk_encoder_state, psRangeEnc: *mut ec_enc, FrameIndex: i32, encode_LBRR: i32, condCoding: i32);
            pub fn ec_enc_done(this: *mut ec_enc);
        }
    }

    fn random_indices(rng: &mut Rng, cond: i32, lbrr: bool, nb_subfr: usize) -> SideInfoIndices {
        let mut ix: SideInfoIndices = unsafe { core::mem::zeroed() };
        ix.signalType = rng.range(if lbrr { 1 } else { 0 }, 2) as i8;
        ix.quantOffsetType = rng.range(0, 1) as i8;
        for k in 0..nb_subfr {
            ix.GainsIndices[k] = if k == 0 && cond != CODE_CONDITIONALLY { rng.range(0, 63) } else { rng.range(0, 40) } as i8;
        }
        ix.NLSFIndices[0] = rng.range(0, 31) as i8;
        for k in 1..=16 {
            ix.NLSFIndices[k] = match rng.range(0, 5) {
                0 => rng.range(-10, 10),
                _ => rng.range(-3, 3),
            } as i8;
        }
        ix.NLSFInterpCoef_Q2 = rng.range(0, 4) as i8;
        ix.lagIndex = rng.range(0, 255) as i16;
        ix.contourIndex = rng.range(0, 33) as i8;
        ix.PERIndex = rng.range(0, 2) as i8;
        for k in 0..nb_subfr {
            ix.LTPIndex[k] = rng.range(0, (8 << ix.PERIndex) - 1) as i8;
        }
        ix.LTP_scaleIndex = if cond == CODE_INDEPENDENTLY { rng.range(0, 2) } else { 0 } as i8;
        ix.Seed = rng.range(0, 3) as i8;
        ix
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(77);
        let mut enc = CSilkEncoder::new(24000, 6, false);
        let mut sig = SpeechGen::new(3);
        let mut snapshots = vec![];
        for f in 0..40 {
            enc.encode(&sig.frame_i16());
            if f >= 5 {
                snapshots.push(enc.st.state_Fxx[0].sCmn);
            }
        }
        let mut n_voiced = 0;
        for iter in 0..1500 {
            let mut base = zeroed_box::<silk_encoder_state>();
            *base = snapshots[iter % snapshots.len()];
            let cond = [CODE_INDEPENDENTLY, CODE_CONDITIONALLY][rng.range(0, 1) as usize];
            let lbrr = iter % 5 == 4;
            let frame_index = rng.range(0, 2);
            match iter % 3 {
                0 => {} /* keep the indices the C encoder produced */
                _ => {
                    base.ec_prevSignalType = rng.range(0, 2);
                    base.ec_prevLagIndex = rng.range(0, 255) as i16;
                    let ix = random_indices(&mut rng, cond, lbrr, 4);
                    if lbrr {
                        base.indices_LBRR[frame_index as usize] = ix;
                    } else {
                        base.indices = ix;
                    }
                }
            }
            if lbrr && iter % 3 == 0 {
                base.indices_LBRR[frame_index as usize] = base.indices;
                if base.indices.signalType == 0 {
                    base.indices_LBRR[frame_index as usize].signalType = 1;
                }
            }
            if cond == CODE_CONDITIONALLY && iter % 3 == 0 {
                // the encoder only codes conditionally with valid delta gain / no LTP scale
                base.indices.GainsIndices[0] = base.indices.GainsIndices[0].min(40);
                base.indices.LTP_scaleIndex = 0;
                if lbrr {
                    base.indices_LBRR[frame_index as usize].GainsIndices[0] = base.indices.GainsIndices[0];
                    base.indices_LBRR[frame_index as usize].LTP_scaleIndex = 0;
                }
            }
            let used = if lbrr { base.indices_LBRR[frame_index as usize] } else { base.indices };
            if used.signalType == 2 {
                n_voiced += 1;
            }
            let mut sr = zeroed_box::<silk_encoder_state>();
            let mut sc = zeroed_box::<silk_encoder_state>();
            *sr = *base;
            *sc = *base;
            let (mut br, mut bc) = ([0u8; 300], [0u8; 300]);
            let mut er = new_enc(&mut br);
            let mut ec = new_enc(&mut bc);
            // a few frames back to back, to also exercise the ec_prev* state updates
            for _ in 0..3 {
                silk_encode_indices(&mut sr, &mut er, frame_index, lbrr as i32, cond);
                unsafe { c::silk_encode_indices(&mut *sc, &mut ec, frame_index, lbrr as i32, cond) };
                same_enc(&er, &ec);
                assert_eq!(sr.ec_prevSignalType, sc.ec_prevSignalType);
                assert_eq!(sr.ec_prevLagIndex, sc.ec_prevLagIndex);
            }
            crate::celt::entenc::ec_enc_done(&mut er);
            unsafe { c::ec_enc_done(&mut ec) };
            same_enc(&er, &ec);
            assert_eq!(br, bc, "iter {iter}");
        }
        assert!(n_voiced > 100);
    }
}
