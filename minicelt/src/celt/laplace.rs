//! Port of celt/laplace.c (encoder side).

use super::entcode::ec_enc;

/// Fixed interface (used by quant_bands.rs).
pub fn ec_laplace_encode(enc: &mut ec_enc, value: &mut i32, fs: u32, decay: i32) {
    let _ = (enc, value, fs, decay);
    todo!("group A")
}
