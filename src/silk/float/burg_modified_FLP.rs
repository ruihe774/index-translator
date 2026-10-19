//! Port of silk/float/burg_modified_FLP.c.

use crate::silk::float::energy_FLP::silk_energy_FLP;
use crate::silk::float::inner_product_FLP::silk_inner_product_FLP;
use crate::silk::float::schur_FLP::SILK_MAX_ORDER_LPC;
use crate::silk::tuning_parameters::FIND_LPC_COND_FAC;

const MAX_FRAME_SIZE: i32 = 384; /* subfr_length * nb_subfr = ( 0.005 * 16000 + 16 ) * 4 = 384*/

/// Compute reflection coefficients from input signal. Returns residual energy.
pub fn silk_burg_modified_FLP(
    A: &mut [f32],       /* O    prediction coefficients (length order)                      */
    x: &[f32],           /* I    input signal, length: nb_subfr*(D+L_sub)                    */
    minInvGain: f32,     /* I    minimum inverse prediction gain                             */
    subfr_length: i32,   /* I    input signal subframe length (incl. D preceding samples)    */
    nb_subfr: i32,       /* I    number of subframes stacked in x                            */
    D: i32,              /* I    order                                                       */
) -> f32 {
    const MO: usize = SILK_MAX_ORDER_LPC;
    let mut C_first_row = [0f64; MO];
    let mut CAf = [0f64; MO + 1];
    let mut CAb = [0f64; MO + 1];
    let mut Af = [0f64; MO];

    debug_assert!(subfr_length * nb_subfr <= MAX_FRAME_SIZE);
    let (sl, nsf, d) = (subfr_length as usize, nb_subfr as usize, D as usize);
    let cond_fac = FIND_LPC_COND_FAC as f64;

    /* Compute autocorrelations, added over subframes */
    let mut C0: f64 = silk_energy_FLP(x, nb_subfr * subfr_length);
    for s in 0..nsf {
        let x_ptr = &x[s * sl..];
        for n in 1..d + 1 {
            C_first_row[n - 1] += silk_inner_product_FLP(x_ptr, &x_ptr[n..], subfr_length - n as i32);
        }
    }
    let mut C_last_row = C_first_row;

    /* Initialize */
    CAf[0] = C0 + cond_fac * C0 + 1e-9f32 as f64;
    CAb[0] = CAf[0];
    let mut invGain: f64 = 1.0;
    let mut reached_max_gain = false;
    for n in 0..d {
        /* Update first row of correlation matrix (without first element) */
        /* Update last row of correlation matrix (without last element, stored in reversed order) */
        /* Update C * Af */
        /* Update C * flipud(Af) (stored in reversed order) */
        for s in 0..nsf {
            let x_ptr = &x[s * sl..];
            let mut tmp1: f64 = x_ptr[n] as f64;
            let mut tmp2: f64 = x_ptr[sl - n - 1] as f64;
            for k in 0..n {
                /* the products of two floats are computed in float */
                C_first_row[k] -= (x_ptr[n] * x_ptr[n - k - 1]) as f64;
                C_last_row[k] -= (x_ptr[sl - n - 1] * x_ptr[sl - n + k]) as f64;
                let Atmp = Af[k];
                tmp1 += x_ptr[n - k - 1] as f64 * Atmp;
                tmp2 += x_ptr[sl - n + k] as f64 * Atmp;
            }
            #[allow(unused_mut)]
            let mut k0 = 0usize;
            /* With relaxed SIMD, clang auto-vectorizes this loop (2 lanes at a time) and fuses
            the multiply-subtracts into f64x2.relaxed_madd with the negated tmp1 / tmp2; the
            odd remaining iteration is computed by the scalar code (no fusion). */
            #[cfg(target_feature = "relaxed-simd")]
            {
                use core::arch::wasm32::*;
                let (m1, m2) = (f64x2_splat(-tmp1), f64x2_splat(-tmp2));
                while k0 + 2 <= n + 1 {
                    let k = k0;
                    let xf = f64x2(x_ptr[n - k] as f64, x_ptr[n - k - 1] as f64);
                    let xb = f64x2(x_ptr[sl - n + k - 1] as f64, x_ptr[sl - n + k] as f64);
                    let rf = f64x2_relaxed_madd(m1, xf, f64x2(CAf[k], CAf[k + 1]));
                    let rb = f64x2_relaxed_madd(m2, xb, f64x2(CAb[k], CAb[k + 1]));
                    CAf[k] = f64x2_extract_lane::<0>(rf);
                    CAf[k + 1] = f64x2_extract_lane::<1>(rf);
                    CAb[k] = f64x2_extract_lane::<0>(rb);
                    CAb[k + 1] = f64x2_extract_lane::<1>(rb);
                    k0 += 2;
                }
            }
            for k in k0..=n {
                CAf[k] -= tmp1 * x_ptr[n - k] as f64;
                CAb[k] -= tmp2 * x_ptr[sl - n + k - 1] as f64;
            }
        }
        let mut tmp1 = C_first_row[n];
        let mut tmp2 = C_last_row[n];
        for k in 0..n {
            let Atmp = Af[k];
            tmp1 += C_last_row[n - k - 1] * Atmp;
            tmp2 += C_first_row[n - k - 1] * Atmp;
        }
        CAf[n + 1] = tmp1;
        CAb[n + 1] = tmp2;

        /* Calculate nominator and denominator for the next order reflection (parcor) coefficient */
        let mut num = CAb[n + 1];
        let mut nrg_b = CAb[0];
        let mut nrg_f = CAf[0];
        for k in 0..n {
            let Atmp = Af[k];
            num += CAb[n - k] * Atmp;
            nrg_b += CAb[k + 1] * Atmp;
            nrg_f += CAf[k + 1] * Atmp;
        }
        debug_assert!(nrg_f > 0.0);
        debug_assert!(nrg_b > 0.0);

        /* Calculate the next order reflection (parcor) coefficient */
        let mut rc = -2.0 * num / (nrg_f + nrg_b);
        debug_assert!(rc > -1.0 && rc < 1.0);

        /* Update inverse prediction gain */
        let tmp1 = invGain * (1.0 - rc * rc);
        if tmp1 <= minInvGain as f64 {
            /* Max prediction gain exceeded; set reflection coefficient such that max prediction gain is exactly hit */
            rc = libm::sqrt(1.0 - minInvGain as f64 / invGain);
            if num > 0.0 {
                /* Ensure adjusted reflection coefficients has the original sign */
                rc = -rc;
            }
            invGain = minInvGain as f64;
            reached_max_gain = true;
        } else {
            invGain = tmp1;
        }

        /* Update the AR coefficients */
        for k in 0..(n + 1) >> 1 {
            let tmp1 = Af[k];
            let tmp2 = Af[n - k - 1];
            Af[k] = tmp1 + rc * tmp2;
            Af[n - k - 1] = tmp2 + rc * tmp1;
        }
        Af[n] = rc;

        if reached_max_gain {
            /* Reached max prediction gain; set remaining coefficients to zero and exit loop */
            for k in n + 1..d {
                Af[k] = 0.0;
            }
            break;
        }

        /* Update C * Af and C * Ab */
        #[allow(unused_mut)]
        let mut k0 = 0usize;
        /* With relaxed SIMD, clang auto-vectorizes this loop (2 lanes at a time) and fuses the
        multiply-adds into f64x2.relaxed_madd; the odd remaining iteration is scalar (no fusion). */
        #[cfg(target_feature = "relaxed-simd")]
        {
            use core::arch::wasm32::*;
            let rcv = f64x2_splat(rc);
            while k0 + 2 <= n + 2 {
                let k = k0;
                let old_f = f64x2(CAf[k], CAf[k + 1]);
                let ab = f64x2(CAb[n + 1 - k], CAb[n - k]);
                let nf = f64x2_relaxed_madd(rcv, ab, old_f);
                let nb = f64x2_relaxed_madd(rcv, old_f, ab);
                CAf[k] = f64x2_extract_lane::<0>(nf);
                CAf[k + 1] = f64x2_extract_lane::<1>(nf);
                CAb[n + 1 - k] = f64x2_extract_lane::<0>(nb);
                CAb[n - k] = f64x2_extract_lane::<1>(nb);
                k0 += 2;
            }
        }
        for k in k0..=n + 1 {
            let tmp1 = CAf[k];
            CAf[k] += rc * CAb[n + 1 - k];
            CAb[n + 1 - k] += rc * tmp1;
        }
    }

    let nrg_f: f64;
    if reached_max_gain {
        /* Convert to silk_float */
        for k in 0..d {
            A[k] = (-Af[k]) as f32;
        }
        /* Subtract energy of preceding samples from C0 */
        for s in 0..nsf {
            C0 -= silk_energy_FLP(&x[s * sl..], D);
        }
        /* Approximate residual energy */
        nrg_f = C0 * invGain;
    } else {
        /* Compute residual energy and store coefficients as silk_float */
        let mut nrg = CAf[0];
        let mut tmp1 = 1.0f64;
        for k in 0..d {
            let Atmp = Af[k];
            nrg += CAf[k + 1] * Atmp;
            tmp1 += Atmp * Atmp;
            A[k] = (-Atmp) as f32;
        }
        nrg -= cond_fac * C0 * tmp1;
        nrg_f = nrg;
    }

    /* Return residual energy */
    nrg_f as f32
}

