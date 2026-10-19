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
