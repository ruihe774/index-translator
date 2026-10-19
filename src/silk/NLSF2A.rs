//! Port of silk/NLSF2A.c.

/* conversion between prediction filter coefficients and LSFs   */
/* order should be even                                         */
/* a piecewise linear approximation maps LSF <-> cos(LSF)       */
/* therefore the result is not accurate LSFs, but the two       */
/* functions are accurate inverses of each other                */

use crate::silk::LPC_fit::silk_LPC_fit;
use crate::silk::LPC_inv_pred_gain::silk_LPC_inverse_pred_gain;
use crate::silk::bwexpander_32::silk_bwexpander_32;
use crate::silk::define::*;
use crate::silk::macros::*;
use crate::silk::tables::silk_LSFCosTab_FIX_Q12;

const QA: i32 = 16;

const HALF_MAX: usize = (MAX_LPC_ORDER / 2 + 1) as usize;

/// helper function for NLSF2A(..)
/// `out`: intermediate polynomial, QA [dd+1]; `cLSF`: vector of interleaved 2*cos(LSFs), QA [d];
/// `dd`: polynomial order (= 1/2 * filter order)
#[inline(always)]
fn silk_NLSF2A_find_poly(out: &mut [i32; HALF_MAX], cLSF: &[i32], dd: i32) {
    out[0] = silk_LSHIFT(1, QA);
    out[1] = -cLSF[0];
    for k in 1..dd as usize {
        let ftmp = cLSF[2 * k]; /* QA*/
        out[k + 1] = silk_LSHIFT(out[k - 1], 1) - silk_RSHIFT_ROUND64(silk_SMULL(ftmp, out[k]), QA) as i32;
        for n in (2..=k).rev() {
            out[n] += out[n - 2] - silk_RSHIFT_ROUND64(silk_SMULL(ftmp, out[n - 1]), QA) as i32;
        }
        out[1] -= ftmp;
    }
}

