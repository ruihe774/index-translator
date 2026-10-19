//! Checks every SILK table against the C oracle's tables.

use super::tables::*;
use crate::silk::structs::silk_NLSF_CB_struct;

mod c {
    use crate::silk::structs::silk_NLSF_CB_struct;
    unsafe extern "C" {
        pub static silk_gain_iCDF: [[u8; 8]; 3];
        pub static silk_delta_gain_iCDF: [u8; 41];
        pub static silk_LTP_per_index_iCDF: [u8; 3];
        pub static silk_LTP_vq_sizes: [i8; 3];
        pub static silk_lsb_iCDF: [u8; 2];
        pub static silk_LTPscale_iCDF: [u8; 3];
        pub static silk_type_offset_VAD_iCDF: [u8; 4];
        pub static silk_type_offset_no_VAD_iCDF: [u8; 2];
        pub static silk_NLSF_interpolation_factor_iCDF: [u8; 5];
        pub static silk_Quantization_Offsets_Q10: [[i16; 2]; 2];
        pub static silk_LTPScales_table_Q14: [i16; 3];
        pub static silk_uniform3_iCDF: [u8; 3];
        pub static silk_uniform4_iCDF: [u8; 4];
        pub static silk_uniform5_iCDF: [u8; 5];
        pub static silk_uniform6_iCDF: [u8; 6];
        pub static silk_uniform8_iCDF: [u8; 8];
        pub static silk_NLSF_EXT_iCDF: [u8; 7];
        pub static silk_pitch_lag_iCDF: [u8; 32];
        pub static silk_pitch_delta_iCDF: [u8; 21];
        pub static silk_pitch_contour_iCDF: [u8; 34];
        pub static silk_pitch_contour_NB_iCDF: [u8; 11];
        pub static silk_pitch_contour_10_ms_iCDF: [u8; 12];
        pub static silk_pitch_contour_10_ms_NB_iCDF: [u8; 3];
        pub static silk_max_pulses_table: [u8; 4];
        pub static silk_pulses_per_block_iCDF: [[u8; 18]; 10];
        pub static silk_pulses_per_block_BITS_Q5: [[u8; 18]; 9];
        pub static silk_rate_levels_iCDF: [[u8; 9]; 2];
        pub static silk_rate_levels_BITS_Q5: [[u8; 9]; 2];
        pub static silk_shell_code_table0: [u8; 152];
        pub static silk_shell_code_table1: [u8; 152];
        pub static silk_shell_code_table2: [u8; 152];
        pub static silk_shell_code_table3: [u8; 152];
        pub static silk_shell_code_table_offsets: [u8; 17];
        pub static silk_sign_iCDF: [u8; 42];
        pub static silk_LSFCosTab_FIX_Q12: [i16; 129];
        pub static silk_CB_lags_stage2_10_ms: [[i8; 3]; 2];
        pub static silk_CB_lags_stage3_10_ms: [[i8; 12]; 2];
        pub static silk_Lag_range_stage3_10_ms: [[i8; 2]; 2];
        pub static silk_CB_lags_stage2: [[i8; 11]; 4];
        pub static silk_CB_lags_stage3: [[i8; 34]; 4];
        pub static silk_Lag_range_stage3: [[[i8; 2]; 4]; 3];
        pub static silk_nb_cbk_searchs_stage3: [i8; 3];
        pub static silk_LTP_gain_iCDF_ptrs: [*const u8; 3];
        pub static silk_LTP_gain_BITS_Q5_ptrs: [*const u8; 3];
        pub static silk_LTP_vq_ptrs_Q7: [*const i8; 3];
        pub static silk_LTP_vq_gain_ptrs_Q7: [*const u8; 3];
        pub static silk_NLSF_CB_WB: silk_NLSF_CB_struct;
    }
}

unsafe fn c_slice<'a, T>(p: *const T, n: usize) -> &'a [T] {
    unsafe { core::slice::from_raw_parts(p, n) }
}

