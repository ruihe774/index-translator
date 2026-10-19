//! Port of celt/float_cast.h.

/// float2int (lrintf): round to nearest, ties to even (`f32.nearest`).
#[inline(always)]
pub fn float2int(x: f32) -> i32 {
    libm::rintf(x) as i32
}

#[inline(always)]
pub fn FLOAT2INT16(mut x: f32) -> i16 {
    x = x * super::arch::CELT_SIG_SCALE;
    x = super::arch::MAX32(x, -32768.0);
    x = super::arch::MIN32(x, 32767.0);
    float2int(x) as i16
}
