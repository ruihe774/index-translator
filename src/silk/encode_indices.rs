//! Port of silk/encode_indices.c.

use crate::celt::entcode::ec_enc;
use crate::celt::entenc::{ec_enc_icdf, ec_enc_icdf_ptr};
use crate::silk::define::*;
use crate::silk::macros::*;
use crate::silk::NLSF_unpack::silk_NLSF_unpack;
use crate::silk::structs::*;
use crate::silk::tables::*;

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
    }
    silk_NLSF_unpack(&mut ec_ix, &mut pred_Q8, psNLSF_CB, psIndices.NLSFIndices[0] as i32);
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
