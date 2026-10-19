//! Port of celt/mathops.h and celt/mathops.c (float build, without FLOAT_APPROX).

use super::arch::{MAX16, MAX32, MIN16};

/// PI from celt/mathops.h (a double constant).
pub const PI: f64 = 3.1415926535897931;

/// Integer square root.
pub fn isqrt32(mut _val: u32) -> u32 {
    /*Uses the second method from
       http://www.azillionmonkeys.com/qed/sqroot.html
      The main idea is to search for the largest binary digit b such that
       (g+b)*(g+b) <= _val, and add it to the solution g.*/
    let mut g: u32 = 0;
    let mut bshift: i32 = (super::entcode::EC_ILOG(_val) - 1) >> 1;
    let mut b: u32 = 1u32 << bshift;
    loop {
        let t: u32 = ((g << 1) + b) << bshift;
        if t <= _val {
            g += b;
            _val -= t;
        }
        b >>= 1;
        bshift -= 1;
        if bshift < 0 {
            break;
        }
    }
    g
}

pub fn celt_maxabs16(x: &[f32], len: i32) -> f32 {
    let mut maxval: f32 = 0.0;
    let mut minval: f32 = 0.0;
    for i in 0..len as usize {
        maxval = MAX16(maxval, x[i]);
        minval = MIN16(minval, x[i]);
    }
    MAX32(maxval, -minval)
}

/// celt_maxabs32 (float build) = celt_maxabs16; celt_maxabs_res likewise.
#[inline(always)]
pub fn celt_maxabs32(x: &[f32], len: i32) -> f32 {
    celt_maxabs16(x, len)
}
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

/// Computes estimated cosine values for (PI/2 * x) using only terms with even
/// exponents.
#[inline]
pub fn celt_cos_norm2(mut x: f32) -> f32 {
    /* Restrict x to [-1, 3]. */
    x = (x as f64 - 4.0 * libm::floor(0.25 * (x + 1.0) as f64)) as f32;
    /* Negative sign for [1, 3]. */
    let output_sign: i32 = 1 - 2 * (x > 1.0) as i32;
    /* Restrict to [-1, 1]. */
    x -= (2 * (x > 1.0) as i32) as f32;
    /* The cosine function, cos(x), has a Taylor series representation consisting
     * exclusively of even-powered polynomial terms. */
    let x_norm_sq = x * x;
    /* Polynomial coefficients approximated in the [0, 1] range using only terms
     * with even exponents.
     * Lolremez command: lolremez --degree 4 --range 0:1 "cos(sqrt(x)*pi*0.5)" */
    const COS_COEFF_A0: f32 = 9.999999403953552246093750000000e-01;
    const COS_COEFF_A2: f32 = -1.233698248863220214843750000000000;
    const COS_COEFF_A4: f32 = 2.536507546901702880859375000000e-01;
    const COS_COEFF_A6: f32 = -2.08106283098459243774414062500e-02;
    const COS_COEFF_A8: f32 = 8.581906440667808055877685546875e-04;
    output_sign as f32
        * (COS_COEFF_A0
            + x_norm_sq * (COS_COEFF_A2 + x_norm_sq * (COS_COEFF_A4 + x_norm_sq * (COS_COEFF_A6 + x_norm_sq * COS_COEFF_A8))))
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