#[test]
fn plain_tables_match_c() {
    assert_eq!(silk_gain_iCDF, unsafe { c::silk_gain_iCDF }, "silk_gain_iCDF");
    assert_eq!(silk_delta_gain_iCDF, unsafe { c::silk_delta_gain_iCDF }, "silk_delta_gain_iCDF");
    assert_eq!(silk_LTP_per_index_iCDF, unsafe { c::silk_LTP_per_index_iCDF }, "silk_LTP_per_index_iCDF");
    assert_eq!(silk_LTP_vq_sizes, unsafe { c::silk_LTP_vq_sizes }, "silk_LTP_vq_sizes");
    assert_eq!(silk_lsb_iCDF, unsafe { c::silk_lsb_iCDF }, "silk_lsb_iCDF");
    assert_eq!(silk_LTPscale_iCDF, unsafe { c::silk_LTPscale_iCDF }, "silk_LTPscale_iCDF");
    assert_eq!(silk_type_offset_VAD_iCDF, unsafe { c::silk_type_offset_VAD_iCDF }, "silk_type_offset_VAD_iCDF");
    assert_eq!(silk_type_offset_no_VAD_iCDF, unsafe { c::silk_type_offset_no_VAD_iCDF }, "silk_type_offset_no_VAD_iCDF");
    assert_eq!(silk_NLSF_interpolation_factor_iCDF, unsafe { c::silk_NLSF_interpolation_factor_iCDF }, "silk_NLSF_interpolation_factor_iCDF");
    assert_eq!(silk_Quantization_Offsets_Q10, unsafe { c::silk_Quantization_Offsets_Q10 }, "silk_Quantization_Offsets_Q10");
    assert_eq!(silk_LTPScales_table_Q14, unsafe { c::silk_LTPScales_table_Q14 }, "silk_LTPScales_table_Q14");
    assert_eq!(silk_uniform3_iCDF, unsafe { c::silk_uniform3_iCDF }, "silk_uniform3_iCDF");
    assert_eq!(silk_uniform4_iCDF, unsafe { c::silk_uniform4_iCDF }, "silk_uniform4_iCDF");
    assert_eq!(silk_uniform5_iCDF, unsafe { c::silk_uniform5_iCDF }, "silk_uniform5_iCDF");
    assert_eq!(silk_uniform6_iCDF, unsafe { c::silk_uniform6_iCDF }, "silk_uniform6_iCDF");
    assert_eq!(silk_uniform8_iCDF, unsafe { c::silk_uniform8_iCDF }, "silk_uniform8_iCDF");
    assert_eq!(silk_NLSF_EXT_iCDF, unsafe { c::silk_NLSF_EXT_iCDF }, "silk_NLSF_EXT_iCDF");
    assert_eq!(silk_pitch_lag_iCDF, unsafe { c::silk_pitch_lag_iCDF }, "silk_pitch_lag_iCDF");
    assert_eq!(silk_pitch_delta_iCDF, unsafe { c::silk_pitch_delta_iCDF }, "silk_pitch_delta_iCDF");
    assert_eq!(silk_pitch_contour_iCDF, unsafe { c::silk_pitch_contour_iCDF }, "silk_pitch_contour_iCDF");
    assert_eq!(silk_pitch_contour_NB_iCDF, unsafe { c::silk_pitch_contour_NB_iCDF }, "silk_pitch_contour_NB_iCDF");
    assert_eq!(silk_pitch_contour_10_ms_iCDF, unsafe { c::silk_pitch_contour_10_ms_iCDF }, "silk_pitch_contour_10_ms_iCDF");
    assert_eq!(silk_pitch_contour_10_ms_NB_iCDF, unsafe { c::silk_pitch_contour_10_ms_NB_iCDF }, "silk_pitch_contour_10_ms_NB_iCDF");
    assert_eq!(silk_max_pulses_table, unsafe { c::silk_max_pulses_table }, "silk_max_pulses_table");
    assert_eq!(silk_pulses_per_block_iCDF, unsafe { c::silk_pulses_per_block_iCDF }, "silk_pulses_per_block_iCDF");
    assert_eq!(silk_pulses_per_block_BITS_Q5, unsafe { c::silk_pulses_per_block_BITS_Q5 }, "silk_pulses_per_block_BITS_Q5");
    assert_eq!(silk_rate_levels_iCDF, unsafe { c::silk_rate_levels_iCDF }, "silk_rate_levels_iCDF");
    assert_eq!(silk_rate_levels_BITS_Q5, unsafe { c::silk_rate_levels_BITS_Q5 }, "silk_rate_levels_BITS_Q5");
    assert_eq!(silk_shell_code_table0, unsafe { c::silk_shell_code_table0 }, "silk_shell_code_table0");
    assert_eq!(silk_shell_code_table1, unsafe { c::silk_shell_code_table1 }, "silk_shell_code_table1");
    assert_eq!(silk_shell_code_table2, unsafe { c::silk_shell_code_table2 }, "silk_shell_code_table2");
    assert_eq!(silk_shell_code_table3, unsafe { c::silk_shell_code_table3 }, "silk_shell_code_table3");
    assert_eq!(silk_shell_code_table_offsets, unsafe { c::silk_shell_code_table_offsets }, "silk_shell_code_table_offsets");
    assert_eq!(silk_sign_iCDF, unsafe { c::silk_sign_iCDF }, "silk_sign_iCDF");
    assert_eq!(silk_LSFCosTab_FIX_Q12, unsafe { c::silk_LSFCosTab_FIX_Q12 }, "silk_LSFCosTab_FIX_Q12");
    assert_eq!(silk_CB_lags_stage2_10_ms, unsafe { c::silk_CB_lags_stage2_10_ms }, "silk_CB_lags_stage2_10_ms");
    assert_eq!(silk_CB_lags_stage3_10_ms, unsafe { c::silk_CB_lags_stage3_10_ms }, "silk_CB_lags_stage3_10_ms");
    assert_eq!(silk_Lag_range_stage3_10_ms, unsafe { c::silk_Lag_range_stage3_10_ms }, "silk_Lag_range_stage3_10_ms");
    assert_eq!(silk_CB_lags_stage2, unsafe { c::silk_CB_lags_stage2 }, "silk_CB_lags_stage2");
    assert_eq!(silk_CB_lags_stage3, unsafe { c::silk_CB_lags_stage3 }, "silk_CB_lags_stage3");
    assert_eq!(silk_Lag_range_stage3, unsafe { c::silk_Lag_range_stage3 }, "silk_Lag_range_stage3");
    assert_eq!(silk_nb_cbk_searchs_stage3, unsafe { c::silk_nb_cbk_searchs_stage3 }, "silk_nb_cbk_searchs_stage3");
}

