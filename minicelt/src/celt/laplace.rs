//! Port of celt/laplace.c (encoder side).

use super::arch::IMIN;
use super::entcode::ec_enc;
use super::entenc::ec_encode_bin;

/* The minimum probability of an energy delta (out of 32768). */
const LAPLACE_LOG_MINP: i32 = 0;
const LAPLACE_MINP: u32 = 1 << LAPLACE_LOG_MINP;
/* The minimum number of guaranteed representable energy deltas (in one
    direction). */
const LAPLACE_NMIN: u32 = 16;

/* When called, decay is positive and at most 11456. */
pub fn ec_laplace_get_freq1(fs0: u32, decay: i32) -> u32 {
    let ft = 32768 - LAPLACE_MINP * (2 * LAPLACE_NMIN) - fs0;
    /* ft*(opus_int32)(16384-decay): unsigned multiply */
    ft.wrapping_mul((16384 - decay) as u32) >> 15
}

/// Fixed interface (used by quant_bands.rs).
pub fn ec_laplace_encode(enc: &mut ec_enc, value: &mut i32, mut fs: u32, decay: i32) {
    let mut val = *value;
    let mut fl: u32 = 0;
    if val != 0 {
        let s: i32 = -((val < 0) as i32);
        val = (val + s) ^ s;
        fl = fs;
        fs = ec_laplace_get_freq1(fs, decay);
        /* Search the decaying part of the PDF.*/
        let mut i: i32 = 1;
        while fs > 0 && i < val {
            fs *= 2;
            fl += fs + 2 * LAPLACE_MINP;
            fs = fs.wrapping_mul(decay as u32) >> 15;
            i += 1;
        }
        /* Everything beyond that has probability LAPLACE_MINP. */
        if fs == 0 {
            /* (32768-fl+LAPLACE_MINP-1) is unsigned in C, converted to int. */
            let mut ndi_max = (32768u32.wrapping_sub(fl) + LAPLACE_MINP - 1) as i32 >> LAPLACE_LOG_MINP;
            ndi_max = (ndi_max - s) >> 1;
            let di = IMIN(val - i, ndi_max - 1);
            /* int added to unsigned */
            fl = fl.wrapping_add(((2 * di + 1 + s) * LAPLACE_MINP as i32) as u32);
            /* IMIN(int, unsigned) compares as unsigned */
            let rest = 32768u32.wrapping_sub(fl);
            fs = if LAPLACE_MINP < rest { LAPLACE_MINP } else { rest };
            *value = (i + di + s) ^ s;
        } else {
            fs += LAPLACE_MINP;
            fl += fs & !s as u32;
        }
        debug_assert!(fl + fs <= 32768);
        debug_assert!(fs > 0);
    }
    ec_encode_bin(enc, fl, fl + fs, 15);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{same_enc, Rng};
    use core::ffi::c_void;
    use minicelt_oracle as c;
    use crate::celt::entcode::ec_enc;
    use crate::celt::entenc::{ec_enc_done, ec_enc_init};

    #[test]
    fn laplace_matches_c() {
        let mut rng = Rng::new(4242);
        for iter in 0..3000 {
            let size = 300usize;
            let mut bufr = vec![0u8; size];
            let mut bufc = vec![0u8; size];
            let mut er: ec_enc = unsafe { core::mem::zeroed() };
            let mut ec: ec_enc = unsafe { core::mem::zeroed() };
            ec_enc_init(&mut er, bufr.as_mut_ptr(), size as u32);
            unsafe { c::ec_enc_init(&mut ec as *mut ec_enc as *mut c_void, bufc.as_mut_ptr(), size as u32) };
            for _ in 0..rng.range(1, 30) {
                // e_prob_model style parameters: fs = p<<7, decay = d<<6 (decay <= 11456)
                let (fs, decay) = if iter % 3 == 0 {
                    (((rng.range(20, 130)) as u32) << 7, rng.range(40, 178) << 6)
                } else {
                    (rng.range(33, 32768 - 33) as u32, rng.range(1, 11456))
                };
                let range = match rng.range(0, 3) { 0 => 2, 1 => 10, 2 => 40, _ => 400 };
                let v = rng.range(-range, range);
                let (mut vr, mut vc) = (v, v);
                ec_laplace_encode(&mut er, &mut vr, fs, decay);
                unsafe { c::ec_laplace_encode(&mut ec as *mut ec_enc as *mut c_void, &mut vc, fs, decay) };
                assert_eq!(vr, vc, "value in={v} fs={fs} decay={decay}");
                same_enc(&er, &ec);
            }
            ec_enc_done(&mut er);
            unsafe { c::ec_enc_done(&mut ec as *mut ec_enc as *mut c_void) };
            assert_eq!(bufr, bufc);
        }
    }
}
