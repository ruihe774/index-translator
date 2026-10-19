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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::celt::entcode::tests_support::*;
    use crate::testutil::Rng;
    mod c {
        use crate::celt::entcode::ec_enc;
        unsafe extern "C" {
            pub fn silk_encode_signs(
                psRangeEnc: *mut ec_enc,
                pulses: *const i8,
                length: i32,
                signalType: i32,
                quantOffsetType: i32,
                sum_pulses: *const i32,
            );
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(21);
        for _ in 0..2000 {
            let length = 320;
            let mut pulses = [0i8; 320];
            let sparsity = rng.range(1, 6);
            for p in pulses.iter_mut() {
                if rng.range(0, sparsity) == 0 {
                    *p = rng.range(-20, 20) as i8;
                }
            }
            let mut sum_pulses = [0i32; 20];
            for b in 0..20 {
                // any non-negative per-block sum works for the sign coder
                sum_pulses[b] = pulses[b * 16..b * 16 + 16].iter().map(|&x| (x as i32).abs()).sum::<i32>() + rng.range(0, 1) * rng.range(0, 40);
                if rng.range(0, 10) == 0 {
                    sum_pulses[b] = 0;
                }
            }
            let sig = rng.range(0, 2);
            let qo = rng.range(0, 1);
            let (mut br, mut bc) = ([0u8; 400], [0u8; 400]);
            let mut er = new_enc(&mut br);
            let mut ec = new_enc(&mut bc);
            silk_encode_signs(&mut er, &pulses, length, sig, qo, &sum_pulses);
            unsafe { c::silk_encode_signs(&mut ec, pulses.as_ptr(), length, sig, qo, sum_pulses.as_ptr()) };
            crate::celt::entenc::ec_enc_done(&mut er);
            crate::celt::entenc::ec_enc_done(&mut ec);
            same_enc(&er, &ec);
            assert_eq!(br, bc);
        }
    }
}
