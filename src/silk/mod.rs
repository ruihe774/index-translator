pub mod float;

// Definitions and fixed-point macro layer
pub mod define;
pub mod tuning_parameters;
pub mod pitch_est_defines;
pub mod macros;
pub mod structs;

// Tables
pub mod tables_gain;
pub mod tables_LTP;
pub mod tables_NLSF_CB_WB;
pub mod tables_other;
pub mod tables_pitch_lag;
pub mod tables_pulses_per_block;
pub mod table_LSF_cos;
pub mod pitch_est_tables;

// Shared helpers
pub mod sigm_Q15;
pub mod lin2log;
pub mod log2lin;

// Group A: entropy coding
pub mod encode_indices;
pub mod encode_pulses;
pub mod shell_coder;
pub mod code_signs;
pub mod gain_quant;

// Group B: NLSF / LPC
pub mod A2NLSF;
pub mod NLSF2A;
pub mod NLSF_encode;
pub mod NLSF_VQ;
pub mod NLSF_del_dec_quant;
pub mod NLSF_stabilize;
pub mod NLSF_unpack;
pub mod NLSF_decode;
pub mod NLSF_VQ_weights_laroia;
pub mod LPC_analysis_filter;
pub mod LPC_fit;
pub mod LPC_inv_pred_gain;
pub mod interpolate;
pub mod bwexpander;
pub mod bwexpander_32;
pub mod sort;
pub mod process_NLSFs;

// Group D: noise shaping quantization and VAD
pub mod NSQ;
pub mod NSQ_del_dec;
pub mod VAD;
pub mod VQ_WMat_EC;
pub mod ana_filt_bank_1;
pub mod sum_sqr_shift;

// Group F: encoder control
pub mod enc_API;
pub mod init_encoder;
pub mod control_codec;
pub mod control_SNR;
pub mod control_audio_bandwidth;
pub mod check_control_input;
pub mod HP_variable_cutoff;
pub mod quant_LTP_gains;
pub mod resampler;

/// tables.h: all SILK tables in one namespace.
pub mod tables {
    pub use super::tables_gain::*;
    pub use super::tables_LTP::*;
    pub use super::tables_NLSF_CB_WB::*;
    pub use super::tables_other::*;
    pub use super::tables_pitch_lag::*;
    pub use super::tables_pulses_per_block::*;
    pub use super::table_LSF_cos::*;
    pub use super::pitch_est_tables::*;
}

