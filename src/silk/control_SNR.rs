//! Port of silk/control_SNR.c.

use crate::silk::define::*;
use crate::silk::macros::*;
use crate::silk::structs::silk_encoder_state;

/* These tables hold SNR values divided by 21 (so they fit in 8 bits)
   for different target bitrates spaced at 400 bps interval. The first
   10 values are omitted (0-4 kb/s) because they're all zeros.
   These tables were obtained by running different SNRs through the
   encoder and measuring the active bitrate.
   Only the WB table is needed: the internal rate is fixed to 16 kHz. */
static silk_TargetRate_WB_21: [u8; 201 - 10] = [
                                              0,  0,  0,  8, 29, 41,
     49, 56, 62, 66, 70, 74, 77, 80, 83, 86, 88, 91, 93, 95, 97, 99,
    101,103,105,107,108,110,112,113,115,116,118,119,121,122,123,125,
    126,127,129,130,131,132,134,135,136,137,138,140,141,142,143,144,
    145,146,147,148,149,150,151,152,153,154,156,157,158,159,159,160,
    161,162,163,164,165,166,167,168,169,170,171,171,172,173,174,175,
    176,177,177,178,179,180,181,181,182,183,184,185,185,186,187,188,
    189,189,190,191,192,192,193,194,195,195,196,197,198,198,199,200,
    200,201,202,203,203,204,205,206,206,207,208,209,209,210,211,211,
    212,213,214,214,215,216,216,217,218,219,219,220,221,221,222,223,
    224,224,225,226,226,227,228,229,229,230,231,232,232,233,234,234,
    235,236,237,237,238,239,240,240,241,242,243,243,244,245,246,246,
    247,248,249,249,250,251,252,253,255
];

/// Control SNR of residual quantizer
pub fn silk_control_SNR(
    psEncC: &mut silk_encoder_state, /* I/O  Pointer to Silk encoder state               */
    TargetRate_bps: i32,             /* I    Target max bitrate (bps)                    */
) -> i32 {
    psEncC.TargetRate_bps = TargetRate_bps;
    /* 10 ms frames (nb_subfr == 2) and NB/MB tables are not supported */
    debug_assert!(psEncC.nb_subfr == MAX_NB_SUBFR);
    debug_assert!(psEncC.fs_kHz == 16);
    let bound = silk_TargetRate_WB_21.len() as i32;
    let snr_table = &silk_TargetRate_WB_21;
    let mut id = (TargetRate_bps + 200) / 400;
    id = silk_min!(id - 10, bound - 1);
    if id <= 0 {
        psEncC.SNR_dB_Q7 = 0;
    } else {
        psEncC.SNR_dB_Q7 = snr_table[id as usize] as i32 * 21;
    }
    SILK_NO_ERROR
}
