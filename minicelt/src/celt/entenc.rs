//! Port of celt/entenc.c (with the constants of celt/mfrngcod.h).

#![allow(non_camel_case_types)]

use crate::celt::entcode::*;

/// The number of bits to output at a time.
pub const EC_SYM_BITS: i32 = 8;
/// The total number of bits in each of the state registers.
pub const EC_CODE_BITS: i32 = 32;
/// The maximum symbol value.
pub const EC_SYM_MAX: u32 = (1u32 << EC_SYM_BITS) - 1;
/// Bits to shift by to move a symbol into the high-order position.
pub const EC_CODE_SHIFT: i32 = EC_CODE_BITS - EC_SYM_BITS - 1;
/// Carry bit of the high-order range symbol.
pub const EC_CODE_TOP: u32 = 1u32 << (EC_CODE_BITS - 1);
/// Low-order bit of the high-order range symbol.
pub const EC_CODE_BOT: u32 = EC_CODE_TOP >> EC_SYM_BITS;
/// The number of bits available for the last, partial symbol in the code field.
pub const EC_CODE_EXTRA: i32 = (EC_CODE_BITS - 2) % EC_SYM_BITS + 1;

/* A range encoder.
See entdec.c and the references for implementation details. */

fn ec_write_byte(this: &mut ec_enc, value: u32) -> i32 {
    if this.offs.wrapping_add(this.end_offs) >= this.storage {
        return -1;
    }
    unsafe { *this.buf.add(this.offs as usize) = value as u8 };
    this.offs += 1;
    0
}

fn ec_write_byte_at_end(this: &mut ec_enc, value: u32) -> i32 {
    if this.offs.wrapping_add(this.end_offs) >= this.storage {
        return -1;
    }
    this.end_offs += 1;
    unsafe { *this.buf.add((this.storage - this.end_offs) as usize) = value as u8 };
    0
}

/* Outputs a symbol, with a carry bit.
If there is a potential to propagate a carry over several symbols, they are
buffered until it can be determined whether or not an actual carry will
occur.
If the counter for the buffered symbols overflows, then the stream becomes
undecodable. */
fn ec_enc_carry_out(this: &mut ec_enc, c: i32) {
    if c as u32 != EC_SYM_MAX {
        /* No further carry propagation possible, flush buffer. */
        let carry = c >> EC_SYM_BITS;
        /* Don't output a byte on the first write. */
        if this.rem >= 0 {
            this.error |= ec_write_byte(this, (this.rem + carry) as u32);
        }
        if this.ext > 0 {
            let sym = (EC_SYM_MAX.wrapping_add(carry as u32)) & EC_SYM_MAX;
            loop {
                this.error |= ec_write_byte(this, sym);
                this.ext -= 1;
                if this.ext == 0 {
                    break;
                }
            }
        }
        this.rem = c & EC_SYM_MAX as i32;
    } else {
        this.ext += 1;
    }
}

#[inline(always)]
fn ec_enc_normalize(this: &mut ec_enc) {
    /* If the range is too small, output some bits and rescale it. */
    while this.rng <= EC_CODE_BOT {
        ec_enc_carry_out(this, (this.val >> EC_CODE_SHIFT) as i32);
        /* Move the next-to-high-order symbol into the high-order position. */
        this.val = (this.val << EC_SYM_BITS) & (EC_CODE_TOP - 1);
        this.rng <<= EC_SYM_BITS;
        this.nbits_total += EC_SYM_BITS;
    }
}

/// Initializes the encoder. `buf` must point to `size` writable bytes (or be null with
/// `size == 0`).
pub fn ec_enc_init(this: &mut ec_enc, buf: *mut u8, size: u32) {
    this.buf = buf;
    this.end_offs = 0;
    this.end_window = 0;
    this.nend_bits = 0;
    /* This is the offset from which ec_tell() will subtract partial bits. */
    this.nbits_total = EC_CODE_BITS + 1;
    this.offs = 0;
    this.rng = EC_CODE_TOP;
    this.rem = -1;
    this.val = 0;
    this.ext = 0;
    this.storage = size;
    this.error = 0;
}

pub fn ec_encode(this: &mut ec_enc, fl: u32, fh: u32, ft: u32) {
    let r = celt_udiv(this.rng, ft);
    if fl > 0 {
        this.val = this.val.wrapping_add(this.rng.wrapping_sub(r.wrapping_mul(ft - fl)));
        this.rng = r.wrapping_mul(fh - fl);
    } else {
        this.rng = this.rng.wrapping_sub(r.wrapping_mul(ft - fh));
    }
    ec_enc_normalize(this);
}

