//! Port of silk/encode_indices.c.

use crate::celt::entcode::ec_enc;
use crate::celt::entenc::{ec_enc_icdf, ec_enc_icdf_ptr};
use crate::silk::define::*;
use crate::silk::macros::*;
use crate::silk::NLSF_unpack::silk_NLSF_unpack;
use crate::silk::structs::*;
use crate::silk::tables::*;

/// Encode side-information parameters to payload.
pub fn silk_encode_indices(psIndices: &SideInfoIndices, psRangeEnc: &mut ec_enc) {
    let mut ec_ix = [0i16; MAX_LPC_ORDER as usize];
    let mut pred_Q8 = [0u8; MAX_LPC_ORDER as usize];

    let signalType = psIndices.signalType as i32;

    /*******************************************/
    /* Encode signal type and quantizer offset */
    /*******************************************/
    let typeOffset = 2 * signalType + psIndices.quantOffsetType as i32;
    debug_assert!(typeOffset >= 0 && typeOffset < 6);
    if typeOffset >= 2 {
        ec_enc_icdf(psRangeEnc, typeOffset - 2, &silk_type_offset_VAD_iCDF, 8);
    } else {
        ec_enc_icdf(psRangeEnc, typeOffset, &silk_type_offset_no_VAD_iCDF, 8);
    }

    /****************/
    /* Encode gains */
    /****************/
    /* first subframe: independent coding, in two stages: MSB bits followed by 3 LSBs */
    debug_assert!(psIndices.GainsIndices[0] >= 0 && (psIndices.GainsIndices[0] as i32) < N_LEVELS_QGAIN);
    ec_enc_icdf(psRangeEnc, silk_RSHIFT(psIndices.GainsIndices[0] as i32, 3), &silk_gain_iCDF[signalType as usize], 8);
    ec_enc_icdf(psRangeEnc, psIndices.GainsIndices[0] as i32 & 7, &silk_uniform8_iCDF, 8);

    /* remaining subframes */
    for i in 1..MAX_NB_SUBFR as usize {
        debug_assert!(psIndices.GainsIndices[i] >= 0 && (psIndices.GainsIndices[i] as i32) < MAX_DELTA_GAIN_QUANT - MIN_DELTA_GAIN_QUANT + 1);
        ec_enc_icdf(psRangeEnc, psIndices.GainsIndices[i] as i32, &silk_delta_gain_iCDF, 8);
    }

    /****************/
    /* Encode NLSFs */
    /****************/
    let psNLSF_CB = &silk_NLSF_CB_WB;
    unsafe {
        ec_enc_icdf_ptr(
            psRangeEnc,
            psIndices.NLSFIndices[0] as i32,
            psNLSF_CB.CB1_iCDF.add(((signalType >> 1) * psNLSF_CB.nVectors as i32) as usize),
            8,
        );
    }
    silk_NLSF_unpack(&mut ec_ix, &mut pred_Q8, psNLSF_CB, psIndices.NLSFIndices[0] as i32);
    debug_assert!(psNLSF_CB.order as i32 == MAX_LPC_ORDER);
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
    debug_assert!(psIndices.NLSFInterpCoef_Q2 >= 0 && psIndices.NLSFInterpCoef_Q2 < 5);
    ec_enc_icdf(psRangeEnc, psIndices.NLSFInterpCoef_Q2 as i32, &silk_NLSF_interpolation_factor_iCDF, 8);

    if signalType == TYPE_VOICED {
        /*********************/
        /* Encode pitch lags */
        /*********************/
        /* lag index: absolute encoding */
        let pitch_high_bits = psIndices.lagIndex as i32 / (FS_KHZ / 2);
        let pitch_low_bits = psIndices.lagIndex as i32 % (FS_KHZ / 2);
        debug_assert!(pitch_high_bits < 32);
        ec_enc_icdf(psRangeEnc, pitch_high_bits, &silk_pitch_lag_iCDF, 8);
        ec_enc_icdf(psRangeEnc, pitch_low_bits, &silk_uniform8_iCDF, 8);

        /* Contour index */
        debug_assert!(psIndices.contourIndex >= 0);
        debug_assert!(psIndices.contourIndex < 34);
        ec_enc_icdf(psRangeEnc, psIndices.contourIndex as i32, &silk_pitch_contour_iCDF, 8);

        /********************/
        /* Encode LTP gains */
        /********************/
        /* PERIndex value */
        debug_assert!(psIndices.PERIndex >= 0 && psIndices.PERIndex < 3);
        ec_enc_icdf(psRangeEnc, psIndices.PERIndex as i32, &silk_LTP_per_index_iCDF, 8);

        /* Codebook Indices */
        for k in 0..MAX_NB_SUBFR as usize {
            debug_assert!(psIndices.LTPIndex[k] >= 0 && (psIndices.LTPIndex[k] as i32) < (8 << psIndices.PERIndex));
            ec_enc_icdf(psRangeEnc, psIndices.LTPIndex[k] as i32, silk_LTP_gain_iCDF_ptrs[psIndices.PERIndex as usize], 8);
        }

        /**********************/
        /* Encode LTP scaling */
        /**********************/
        debug_assert!(psIndices.LTP_scaleIndex >= 0 && psIndices.LTP_scaleIndex < 3);
        ec_enc_icdf(psRangeEnc, psIndices.LTP_scaleIndex as i32, &silk_LTPscale_iCDF, 8);
    }

    /***************/
    /* Encode seed */
    /***************/
    debug_assert!(psIndices.Seed >= 0 && psIndices.Seed < 4);
    ec_enc_icdf(psRangeEnc, psIndices.Seed as i32, &silk_uniform4_iCDF, 8);
}
