//! Port of silk/shell_coder.c (encoder side only).

use crate::celt::entcode::ec_enc;
use crate::celt::entenc::ec_enc_icdf;
use crate::silk::tables::*;

/* shell coder; pulse-subframe length is hardcoded */

#[inline(always)]
fn combine_pulses(out: &mut [i32], inp: &[i32], len: usize) {
    for k in 0..len {
        out[k] = inp[2 * k] + inp[2 * k + 1];
    }
}

#[inline(always)]
fn encode_split(psRangeEnc: &mut ec_enc, p_child1: i32, p: i32, shell_table: &[u8]) {
    if p > 0 {
        ec_enc_icdf(psRangeEnc, p_child1, &shell_table[silk_shell_code_table_offsets[p as usize] as usize..], 8);
    }
}

/// Shell encoder, operates on one shell code frame of 16 pulses.
/// `pulses0`: nonnegative pulse amplitudes (at least 16 values).
pub fn silk_shell_encoder(psRangeEnc: &mut ec_enc, pulses0: &[i32]) {
    let mut pulses1 = [0i32; 8];
    let mut pulses2 = [0i32; 4];
    let mut pulses3 = [0i32; 2];
    let mut pulses4 = [0i32; 1];

    /* tree representation per pulse-subframe */
    combine_pulses(&mut pulses1, pulses0, 8);
    combine_pulses(&mut pulses2, &pulses1, 4);
    combine_pulses(&mut pulses3, &pulses2, 2);
    combine_pulses(&mut pulses4, &pulses3, 1);

    encode_split(psRangeEnc, pulses3[0], pulses4[0], &silk_shell_code_table3);

    encode_split(psRangeEnc, pulses2[0], pulses3[0], &silk_shell_code_table2);

    encode_split(psRangeEnc, pulses1[0], pulses2[0], &silk_shell_code_table1);
    encode_split(psRangeEnc, pulses0[0], pulses1[0], &silk_shell_code_table0);
    encode_split(psRangeEnc, pulses0[2], pulses1[1], &silk_shell_code_table0);

    encode_split(psRangeEnc, pulses1[2], pulses2[1], &silk_shell_code_table1);
    encode_split(psRangeEnc, pulses0[4], pulses1[2], &silk_shell_code_table0);
    encode_split(psRangeEnc, pulses0[6], pulses1[3], &silk_shell_code_table0);

    encode_split(psRangeEnc, pulses2[2], pulses3[1], &silk_shell_code_table2);

    encode_split(psRangeEnc, pulses1[4], pulses2[2], &silk_shell_code_table1);
    encode_split(psRangeEnc, pulses0[8], pulses1[4], &silk_shell_code_table0);
    encode_split(psRangeEnc, pulses0[10], pulses1[5], &silk_shell_code_table0);

    encode_split(psRangeEnc, pulses1[6], pulses2[3], &silk_shell_code_table1);
    encode_split(psRangeEnc, pulses0[12], pulses1[6], &silk_shell_code_table0);
    encode_split(psRangeEnc, pulses0[14], pulses1[7], &silk_shell_code_table0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::celt::entcode::tests_support::*;
    use crate::testutil::Rng;
    mod c {
        use crate::celt::entcode::ec_enc;
        unsafe extern "C" {
            pub fn silk_shell_encoder(psRangeEnc: *mut ec_enc, pulses0: *const i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(5);
        for _ in 0..3000 {
            let mut p = [0i32; 16];
            // total must be <= 16 (SILK_MAX_PULSES)
            let mut left = rng.range(0, 16);
            while left > 0 {
                let i = rng.range(0, 15) as usize;
                p[i] += 1;
                left -= 1;
            }
            let (mut br, mut bc) = ([0u8; 64], [0u8; 64]);
            let mut er = new_enc(&mut br);
            let mut ec = new_enc(&mut bc);
            for _ in 0..3 {
                silk_shell_encoder(&mut er, &p);
                unsafe { c::silk_shell_encoder(&mut ec, p.as_ptr()) };
            }
            crate::celt::entenc::ec_enc_done(&mut er);
            crate::celt::entenc::ec_enc_done(&mut ec);
            same_enc(&er, &ec);
            assert_eq!(br, bc);
        }
    }
}