pub fn ec_encode_bin(this: &mut ec_enc, fl: u32, fh: u32, bits: u32) {
    let r = this.rng >> bits;
    if fl > 0 {
        this.val = this.val.wrapping_add(this.rng.wrapping_sub(r.wrapping_mul((1u32 << bits) - fl)));
        this.rng = r.wrapping_mul(fh - fl);
    } else {
        this.rng = this.rng.wrapping_sub(r.wrapping_mul((1u32 << bits) - fh));
    }
    ec_enc_normalize(this);
}

/// The probability of having a "one" is 1/(1<<logp).
pub fn ec_enc_bit_logp(this: &mut ec_enc, val: i32, logp: u32) {
    let mut r = this.rng;
    let l = this.val;
    let s = r >> logp;
    r -= s;
    if val != 0 {
        this.val = l.wrapping_add(r);
    }
    this.rng = if val != 0 { s } else { r };
    ec_enc_normalize(this);
}

pub fn ec_enc_icdf(this: &mut ec_enc, s: i32, icdf: &[u8], ftb: u32) {
    debug_assert!((s as usize) < icdf.len());
    unsafe { ec_enc_icdf_ptr(this, s, icdf.as_ptr(), ftb) }
}

/// `ec_enc_icdf` taking a raw table pointer (for tables reached through C-style pointers).
///
/// # Safety
/// `icdf` must be valid for reads of indices `s-1` and `s`.
pub unsafe fn ec_enc_icdf_ptr(this: &mut ec_enc, s: i32, icdf: *const u8, ftb: u32) {
    let r = this.rng >> ftb;
    unsafe {
        if s > 0 {
            let a = *icdf.add(s as usize - 1) as u32;
            let b = *icdf.add(s as usize) as u32;
            this.val = this.val.wrapping_add(this.rng.wrapping_sub(r.wrapping_mul(a)));
            this.rng = r.wrapping_mul(a - b);
        } else {
            this.rng = this.rng.wrapping_sub(r.wrapping_mul(*icdf as u32));
        }
    }
    ec_enc_normalize(this);
}

pub fn ec_enc_icdf16(this: &mut ec_enc, s: i32, icdf: &[u16], ftb: u32) {
    let r = this.rng >> ftb;
    let s = s as usize;
    if s > 0 {
        this.val = this.val.wrapping_add(this.rng.wrapping_sub(r.wrapping_mul(icdf[s - 1] as u32)));
        this.rng = r.wrapping_mul(icdf[s - 1] as u32 - icdf[s] as u32);
    } else {
        this.rng = this.rng.wrapping_sub(r.wrapping_mul(icdf[s] as u32));
    }
    ec_enc_normalize(this);
}

pub fn ec_enc_uint(this: &mut ec_enc, fl: u32, ft: u32) {
    /* In order to optimize EC_ILOG(), it is undefined for the value 0. */
    debug_assert!(ft > 1);
    let ft = ft - 1;
    let mut ftb = EC_ILOG(ft);
    if ftb > EC_UINT_BITS {
        ftb -= EC_UINT_BITS;
        let ft = (ft >> ftb) + 1;
        let fl2 = fl >> ftb;
        ec_encode(this, fl2, fl2 + 1, ft);
        ec_enc_bits(this, fl & ((1u32 << ftb) - 1), ftb as u32);
    } else {
        ec_encode(this, fl, fl + 1, ft + 1);
    }
}

pub fn ec_enc_bits(this: &mut ec_enc, fl: u32, bits: u32) {
    let mut window = this.end_window;
    let mut used = this.nend_bits;
    debug_assert!(bits > 0);
    if (used as u32).wrapping_add(bits) > EC_WINDOW_SIZE as u32 {
        loop {
            this.error |= ec_write_byte_at_end(this, window & EC_SYM_MAX);
            window >>= EC_SYM_BITS;
            used -= EC_SYM_BITS;
            if used < EC_SYM_BITS {
                break;
            }
        }
    }
    window |= fl << used;
    used += bits as i32;
    this.end_window = window;
    this.nend_bits = used;
    this.nbits_total += bits as i32;
}

