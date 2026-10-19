//! Port of silk/ana_filt_bank_1.c.

use crate::silk::macros::*;

/* Coefficients for 2-band filter bank based on first-order allpass filters */
const A_fb1_20: i16 = 5394 << 1;
const A_fb1_21: i16 = -24290; /* (opus_int16)(20623 << 1) */

/// Split signal into two decimated bands using first-order allpass filters.
///
/// `outL` may be the start of `in_` (the VAD filters in place), so the buffers are raw
/// pointers: output sample `k` is written after input samples `2k` and `2k + 1` are read.
pub unsafe fn silk_ana_filt_bank_1(
    in_: *const i16, /* I    Input signal [N]                                            */
    S: &mut [i32; 2], /* I/O  State vector [2]                                            */
    outL: *mut i16,  /* O    Low band [N/2]                                              */
    outH: *mut i16,  /* O    High band [N/2]                                             */
    N: i32,          /* I    Number of input samples                                     */
) {
    let N2 = silk_RSHIFT(N, 1);

    /* Internal variables and state are in Q10 format */
    for k in 0..N2 as usize {
        unsafe {
            /* Convert to Q10 */
            let mut in32 = silk_LSHIFT(*in_.add(2 * k) as i32, 10);

            /* All-pass section for even input sample */
            let mut Y = silk_SUB32(in32, S[0]);
            let mut X = silk_SMLAWB(Y, Y, A_fb1_21 as i32);
            let out_1 = silk_ADD32(S[0], X);
            S[0] = silk_ADD32(in32, X);

            /* Convert to Q10 */
            in32 = silk_LSHIFT(*in_.add(2 * k + 1) as i32, 10);

            /* All-pass section for odd input sample, and add to output of previous section */
            Y = silk_SUB32(in32, S[1]);
            X = silk_SMULWB(Y, A_fb1_20 as i32);
            let out_2 = silk_ADD32(S[1], X);
            S[1] = silk_ADD32(in32, X);

            /* Add/subtract, convert back to int16 and store to output */
            *outL.add(k) = silk_SAT16(silk_RSHIFT_ROUND(silk_ADD32(out_2, out_1), 11)) as i16;
            *outH.add(k) = silk_SAT16(silk_RSHIFT_ROUND(silk_SUB32(out_2, out_1), 11)) as i16;
        }
    }
}
