//! Port of celt/mathops.h and celt/mathops.c (float build, without FLOAT_APPROX).

use super::arch::{MAX16, MAX32, MIN16};

/// PI from celt/mathops.h (a double constant).
pub const PI: f64 = 3.1415926535897931;

pub fn celt_maxabs16(x: &[f32], len: i32) -> f32 {
    let mut maxval: f32 = 0.0;
    let mut minval: f32 = 0.0;
    for i in 0..len as usize {
        maxval = MAX16(maxval, x[i]);
        minval = MIN16(minval, x[i]);
    }
    MAX32(maxval, -minval)
}

/// celt_maxabs_res (float build) = celt_maxabs16.
#[inline(always)]
pub fn celt_maxabs_res(x: &[f32], len: i32) -> f32 {
    celt_maxabs16(x, len)
}

/// Calculates the arctangent of x using a Remez approximation of order 15,
/// incorporating only odd-powered terms.
#[inline]
pub fn celt_atan_norm(x: f32) -> f32 {
    const ATAN2_2_OVER_PI: f32 = 0.636619772367581;
    let x_sq = x * x;
    /* Polynomial coefficients approximated in the [0, 1] range.
     * Lolremez command: lolremez --degree 6 --range "0:1"
     *                   "(atan(sqrt(x))-sqrt(x))/(x*sqrt(x))" "1/(sqrt(x)*x)"
     * Please note that ATAN2_COEFF_A01 is fixed to 1.0f. */
    const ATAN2_COEFF_A03: f32 = -3.3331659436225891113281250000e-01;
    const ATAN2_COEFF_A05: f32 = 1.99627041816711425781250000000e-01;
    const ATAN2_COEFF_A07: f32 = -1.3976582884788513183593750000e-01;
    const ATAN2_COEFF_A09: f32 = 9.79423448443412780761718750000e-02;
    const ATAN2_COEFF_A11: f32 = -5.7773590087890625000000000000e-02;
    const ATAN2_COEFF_A13: f32 = 2.30401363223791122436523437500e-02;
    const ATAN2_COEFF_A15: f32 = -4.3554059229791164398193359375e-03;
    ATAN2_2_OVER_PI
        * (x + x
            * x_sq
            * (ATAN2_COEFF_A03
                + x_sq
                    * (ATAN2_COEFF_A05
                        + x_sq
                            * (ATAN2_COEFF_A07
                                + x_sq
                                    * (ATAN2_COEFF_A09
                                        + x_sq
                                            * (ATAN2_COEFF_A11
                                                + x_sq * (ATAN2_COEFF_A13 + x_sq * ATAN2_COEFF_A15)))))))
}

/// Calculates the arctangent of y/x, returning an approximate value in radians.
#[inline]
pub fn celt_atan2p_norm(y: f32, x: f32) -> f32 {
    debug_assert!(x >= 0.0 && y >= 0.0);
    /* For very small values, we don't care about the answer. */
    if (x * x + y * y) < 1e-18 {
        return 0.0;
    }
    if y < x { celt_atan_norm(y / x) } else { 1.0 - celt_atan_norm(x / y) }
}

/// `(float)sqrt(x)`; also celt_sqrt32.
#[inline(always)]
pub fn celt_sqrt(x: f32) -> f32 {
    libm::sqrt(x as f64) as f32
}
#[inline(always)]
pub fn celt_sqrt32(x: f32) -> f32 {
    celt_sqrt(x)
}
/// `1.f/celt_sqrt(x)`; also celt_rsqrt_norm, celt_rsqrt_norm32.
#[inline(always)]
pub fn celt_rsqrt(x: f32) -> f32 {
    1.0 / celt_sqrt(x)
}
#[inline(always)]
pub fn celt_rsqrt_norm(x: f32) -> f32 {
    celt_rsqrt(x)
}
#[inline(always)]
pub fn celt_rsqrt_norm32(x: f32) -> f32 {
    celt_rsqrt(x)
}
/// `(float)cos((.5f*PI)*(x))`
#[inline(always)]
pub fn celt_cos_norm(x: f32) -> f32 {
    libm::cos((0.5f32 as f64 * PI) * x as f64) as f32
}
/// `1.f/(x)`
#[inline(always)]
pub fn celt_rcp(x: f32) -> f32 {
    1.0 / x
}
/// `(float)(1.442695040888963387*log(x))`; also celt_log2_db.
#[inline(always)]
pub fn celt_log2(x: f32) -> f32 {
    (1.442695040888963387 * libm::log(x as f64)) as f32
}
/// `(float)exp(0.6931471805599453094*(x))`; also celt_exp2_db.
#[inline(always)]
pub fn celt_exp2(x: f32) -> f32 {
    libm::exp(0.6931471805599453094 * x as f64) as f32
}
#[inline(always)]
pub fn celt_log2_db(x: f32) -> f32 {
    celt_log2(x)
}
#[inline(always)]
pub fn celt_exp2_db(x: f32) -> f32 {
    celt_exp2(x)
}