#[test]
fn ltp_pointer_tables_match_c() {
    unsafe {
        for k in 0..3 {
            let n = silk_LTP_gain_iCDF_ptrs[k].len();
            assert_eq!(silk_LTP_gain_iCDF_ptrs[k], c_slice(c::silk_LTP_gain_iCDF_ptrs[k], n));
            assert_eq!(silk_LTP_gain_BITS_Q5_ptrs[k], c_slice(c::silk_LTP_gain_BITS_Q5_ptrs[k], n));
            assert_eq!(silk_LTP_vq_gain_ptrs_Q7[k], c_slice(c::silk_LTP_vq_gain_ptrs_Q7[k], n));
            let vq = silk_LTP_vq_ptrs_Q7[k];
            assert_eq!(vq.len(), silk_LTP_vq_sizes[k] as usize);
            assert_eq!(vq.as_flattened(), c_slice(c::silk_LTP_vq_ptrs_Q7[k], vq.len() * 5));
        }
    }
}

#[test]
fn nlsf_codebook_matches_c() {
    unsafe {
        let (r, c): (&silk_NLSF_CB_struct, &silk_NLSF_CB_struct) = (&silk_NLSF_CB_WB, &c::silk_NLSF_CB_WB);
        assert_eq!(
            (r.nVectors, r.order, r.quantStepSize_Q16, r.invQuantStepSize_Q6),
            (c.nVectors, c.order, c.quantStepSize_Q16, c.invQuantStepSize_Q6)
        );
        let (nv, ord) = (r.nVectors as usize, r.order as usize);
        assert_eq!(c_slice(r.CB1_NLSF_Q8, nv * ord), c_slice(c.CB1_NLSF_Q8, nv * ord));
        assert_eq!(c_slice(r.CB1_Wght_Q9, nv * ord), c_slice(c.CB1_Wght_Q9, nv * ord));
        assert_eq!(c_slice(r.CB1_iCDF, 64), c_slice(c.CB1_iCDF, 64));
        assert_eq!(c_slice(r.pred_Q8, 2 * (ord - 1)), c_slice(c.pred_Q8, 2 * (ord - 1)));
        assert_eq!(c_slice(r.ec_sel, nv * ord / 2), c_slice(c.ec_sel, nv * ord / 2));
        assert_eq!(c_slice(r.ec_iCDF, 72), c_slice(c.ec_iCDF, 72));
        assert_eq!(c_slice(r.ec_Rates_Q5, 72), c_slice(c.ec_Rates_Q5, 72));
        assert_eq!(c_slice(r.deltaMin_Q15, ord + 1), c_slice(c.deltaMin_Q15, ord + 1));
    }
}