#[cfg(test)]
mod tests {
    use crate::testutil::{Rng, SpeechGen};
    mod c {
        unsafe extern "C" {
            pub fn silk_burg_modified_FLP(A: *mut f32, x: *const f32, minInvGain: f32, subfr_length: i32, nb_subfr: i32, D: i32, arch: i32) -> f32;
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(151);
        let mut sg = SpeechGen::new(152);
        // (subfr_length incl. D preceding samples, nb_subfr, D): 16 kHz 20 ms: 80+D
        let cfgs = [(96, 4, 16), (92, 4, 12), (90, 4, 10), (88, 4, 8), (86, 4, 6), (96, 4, 16), (104, 3, 24), (64, 2, 16), (96, 4, 1)];
        for iter in 0..120 {
            for &(sl, nsf, d) in cfgs.iter() {
                let n = (sl * nsf) as usize;
                let x: Vec<f32> = match iter % 4 {
                    0 | 1 => (0..n).map(|_| sg.next_sample() as f32).collect(),
                    2 => rng.f32_vec(n, 8000.0),
                    // pure tone, drives the max-prediction-gain path
                    _ => (0..n).map(|i| (3000.0 * (i as f64 * 0.31).sin()) as f32).collect(),
                };
                let minInvGain = [1e-4f32, 1.0 / 1e4, 1e-6, 0.01][iter % 4];
                let (mut ra, mut ea) = ([0f32; 24], [0f32; 24]);
                let r = super::silk_burg_modified_FLP(&mut ra, &x, minInvGain, sl, nsf, d);
                let e = unsafe { c::silk_burg_modified_FLP(ea.as_mut_ptr(), x.as_ptr(), minInvGain, sl, nsf, d, 0) };
                assert_eq!(r.to_bits(), e.to_bits(), "iter {iter} cfg {sl} {nsf} {d}");
                for i in 0..24 {
                    assert_eq!(ra[i].to_bits(), ea[i].to_bits(), "iter {iter} cfg {sl} {nsf} {d} i {i}");
                }
            }
        }
    }
}
