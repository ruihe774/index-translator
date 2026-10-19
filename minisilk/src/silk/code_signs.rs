//! Port of silk/code_signs.c (encoder side only).

use crate::celt::entcode::ec_enc;
use crate::celt::entenc::ec_enc_icdf;
use crate::silk::define::*;
use crate::silk::macros::*;
use crate::silk::tables::*;

/*#define silk_enc_map(a)                ((a) > 0 ? 1 : 0)*/
/* shifting avoids if-statement */
#[inline(always)]
fn silk_enc_map(a: i32) -> i32 {
    silk_RSHIFT(a, 15) + 1
}

/// Encodes signs of excitation.
pub fn silk_encode_signs(
    psRangeEnc: &mut ec_enc,
    pulses: &[i8],
    length: i32,
    signalType: i32,
    quantOffsetType: i32,
    sum_pulses: &[i32],
) {
    let mut icdf = [0u8; 2];
    icdf[1] = 0;
    let mut q_off = 0usize;
    let i = silk_SMULBB(7, silk_ADD_LSHIFT(quantOffsetType, signalType, 1)) as usize;
    let icdf_ptr = &silk_sign_iCDF[i..];
    let length = silk_RSHIFT(length + SHELL_CODEC_FRAME_LENGTH / 2, LOG2_SHELL_CODEC_FRAME_LENGTH);
    for i in 0..length as usize {
        let p = sum_pulses[i];
        if p > 0 {
            icdf[0] = icdf_ptr[silk_min!(p & 0x1F, 6) as usize];
            for j in 0..SHELL_CODEC_FRAME_LENGTH as usize {
                let q = pulses[q_off + j];
                if q != 0 {
                    ec_enc_icdf(psRangeEnc, silk_enc_map(q as i32), &icdf, 8);
                }
            }
        }
        q_off += SHELL_CODEC_FRAME_LENGTH as usize;
    }
}