/// compute whitening filter coefficients from normalized line spectral frequencies
/// `a_Q12`: monic whitening filter coefficients in Q12, [ d ] (O);
/// `NLSF`: normalized line spectral frequencies in Q15, [ d ];
/// `d`: filter order (should be even)
pub fn silk_NLSF2A(a_Q12: &mut [i16], NLSF: &[i16], d: i32) {
    /* This ordering was found to maximize quality. It improves numerical accuracy of
    silk_NLSF2A_find_poly() compared to "standard" ordering. */
    static ordering16: [u8; 16] = [0, 15, 8, 7, 4, 11, 12, 3, 2, 13, 10, 5, 6, 9, 14, 1];
    static ordering10: [u8; 10] = [0, 9, 6, 3, 4, 5, 8, 1, 2, 7];

    let mut cos_LSF_QA = [0i32; MAX_LPC_ORDER as usize];
    let mut P = [0i32; HALF_MAX];
    let mut Q = [0i32; HALF_MAX];
    let mut a32_QA1 = [0i32; MAX_LPC_ORDER as usize];

    debug_assert!(LSF_COS_TAB_SZ_FIX == 128);
    debug_assert!(d == 10 || d == 16);

    /* convert LSFs to 2*cos(LSF), using piecewise linear curve from table */
    let ordering: &[u8] = if d == 16 { &ordering16 } else { &ordering10 };
    for k in 0..d as usize {
        debug_assert!(NLSF[k] >= 0);

        /* f_int on a scale 0-127 (rounded down) */
        let f_int = silk_RSHIFT(NLSF[k] as i32, 15 - 7);

        /* f_frac, range: 0..255 */
        let f_frac = NLSF[k] as i32 - silk_LSHIFT(f_int, 15 - 7);

        debug_assert!(f_int >= 0);
        debug_assert!(f_int < LSF_COS_TAB_SZ_FIX);

        /* Read start and end value from table */
        let cos_val = silk_LSFCosTab_FIX_Q12[f_int as usize] as i32; /* Q12 */
        let delta = silk_LSFCosTab_FIX_Q12[f_int as usize + 1] as i32 - cos_val; /* Q12, with a range of 0..200 */

        /* Linear interpolation */
        cos_LSF_QA[ordering[k] as usize] =
            silk_RSHIFT_ROUND(silk_LSHIFT(cos_val, 8) + silk_MUL(delta, f_frac), 20 - QA); /* QA */
    }

    let dd = silk_RSHIFT(d, 1);

    /* generate even and odd polynomials using convolution */
    silk_NLSF2A_find_poly(&mut P, &cos_LSF_QA[0..], dd);
    silk_NLSF2A_find_poly(&mut Q, &cos_LSF_QA[1..], dd);

    /* convert even and odd polynomials to opus_int32 Q12 filter coefs */
    for k in 0..dd as usize {
        let Ptmp = P[k + 1] + P[k];
        let Qtmp = Q[k + 1] - Q[k];

        /* the Ptmp and Qtmp values at this stage need to fit in int32 */
        a32_QA1[k] = -Qtmp - Ptmp; /* QA+1 */
        a32_QA1[d as usize - k - 1] = Qtmp - Ptmp; /* QA+1 */
    }

    /* Convert int32 coefficients to Q12 int16 coefs */
    silk_LPC_fit(a_Q12, &mut a32_QA1, 12, QA + 1, d);

    let mut i = 0;
    while silk_LPC_inverse_pred_gain(a_Q12, d) == 0 && i < MAX_LPC_STABILIZE_ITERATIONS {
        /* Prediction coefficients are (too close to) unstable; apply bandwidth expansion   */
        /* on the unscaled coefficients, convert to Q12 and measure again                   */
        silk_bwexpander_32(&mut a32_QA1, d, 65536 - silk_LSHIFT(2, i));
        for k in 0..d as usize {
            a_Q12[k] = silk_RSHIFT_ROUND(a32_QA1[k], QA + 1 - 12) as i16; /* QA+1 -> Q12 */
        }
        i += 1;
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::silk::NLSF_stabilize::silk_NLSF_stabilize;
    use crate::silk::tables::silk_NLSF_CB_WB;
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_NLSF2A(a_Q12: *mut i16, NLSF: *const i16, d: i32, arch: i32);
        }
    }

    /// WB codebook minimum NLSF spacing (17 entries).
    pub fn delta_min() -> &'static [i16] {
        unsafe { core::slice::from_raw_parts(silk_NLSF_CB_WB.deltaMin_Q15, 17) }
    }

    /// A valid 16-element NLSF vector: sorted, spaced, in (0, 32767).
    pub fn random_nlsf(rng: &mut Rng) -> [i16; 16] {
        let mut n = [0i16; 16];
        if rng.range(0, 1) == 0 {
            // uniformly spread with jitter, like real speech NLSFs
            for i in 0..16 {
                let centre = (i as i32 + 1) * 32768 / 17;
                n[i] = (centre + rng.range(-900, 900)) as i16;
            }
        } else {
            // random sorted values, forced apart by the stabilizer
            let mut v: Vec<i16> = (0..16).map(|_| rng.range(1, 32766) as i16).collect();
            v.sort();
            n.copy_from_slice(&v);
        }
        silk_NLSF_stabilize(&mut n, delta_min(), 16);
        n
    }

    /// A stable monic LPC filter in Q12 (from decaying random reflection coefficients).
    pub fn random_stable_a_Q12(rng: &mut Rng, d: usize) -> Vec<i16> {
        loop {
            let g = 0.3 + 0.55 * (rng.f32_unit() as f64 * 0.5 + 0.5);
            let amp = 0.2 + 0.7 * (rng.f32_unit() as f64 * 0.5 + 0.5);
            let mut a = vec![0f64; d];
            let mut gk = 1.0;
            for m in 0..d {
                let k = rng.f32_unit() as f64 * amp * gk;
                gk *= g;
                // Levinson step-up
                let prev = a.clone();
                for j in 0..m {
                    a[j] = prev[j] + k * prev[m - 1 - j];
                }
                a[m] = k;
            }
            // predictor convention of silk: A(z) = 1 - sum a_i z^-i, a_i = a[i] * 4096
            let q: Vec<f64> = a.iter().map(|x| (x * 4096.0).round()).collect();
            if q.iter().all(|x| x.abs() < 32000.0) {
                return q.iter().map(|&x| x as i16).collect();
            }
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(30);
        for t in 0..4000 {
            let mut nlsf = random_nlsf(&mut rng);
            let d = if t % 5 == 4 { 10 } else { 16 };
            if d == 10 {
                for i in 0..10 {
                    nlsf[i] = ((i as i32 + 1) * 32768 / 11 + rng.range(-1500, 1500)) as i16;
                }
            }
            let (mut a1, mut a2) = ([0i16; 16], [0i16; 16]);
            super::silk_NLSF2A(&mut a1, &nlsf, d);
            unsafe { c::silk_NLSF2A(a2.as_mut_ptr(), nlsf.as_ptr(), d, 0) };
            assert_eq!(a1, a2, "d={d} nlsf={nlsf:?}");
        }
    }

    /// Extreme NLSFs (clustered, at the borders) give near-unstable filters, so that the
    /// LPC_fit clipping and the stabilization loop run.
    #[test]
    fn extreme_nlsf_matches_c() {
        let mut rng = Rng::new(31);
        for t in 0..4000 {
            let mut nlsf = [0i16; 16];
            let mut v: Vec<i16> = match t % 4 {
                0 => (0..16).map(|_| rng.range(0, 40) as i16).collect(),
                1 => (0..16).map(|_| rng.range(32700, 32767) as i16).collect(),
                2 => {
                    let c = rng.range(500, 32000);
                    (0..16).map(|_| (c + rng.range(-3, 3)) as i16).collect()
                }
                _ => (0..16).map(|_| rng.range(0, 32767) as i16).collect(),
            };
            v.sort();
            nlsf.copy_from_slice(&v);
            let (mut a1, mut a2) = ([0i16; 16], [0i16; 16]);
            super::silk_NLSF2A(&mut a1, &nlsf, 16);
            unsafe { c::silk_NLSF2A(a2.as_mut_ptr(), nlsf.as_ptr(), 16, 0) };
            assert_eq!(a1, a2, "nlsf={nlsf:?}");
        }
    }
}
