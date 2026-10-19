//! Port of silk/control_audio_bandwidth.c.
//!
//! minisilk's internal rate is fixed to 16 kHz (API rate 16 kHz, desired internal rate
//! 16 kHz), so the bandwidth switching state machine never changes anything: the transition
//! mode (`sLP.mode`) stays 0 and the rate stays at 16 kHz. Only the initialization branch and
//! the (no-op) state machine bookkeeping remain.

use crate::silk::define::*;
use crate::silk::macros::*;
use crate::silk::structs::{silk_EncControlStruct, silk_encoder_state};

/// Control internal sampling rate
pub fn silk_control_audio_bandwidth(
    psEncC: &mut silk_encoder_state,        /* I/O  Pointer to Silk encoder state               */
    encControl: &mut silk_EncControlStruct, /* I    Control structure                           */
) -> i32 {
    let mut orig_kHz = psEncC.fs_kHz;
    /* Handle a bandwidth-switching reset where we need to be aware what the last sampling rate was. */
    if orig_kHz == 0 {
        orig_kHz = psEncC.sLP.saved_fs_kHz;
    }
    let mut fs_kHz = orig_kHz;
    let mut fs_Hz = silk_SMULBB(fs_kHz, 1000);
    if fs_Hz == 0 {
        /* Encoder has just been initialized */
        fs_Hz = silk_min!(psEncC.desiredInternal_fs_Hz, psEncC.API_fs_Hz);
        fs_kHz = silk_DIV32_16(fs_Hz, 1000);
    } else {
        /* Internal rate above the API rate or outside [min, max]: not reachable with a fixed
           16 kHz API and internal rate. */
        debug_assert!(
            !(fs_Hz > psEncC.API_fs_Hz || fs_Hz > psEncC.maxInternal_fs_Hz || fs_Hz < psEncC.minInternal_fs_Hz)
        );
        /* State machine for the internal sampling rate switching */
        if psEncC.sLP.transition_frame_no >= TRANSITION_FRAMES {
            /* Stop transition phase */
            psEncC.sLP.mode = 0;
        }
        /* Switching down or up needs a desired internal rate different from the current one
           (or opusCanSwitch); with the rate fixed to 16 kHz both are unreachable. The remaining
           branch only acts on sLP.mode < 0, which never happens. */
        debug_assert!(silk_SMULBB(orig_kHz, 1000) == psEncC.desiredInternal_fs_Hz);
        debug_assert!(encControl.opusCanSwitch == 0);
        debug_assert!(psEncC.sLP.mode == 0);
    }
    debug_assert!(fs_kHz == 16);
    fs_kHz
}
