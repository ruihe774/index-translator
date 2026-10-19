//! Port of celt/entcode.h and celt/entcode.c (encoder side).

#![allow(non_camel_case_types)]

pub type ec_window = u32;

pub const EC_WINDOW_SIZE: i32 = 32;
/// The number of bits to use for the range-coded part of unsigned integers.
pub const EC_UINT_BITS: i32 = 8;
/// The resolution of fractional-precision bit usage measurements, i.e., 3 => 1/8th bits.
pub const BITRES: i32 = 3;

/// The entropy encoder/decoder context.
#[repr(C)]
pub struct ec_ctx {
    /// Buffered input/output.
    pub buf: *mut u8,
    /// The size of the buffer.
    pub storage: u32,
    /// The offset at which the last byte containing raw bits was read/written.
    pub end_offs: u32,
    /// Bits that will be read from/written at the end.
    pub end_window: ec_window,
    /// Number of valid bits in end_window.
    pub nend_bits: i32,
    /// The total number of whole bits read/written.
    /// This does not include partial bits currently in the range coder.
    pub nbits_total: i32,
    /// The offset at which the next range coder byte will be read/written.
    pub offs: u32,
    /// The number of values in the current range.
    pub rng: u32,
    /// In the encoder: the low end of the current range.
    pub val: u32,
    /// In the encoder: the number of outstanding carry propagating symbols.
    pub ext: u32,
    /// A buffered input/output symbol, awaiting carry propagation.
    pub rem: i32,
    /// Nonzero if an error occurred.
    pub error: i32,
}

pub type ec_enc = ec_ctx;

/// EC_ILOG: number of bits needed to represent `v` (C: undefined for 0; 0 here).
#[inline(always)]
pub fn ec_ilog(v: u32) -> i32 {
    32 - v.leading_zeros() as i32
}

#[inline(always)]
pub fn EC_ILOG(v: u32) -> i32 {
    ec_ilog(v)
}

#[inline(always)]
pub fn ec_range_bytes(this: &ec_ctx) -> u32 {
    this.offs
}

#[inline(always)]
pub fn ec_get_buffer(this: &ec_ctx) -> *mut u8 {
    this.buf
}

#[inline(always)]
pub fn ec_get_error(this: &ec_ctx) -> i32 {
    this.error
}

/// Returns the number of bits "used" by the encoded or decoded symbols so far.
#[inline(always)]
pub fn ec_tell(this: &ec_ctx) -> i32 {
    this.nbits_total - ec_ilog(this.rng)
}

/// Returns the number of bits used so far, scaled by 2**BITRES.
pub fn ec_tell_frac(this: &ec_ctx) -> u32 {
    /* This is a faster version of ec_tell_frac() that takes advantage
    of the low (1/8 bit) resolution to use just a linear function
    followed by a lookup to determine the exact transition thresholds. */
    static correction: [u32; 8] = [35733, 38967, 42495, 46340, 50535, 55109, 60097, 65535];
    let nbits = (this.nbits_total as u32) << BITRES;
    let mut l = ec_ilog(this.rng);
    let r = this.rng >> (l - 16);
    let mut b = ((r >> 12) - 8) as usize;
    b += (r > correction[b]) as usize;
    l = (l << 3) + b as i32;
    nbits.wrapping_sub(l as u32)
}

/// celt_udiv (no small-division table on wasm).
#[inline(always)]
pub fn celt_udiv(n: u32, d: u32) -> u32 {
    n / d
}

#[inline(always)]
pub fn celt_sudiv(n: i32, d: i32) -> i32 {
    n / d
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::Rng;
    mod c {
        use super::super::ec_ctx;
        unsafe extern "C" {
            pub fn ec_tell_frac(this: *mut ec_ctx) -> u32;
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(7);
        for _ in 0..20000 {
            let mut ctx: ec_ctx = unsafe { core::mem::zeroed() };
            // rng is always > EC_CODE_BOT (2^23) after normalization
            ctx.rng = (rng.next_u32() >> rng.range(0, 9)).max((1 << 23) + 1);
            ctx.nbits_total = 33 + rng.range(0, 5000);
            assert_eq!(ec_tell_frac(&ctx), unsafe { c::ec_tell_frac(&mut ctx) });
            assert_eq!(ec_tell(&ctx), ctx.nbits_total - (32 - ctx.rng.leading_zeros() as i32));
        }
    }
}

/// Helpers shared by the differential tests of the entropy coding modules.
#[cfg(test)]
pub mod tests_support {
    use super::*;

    /// A Rust-initialized encoder writing into `buf` (the buffer must outlive the encoder).
    pub fn new_enc(buf: &mut [u8]) -> ec_enc {
        let mut e: ec_enc = unsafe { core::mem::zeroed() };
        crate::celt::entenc::ec_enc_init(&mut e, buf.as_mut_ptr(), buf.len() as u32);
        e
    }

    /// Asserts that all encoder fields are equal.
    pub fn same_enc(a: &ec_enc, b: &ec_enc) {
        assert_eq!(a.storage, b.storage);
        assert_eq!(a.end_offs, b.end_offs);
        assert_eq!(a.end_window, b.end_window);
        assert_eq!(a.nend_bits, b.nend_bits);
        assert_eq!(a.nbits_total, b.nbits_total);
        assert_eq!(a.offs, b.offs);
        assert_eq!(a.rng, b.rng);
        assert_eq!(a.val, b.val);
        assert_eq!(a.ext, b.ext);
        assert_eq!(a.rem, b.rem);
        assert_eq!(a.error, b.error);
        assert_eq!(ec_tell(a), ec_tell(b));
        assert_eq!(ec_tell_frac(a), ec_tell_frac(b));
    }
}
