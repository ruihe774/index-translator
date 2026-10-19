//! Port of celt/cwrs.c (encoder side, static pulse cache: no SMALL_FOOTPRINT, no CUSTOM_MODES).

use super::entcode::ec_enc;

/// Fixed interface (used by vq.rs): encodes the pulse vector `_y[..N]` with `K` pulses.
pub fn encode_pulses(_y: &[i32], N: i32, K: i32, enc: &mut ec_enc) {
    let _ = (_y, N, K, enc);
    todo!("group A")
}
