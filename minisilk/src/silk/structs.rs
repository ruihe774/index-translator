//! Port of silk/structs.h (encoder side), silk/resampler_structs.h and the encoder part of
//! silk/control.h.
//!
//! The structs still mirror the C layout, including fields the trimmed encoder never uses
//! (stereo, LBRR, resampler, ...); nothing depends on that any more.

#![allow(non_camel_case_types, non_snake_case)]

use crate::silk::define::*;

pub const SILK_RESAMPLER_MAX_FIR_ORDER: usize = 36;
pub const SILK_RESAMPLER_MAX_IIR_ORDER: usize = 6;

const MAX_FRAME_LENGTH_: usize = MAX_FRAME_LENGTH as usize;
const MAX_FRAMES_PER_PACKET_: usize = MAX_FRAMES_PER_PACKET as usize;
const MAX_NB_SUBFR_: usize = MAX_NB_SUBFR as usize;
const MAX_LPC_ORDER_: usize = MAX_LPC_ORDER as usize;
const VAD_N_BANDS_: usize = VAD_N_BANDS as usize;

/// Noise shaping quantization state
#[repr(C)]
#[derive(Clone, Copy)]
pub struct silk_nsq_state {
    pub xq: [i16; 2 * MAX_FRAME_LENGTH_], /* Buffer for quantized output signal */
    pub sLTP_shp_Q14: [i32; 2 * MAX_FRAME_LENGTH_],
    pub sLPC_Q14: [i32; (MAX_SUB_FRAME_LENGTH + NSQ_LPC_BUF_LENGTH) as usize],
    pub sAR2_Q14: [i32; MAX_SHAPE_LPC_ORDER as usize],
    pub sLF_AR_shp_Q14: i32,
    pub sDiff_shp_Q14: i32,
    pub lagPrev: i32,
    pub sLTP_buf_idx: i32,
    pub sLTP_shp_buf_idx: i32,
    pub rand_seed: i32,
    pub prev_gain_Q16: i32,
    pub rewhite_flag: i32,
}

/// VAD state
#[repr(C)]
#[derive(Clone, Copy)]
pub struct silk_VAD_state {
    pub AnaState: [i32; 2],                     /* Analysis filterbank state: 0-8 kHz */
    pub AnaState1: [i32; 2],                    /* Analysis filterbank state: 0-4 kHz */
    pub AnaState2: [i32; 2],                    /* Analysis filterbank state: 0-2 kHz */
    pub XnrgSubfr: [i32; VAD_N_BANDS_],         /* Subframe energies */
    pub NrgRatioSmth_Q8: [i32; VAD_N_BANDS_],   /* Smoothed energy level in each band */
    pub HPstate: i16,                           /* State of differentiator in the lowest band */
    pub NL: [i32; VAD_N_BANDS_],                /* Noise energy level in each band */
    pub inv_NL: [i32; VAD_N_BANDS_],            /* Inverse noise energy level in each band */
    pub NoiseLevelBias: [i32; VAD_N_BANDS_],    /* Noise level estimator bias/offset */
    pub counter: i32,                           /* Frame counter used in the initial phase */
}

/// Variable cut-off low-pass filter state
#[repr(C)]
#[derive(Clone, Copy)]
pub struct silk_LP_state {
    pub In_LP_State: [i32; 2],   /* Low pass filter state */
    pub transition_frame_no: i32, /* Counter which is mapped to a cut-off frequency */
    pub mode: i32,               /* Operating mode, <0: switch down, >0: switch up; 0: do nothing */
    pub saved_fs_kHz: i32,       /* If non-zero, holds the last sampling rate before a bandwidth switching reset. */
}