pub fn ec_enc_patch_initial_bits(this: &mut ec_enc, val: u32, nbits: u32) {
    debug_assert!(nbits <= EC_SYM_BITS as u32);
    let shift = EC_SYM_BITS as u32 - nbits;
    let mask: u32 = ((1u32 << nbits) - 1) << shift;
    if this.offs > 0 {
        /* The first byte has been finalized. */
        unsafe { *this.buf = ((*this.buf as u32 & !mask) | (val << shift)) as u8 };
    } else if this.rem >= 0 {
        /* The first byte is still awaiting carry propagation. */
        this.rem = ((this.rem as u32 & !mask) | (val << shift)) as i32;
    } else if this.rng <= (EC_CODE_TOP >> nbits) {
        /* The renormalization loop has never been run. */
        this.val = (this.val & !(mask << EC_CODE_SHIFT)) | (val << (EC_CODE_SHIFT as u32 + shift));
    } else {
        /* The encoder hasn't even encoded _nbits of data yet. */
        this.error = -1;
    }
}

pub fn ec_enc_shrink(this: &mut ec_enc, size: u32) {
    debug_assert!(this.offs + this.end_offs <= size);
    unsafe {
        core::ptr::copy(
            this.buf.add((this.storage - this.end_offs) as usize),
            this.buf.add((size - this.end_offs) as usize),
            this.end_offs as usize,
        );
    }
    this.storage = size;
}

