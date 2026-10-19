//! Port of silk/resampler.c, restricted to what the minisilk encoder uses: the 16 kHz -> 16 kHz
//! copy path (`USE_silk_resampler_copy`), i.e. a delay line of `delay_matrix_enc[16][16] = 10`
//! samples. The state is the regular `silk_resampler_state_struct`, set up exactly as C does,
//! so it stays byte-identical to the C encoder state.

use crate::silk::macros::*;
use crate::silk::structs::silk_resampler_state_struct;

/* Number of input samples to process in the inner loop */
const RESAMPLER_MAX_BATCH_SIZE_MS: i32 = 10;

const USE_silk_resampler_copy: i32 = 0;

/* delay_matrix_enc[ rateID( 16000 ) ][ rateID( 16000 ) ] */
const DELAY_ENC_16_16: i32 = 10;

/// Initialize/reset the resampler state for a given pair of input/output sampling rates
/// (16 kHz -> 16 kHz encoder resampler only).
pub fn silk_resampler_init(
    S: &mut silk_resampler_state_struct, /* I/O  Resampler state                                             */
    Fs_Hz_in: i32,                       /* I    Input sampling rate (Hz)                                    */
    Fs_Hz_out: i32,                      /* I    Output sampling rate (Hz)                                   */
    forEnc: i32,                         /* I    If 1: encoder; if 0: decoder                                */
) -> i32 {
    /* Clear state */
    // SAFETY: all-zero is a valid silk_resampler_state_struct (Coefs becomes null, as in C).
    unsafe { core::ptr::write_bytes(S as *mut silk_resampler_state_struct, 0, 1) };

    /* Only the encoder's 16 kHz -> 16 kHz copy path is supported */
    debug_assert!(forEnc == 1 && Fs_Hz_in == 16000 && Fs_Hz_out == 16000);
    S.inputDelay = DELAY_ENC_16_16;

    S.Fs_in_kHz = silk_DIV32_16(Fs_Hz_in, 1000);
    S.Fs_out_kHz = silk_DIV32_16(Fs_Hz_out, 1000);

    /* Number of samples processed per batch */
    S.batchSize = S.Fs_in_kHz * RESAMPLER_MAX_BATCH_SIZE_MS;

    /* Input and output sampling rates are equal: copy */
    let up2x = 0;
    S.resampler_function = USE_silk_resampler_copy;

    /* Ratio of input/output samples */
    S.invRatio_Q16 = silk_LSHIFT32(silk_DIV32(silk_LSHIFT32(Fs_Hz_in, 14 + up2x), Fs_Hz_out), 2);
    /* Make sure the ratio is rounded up */
    while silk_SMULWW(S.invRatio_Q16, Fs_Hz_out) < silk_LSHIFT32(Fs_Hz_in, up2x) {
        S.invRatio_Q16 += 1;
    }

    0
}

/// Resampler: convert from one sampling rate to another (here: a plain delay line).
pub fn silk_resampler(
    S: &mut silk_resampler_state_struct, /* I/O  Resampler state                                             */
    out: &mut [i16],                     /* O    Output signal                                               */
    in_: &[i16],                         /* I    Input signal                                                */
    inLen: i32,                          /* I    Number of input samples                                     */
) -> i32 {
    /* Need at least 1 ms of input data */
    debug_assert!(inLen >= S.Fs_in_kHz);
    /* Delay can't exceed the 1 ms of buffering */
    debug_assert!(S.inputDelay <= S.Fs_in_kHz);
    debug_assert!(S.resampler_function == USE_silk_resampler_copy);

    let inLen = inLen as usize;
    let Fs_in_kHz = S.Fs_in_kHz as usize;
    let Fs_out_kHz = S.Fs_out_kHz as usize;
    let inputDelay = S.inputDelay as usize;
    let nSamples = Fs_in_kHz - inputDelay;

    /* Copy to delay buffer */
    S.delayBuf[inputDelay..inputDelay + nSamples].copy_from_slice(&in_[..nSamples]);

    out[..Fs_in_kHz].copy_from_slice(&S.delayBuf[..Fs_in_kHz]);
    out[Fs_out_kHz..Fs_out_kHz + inLen - Fs_in_kHz].copy_from_slice(&in_[nSamples..nSamples + inLen - Fs_in_kHz]);

    /* Copy to delay buffer */
    S.delayBuf[..inputDelay].copy_from_slice(&in_[inLen - inputDelay..inLen]);

    0
}