/// Structure containing NLSF codebook
#[repr(C)]
pub struct silk_NLSF_CB_struct {
    pub nVectors: i16,
    pub order: i16,
    pub quantStepSize_Q16: i16,
    pub invQuantStepSize_Q6: i16,
    pub CB1_NLSF_Q8: *const u8,
    pub CB1_Wght_Q9: *const i16,
    pub CB1_iCDF: *const u8,
    pub pred_Q8: *const u8,
    pub ec_sel: *const u8,
    pub ec_iCDF: *const u8,
    pub ec_Rates_Q5: *const u8,
    pub deltaMin_Q15: *const i16,
}

// SAFETY: the codebooks are immutable tables.
unsafe impl Sync for silk_NLSF_CB_struct {}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct stereo_enc_state {
    pub pred_prev_Q13: [i16; 2],
    pub sMid: [i16; 2],
    pub sSide: [i16; 2],
    pub mid_side_amp_Q0: [i32; 4],
    pub smth_width_Q14: i16,
    pub width_prev_Q14: i16,
    pub silent_side_len: i16,
    pub predIx: [[[i8; 3]; 2]; MAX_FRAMES_PER_PACKET_],
    pub mid_only_flags: [i8; MAX_FRAMES_PER_PACKET_],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct SideInfoIndices {
    pub GainsIndices: [i8; MAX_NB_SUBFR_],
    pub LTPIndex: [i8; MAX_NB_SUBFR_],
    pub NLSFIndices: [i8; MAX_LPC_ORDER_ + 1],
    pub lagIndex: i16,
    pub contourIndex: i8,
    pub signalType: i8,
    pub quantOffsetType: i8,
    pub NLSFInterpCoef_Q2: i8,
    pub PERIndex: i8,
    pub LTP_scaleIndex: i8,
    pub Seed: i8,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union silk_resampler_sFIR {
    pub i32_: [i32; SILK_RESAMPLER_MAX_FIR_ORDER],
    pub i16_: [i16; SILK_RESAMPLER_MAX_FIR_ORDER],
}

/// Kept only for layout compatibility; the 16 kHz-only encoder replaces the resampler with
/// a delay line.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct silk_resampler_state_struct {
    pub sIIR: [i32; SILK_RESAMPLER_MAX_IIR_ORDER], /* this must be the first element of this struct */
    pub sFIR: silk_resampler_sFIR,
    pub delayBuf: [i16; 96],
    pub resampler_function: i32,
    pub batchSize: i32,
    pub invRatio_Q16: i32,
    pub FIR_Order: i32,
    pub FIR_Fracs: i32,
    pub Fs_in_kHz: i32,
    pub Fs_out_kHz: i32,
    pub inputDelay: i32,
    pub Coefs: *const i16,
}

/// Encoder state
#[repr(C)]
#[derive(Clone, Copy)]
pub struct silk_encoder_state {
    pub In_HP_State: [i32; 2],                  /* High pass filter state */
    pub variable_HP_smth1_Q15: i32,             /* State of first smoother */
    pub variable_HP_smth2_Q15: i32,             /* State of second smoother */
    pub sLP: silk_LP_state,                     /* Low pass filter state */
    pub sVAD: silk_VAD_state,                   /* Voice activity detector state */
    pub sNSQ: silk_nsq_state,                   /* Noise Shape Quantizer State */
    pub prev_NLSFq_Q15: [i16; MAX_LPC_ORDER_],  /* Previously quantized NLSF vector */
    pub speech_activity_Q8: i32,                /* Speech activity */
    pub allow_bandwidth_switch: i32,            /* Flag indicating that switching of internal bandwidth is allowed */
    pub LBRRprevLastGainIndex: i8,
    pub prevSignalType: i8,
    pub prevLag: i32,
    pub pitch_LPC_win_length: i32,
    pub max_pitch_lag: i32,                     /* Highest possible pitch lag (samples) */
    pub API_fs_Hz: i32,                         /* API sampling frequency (Hz) */
    pub prev_API_fs_Hz: i32,                    /* Previous API sampling frequency (Hz) */
    pub maxInternal_fs_Hz: i32,                 /* Maximum internal sampling frequency (Hz) */
    pub minInternal_fs_Hz: i32,                 /* Minimum internal sampling frequency (Hz) */
    pub desiredInternal_fs_Hz: i32,             /* Soft request for internal sampling frequency (Hz) */
    pub fs_kHz: i32,                            /* Internal sampling frequency (kHz) */
    pub nb_subfr: i32,                          /* Number of 5 ms subframes in a frame */
    pub frame_length: i32,                      /* Frame length (samples) */
    pub subfr_length: i32,                      /* Subframe length (samples) */
    pub ltp_mem_length: i32,                    /* Length of LTP memory */
    pub la_pitch: i32,                          /* Look-ahead for pitch analysis (samples) */
    pub la_shape: i32,                          /* Look-ahead for noise shape analysis (samples) */
    pub shapeWinLength: i32,                    /* Window length for noise shape analysis (samples) */
    pub TargetRate_bps: i32,                    /* Target bitrate (bps) */
    pub PacketSize_ms: i32,                     /* Number of milliseconds to put in each packet */
    pub PacketLoss_perc: i32,                   /* Packet loss rate measured by farend */
    pub frameCounter: i32,
    pub Complexity: i32,                        /* Complexity setting */
    pub nStatesDelayedDecision: i32,            /* Number of states in delayed decision quantization */
    pub useInterpolatedNLSFs: i32,              /* Flag for using NLSF interpolation */
    pub shapingLPCOrder: i32,                   /* Filter order for noise shaping filters */
    pub predictLPCOrder: i32,                   /* Filter order for prediction filters */
    pub pitchEstimationComplexity: i32,         /* Complexity level for pitch estimator */
    pub pitchEstimationLPCOrder: i32,           /* Whitening filter order for pitch estimator */
    pub pitchEstimationThreshold_Q16: i32,      /* Threshold for pitch estimator */
    pub sum_log_gain_Q7: i32,                   /* Cumulative max prediction gain */
    pub NLSF_MSVQ_Survivors: i32,               /* Number of survivors in NLSF MSVQ */
    pub first_frame_after_reset: i32,           /* Flag for deactivating NLSF interpolation, pitch prediction */
    pub controlled_since_last_payload: i32,     /* Flag for ensuring codec_control only runs once per packet */
    pub warping_Q16: i32,                       /* Warping parameter for warped noise shaping */
    pub useCBR: i32,                            /* Flag to enable constant bitrate */
    pub prefillFlag: i32,                       /* Flag to indicate that only buffers are prefilled, no coding */
    pub pitch_lag_low_bits_iCDF: *const u8,     /* Pointer to iCDF table for low bits of pitch lag index */
    pub pitch_contour_iCDF: *const u8,          /* Pointer to iCDF table for pitch contour index */
    pub psNLSF_CB: *const silk_NLSF_CB_struct,  /* Pointer to NLSF codebook */
    pub input_quality_bands_Q15: [i32; VAD_N_BANDS_],
    pub input_tilt_Q15: i32,
    pub SNR_dB_Q7: i32,                         /* Quality setting */
    pub VAD_flags: [i8; MAX_FRAMES_PER_PACKET_],
    pub LBRR_flag: i8,
    pub LBRR_flags: [i32; MAX_FRAMES_PER_PACKET_],
    pub indices: SideInfoIndices,
    pub pulses: [i8; MAX_FRAME_LENGTH_],
    pub arch: i32,