pub fn ec_enc_done(this: &mut ec_enc) {
    /* We output the minimum number of bits that ensures that the symbols encoded
    thus far will be decoded correctly regardless of the bits that follow. */
    let mut l = EC_CODE_BITS - EC_ILOG(this.rng);
    let mut msk = (EC_CODE_TOP - 1) >> l;
    let mut end = this.val.wrapping_add(msk) & !msk;
    if (end | msk) >= this.val.wrapping_add(this.rng) {
        l += 1;
        msk >>= 1;
        end = this.val.wrapping_add(msk) & !msk;
    }
    while l > 0 {
        ec_enc_carry_out(this, (end >> EC_CODE_SHIFT) as i32);
        end = (end << EC_SYM_BITS) & (EC_CODE_TOP - 1);
        l -= EC_SYM_BITS;
    }
    /* If we have a buffered byte flush it into the output buffer. */
    if this.rem >= 0 || this.ext > 0 {
        ec_enc_carry_out(this, 0);
    }
    /* If we have buffered extra bits, flush them as well. */
    let mut window = this.end_window;
    let mut used = this.nend_bits;
    while used >= EC_SYM_BITS {
        this.error |= ec_write_byte_at_end(this, window & EC_SYM_MAX);
        window >>= EC_SYM_BITS;
        used -= EC_SYM_BITS;
    }
    /* Clear any excess space and add any remaining extra bits to the last byte. */
    if this.error == 0 {
        if !this.buf.is_null() {
            unsafe {
                core::ptr::write_bytes(
                    this.buf.add(this.offs as usize),
                    0,
                    (this.storage - this.offs - this.end_offs) as usize,
                );
            }
        }
        if used > 0 {
            /* If there's no range coder data at all, give up. */
            if this.end_offs >= this.storage {
                this.error = -1;
            } else {
                l = -l;
                /* If we've busted, don't add too many extra bits to the last byte; it
                would corrupt the range coder data, and that's more important. */
                if this.offs + this.end_offs >= this.storage && l < used {
                    window &= (1u32 << l) - 1;
                    this.error = -1;
                }
                unsafe {
                    *this.buf.add((this.storage - this.end_offs - 1) as usize) |= window as u8;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::Rng;
    use crate::testutil::same_enc as same;
    use core::ffi::c_void;
    use minicelt_oracle as c;

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(12345);
        let mut n_err = 0;
        for iter in 0..3000 {
            let size = match iter % 4 {
                0 => rng.range(1, 6),
                1 => rng.range(1, 40),
                _ => rng.range(50, 400),
            } as usize;
            let mut bufr = vec![0xAAu8; size];
            let mut bufc = vec![0xAAu8; size];
            let mut er: ec_enc = unsafe { core::mem::zeroed() };
            let mut ec: ec_enc = unsafe { core::mem::zeroed() };
            ec_enc_init(&mut er, bufr.as_mut_ptr(), size as u32);
            unsafe { c::ec_enc_init(&mut ec as *mut ec_enc as *mut c_void, bufc.as_mut_ptr(), size as u32) };
            let nops = rng.range(1, 150);
            for op in 0..nops {
                match rng.range(0, 9) {
                    0 => {
                        let ft = rng.range(2, 65535) as u32;
                        let fl = rng.range(0, ft as i32 - 1) as u32;
                        let fh = rng.range(fl as i32 + 1, ft as i32) as u32;
                        ec_encode(&mut er, fl, fh, ft);
                        unsafe { c::ec_encode(&mut ec as *mut ec_enc as *mut c_void, fl, fh, ft) };
                    }
                    1 => {
                        let bits = rng.range(1, 15) as u32;
                        let ft = 1i32 << bits;
                        let fl = rng.range(0, ft - 1) as u32;
                        let fh = rng.range(fl as i32 + 1, ft) as u32;
                        ec_encode_bin(&mut er, fl, fh, bits);
                        unsafe { c::ec_encode_bin(&mut ec as *mut ec_enc as *mut c_void, fl, fh, bits) };
                    }
                    2 => {
                        let logp = rng.range(1, 15) as u32;
                        let v = rng.range(0, 1);
                        ec_enc_bit_logp(&mut er, v, logp);
                        unsafe { c::ec_enc_bit_logp(&mut ec as *mut ec_enc as *mut c_void, v, logp) };
                    }
                    3 | 4 => {
                        let n = rng.range(2, 12) as usize;
                        let ftb = rng.range(8, 15) as u32;
                        let total = 1i32 << ftb;
                        // strictly decreasing icdf ending at 0 (values <= 255 for u8 tables: ftb=8)
                        let ftb = if op % 2 == 0 { 8 } else { ftb };
                        let total = if ftb == 8 { 256 } else { total };
                        let mut cuts: Vec<i32> = (0..n - 1).map(|_| rng.range(1, total - 1)).collect();
                        cuts.sort();
                        cuts.dedup();
                        let mut icdf16: Vec<u16> = cuts.iter().rev().map(|&c| c as u16).collect();
                        icdf16.push(0);
                        let s = rng.range(0, icdf16.len() as i32 - 1);
                        if ftb == 8 {
                            let icdf: Vec<u8> = icdf16.iter().map(|&x| x as u8).collect();
                            ec_enc_icdf(&mut er, s, &icdf, ftb);
                            unsafe { c::ec_enc_icdf(&mut ec as *mut ec_enc as *mut c_void, s, icdf.as_ptr(), ftb) };
                        } else {
                            ec_enc_icdf16(&mut er, s, &icdf16, ftb);
                            unsafe { c::ec_enc_icdf16(&mut ec as *mut ec_enc as *mut c_void, s, icdf16.as_ptr(), ftb) };
                        }
                    }
                    5 => {
                        let ft = match rng.range(0, 2) {
                            0 => rng.range(2, 300) as u32,
                            1 => rng.range(2, 70000) as u32,
                            _ => rng.next_u32() >> rng.range(0, 8) as u32 | 2,
                        };
                        let fl = (rng.next_u32() as u64 % ft as u64) as u32;
                        ec_enc_uint(&mut er, fl, ft);
                        unsafe { c::ec_enc_uint(&mut ec as *mut ec_enc as *mut c_void, fl, ft) };
                    }
                    6 | 7 => {
                        let bits = rng.range(1, 25) as u32;
                        let fl = rng.next_u32() & ((1u32 << bits) - 1);
                        ec_enc_bits(&mut er, fl, bits);
                        unsafe { c::ec_enc_bits(&mut ec as *mut ec_enc as *mut c_void, fl, bits) };
                    }
                    8 => {
                        let nbits = rng.range(1, 8) as u32;
                        let v = rng.next_u32() & ((1u32 << nbits) - 1);
                        ec_enc_patch_initial_bits(&mut er, v, nbits);
                        unsafe { c::ec_enc_patch_initial_bits(&mut ec as *mut ec_enc as *mut c_void, v, nbits) };
                    }
                    _ => {
                        let used = er.offs + er.end_offs;
                        if used <= er.storage && rng.range(0, 3) == 0 {
                            let ns = rng.range(used as i32, er.storage as i32) as u32;
                            ec_enc_shrink(&mut er, ns);
                            unsafe { c::ec_enc_shrink(&mut ec as *mut ec_enc as *mut c_void, ns) };
                        }
                    }
                }
                same(&er, &ec);
            }
            ec_enc_done(&mut er);
            unsafe { c::ec_enc_done(&mut ec as *mut ec_enc as *mut c_void) };
            same(&er, &ec);
            assert_eq!(bufr, bufc, "iter {iter}");
            n_err += (er.error != 0) as i32;
        }
        assert!(n_err > 200 && n_err < 2800, "{n_err}");
    }
}