    /* Input/output buffering */
    pub inputBuf: [i16; MAX_FRAME_LENGTH_ + 2], /* Buffer containing input signal */
    pub inputBufIx: i32,
    pub nFramesPerPacket: i32,
    pub nFramesEncoded: i32,                    /* Number of frames analyzed in current packet */

    pub nChannelsAPI: i32,
    pub nChannelsInternal: i32,
    pub channelNb: i32,

    /* Parameters For LTP scaling Control */
    pub frames_since_onset: i32,

    /* Specifically for entropy coding */
    pub ec_prevSignalType: i32,
    pub ec_prevLagIndex: i16,

    pub resampler_state: silk_resampler_state_struct,

    /* DTX */
    pub useDTX: i32,                            /* Flag to enable DTX */
    pub inDTX: i32,                             /* Flag to signal DTX period */
    pub noSpeechCounter: i32,                   /* Counts concecutive nonactive frames, used by DTX */

    /* Inband Low Bitrate Redundancy (LBRR) data */
    pub useInBandFEC: i32,                      /* Saves the API setting for query */
    pub LBRR_enabled: i32,                      /* Depends on useInBandFRC, bitrate and packet loss rate */
    pub LBRR_GainIncreases: i32,                /* Gains increment for coding LBRR frames */
    pub indices_LBRR: [SideInfoIndices; MAX_FRAMES_PER_PACKET_],
    pub pulses_LBRR: [[i8; MAX_FRAME_LENGTH_]; MAX_FRAMES_PER_PACKET_],
}

/// Structure for controlling encoder operation (silk/control.h)
#[repr(C)]
#[derive(Clone, Copy)]
pub struct silk_EncControlStruct {
    /* I:   Number of channels; 1/2 */
    pub nChannelsAPI: i32,
    /* I:   Number of channels; 1/2 */
    pub nChannelsInternal: i32,
    /* I:   Input signal sampling rate in Hertz; 8000/12000/16000/24000/32000/44100/48000 */
    pub API_sampleRate: i32,
    /* I:   Maximum internal sampling rate in Hertz; 8000/12000/16000 */
    pub maxInternalSampleRate: i32,
    /* I:   Minimum internal sampling rate in Hertz; 8000/12000/16000 */
    pub minInternalSampleRate: i32,
    /* I:   Soft request for internal sampling rate in Hertz; 8000/12000/16000 */
    pub desiredInternalSampleRate: i32,
    /* I:   Number of samples per packet in milliseconds; 10/20/40/60 */
    pub payloadSize_ms: i32,
    /* I:   Bitrate during active speech in bits/second; internally limited */
    pub bitRate: i32,
    /* I:   Uplink packet loss in percent (0-100) */
    pub packetLossPercentage: i32,
    /* I:   Complexity mode; 0 is lowest, 10 is highest complexity */
    pub complexity: i32,
    /* I:   Flag to enable in-band Forward Error Correction (FEC); 0/1 */
    pub useInBandFEC: i32,
    /* I:   Flag to enable in-band Deep REDundancy (DRED); 0/1 */
    pub useDRED: i32,
    /* I:   Flag to actually code in-band Forward Error Correction (FEC) in the current packet; 0/1 */
    pub LBRR_coded: i32,
    /* I:   Flag to enable discontinuous transmission (DTX); 0/1 */
    pub useDTX: i32,
    /* I:   Flag to use constant bitrate */
    pub useCBR: i32,
    /* I:   Maximum number of bits allowed for the frame */
    pub maxBits: i32,
    /* I:   Causes a smooth downmix to mono */
    pub toMono: i32,
    /* I:   Opus encoder is allowing us to switch bandwidth */
    pub opusCanSwitch: i32,
    /* I: Make frames as independent as possible (but still use LPC) */
    pub reducedDependency: i32,
    /* O:   Internal sampling rate used, in Hertz; 8000/12000/16000 */
    pub internalSampleRate: i32,
    /* O: Flag that bandwidth switching is allowed (because low voice activity) */
    pub allowBandwidthSwitch: i32,
    /* O:   Flag that SILK runs in WB mode without variable LP filter (use for switching between WB/SWB/FB) */
    pub inWBmodeWithoutVariableLP: i32,
    /* O:   Stereo width */
    pub stereoWidth_Q14: i32,
    /* O:   Tells the Opus encoder we're ready to switch */
    pub switchReady: i32,
    /* O: SILK Signal type */
    pub signalType: i32,
    /* O: SILK offset (dithering) */
    pub offset: i32,
}
