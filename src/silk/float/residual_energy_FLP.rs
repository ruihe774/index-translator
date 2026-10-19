//! Port of silk/float/residual_energy_FLP.c.

use crate::silk::define::*;
use crate::silk::float::LPC_analysis_filter_FLP::silk_LPC_analysis_filter_FLP;
use crate::silk::float::energy_FLP::silk_energy_FLP;

const MAX_ITERATIONS_RESIDUAL_NRG: i32 = 10;
const REGULARIZATION_FACTOR: f32 = 1e-8;

/// Residual energy: nrg = wxx - 2 * wXx * c + c' * wXX * c
pub fn silk_residual_energy_covar_FLP(
    c: &[f32],      /* I    Filter coefficients                         */
    wXX: &mut [f32], /* I/O  Weighted correlation matrix, reg. out       */
    wXx: &[f32],    /* I    Weighted correlation vector                 */
    wxx: f32,       /* I    Weighted correlation value                  */
    D: i32,         /* I    Dimension                                   */
) -> f32 {
    /* Safety checks */
    debug_assert!(D >= 0);
    let D = D as usize;
    /* column-based matrix_c_ptr( wXX, row, col, D ) */
    let mc = |row: usize, col: usize| row + D * col;

    let mut nrg: f32 = 0.0;
    let mut regularization: f32 = REGULARIZATION_FACTOR * (wXX[0] + wXX[D * D - 1]);
    let mut k = 0;
    while k < MAX_ITERATIONS_RESIDUAL_NRG {
        nrg = wxx;

        let mut tmp: f32 = 0.0;
        for i in 0..D {
            tmp += wXx[i] * c[i];
        }
        nrg -= 2.0f32 * tmp;

        /* compute c' * wXX * c, assuming wXX is symmetric */
        for i in 0..D {
            tmp = 0.0;
            for j in i + 1..D {
                tmp += wXX[mc(i, j)] * c[j];
            }
            nrg += c[i] * (2.0f32 * tmp + wXX[mc(i, i)] * c[i]);
        }
        if nrg > 0.0 {
            break;
        } else {
            /* Add white noise */
            for i in 0..D {
                wXX[mc(i, i)] += regularization;
            }
            /* Increase noise for next run */
            regularization *= 2.0f32;
        }
        k += 1;
    }
    if k == MAX_ITERATIONS_RESIDUAL_NRG {
        /* silk_assert( nrg == 0 ) in C; not checked, nrg may be a tiny negative value */
        nrg = 1.0f32;
    }

    nrg
}

/// Calculates residual energies of input subframes where all subframes have LPC_order
/// of preceding samples
pub fn silk_residual_energy_FLP(
    nrgs: &mut [f32],                         /* O    Residual energy per subframe [MAX_NB_SUBFR] */
    x: &[f32],                                /* I    Input signal                                */
    a: &[[f32; MAX_LPC_ORDER as usize]; 2],   /* I    AR coefs for each frame half                */
    gains: &[f32],                            /* I    Quantization gains                          */
    subfr_length: i32,                        /* I    Subframe length                             */
    nb_subfr: i32,                            /* I    number of subframes                         */
    LPC_order: i32,                           /* I    LPC order                                   */
) {
    let mut LPC_res = [0f32; ((MAX_FRAME_LENGTH + MAX_NB_SUBFR * MAX_LPC_ORDER) / 2) as usize];

    let LPC_res_ptr = LPC_order as usize;
    let shift = LPC_order + subfr_length;
    let sh = shift as usize;

    /* Filter input to create the LPC residual for each frame half, and measure subframe energies */
    silk_LPC_analysis_filter_FLP(&mut LPC_res, &a[0], &x[0 * sh..], 2 * shift, LPC_order);
    nrgs[0] = ((gains[0] * gains[0]) as f64 * silk_energy_FLP(&LPC_res[LPC_res_ptr + 0 * sh..], subfr_length)) as f32;
    nrgs[1] = ((gains[1] * gains[1]) as f64 * silk_energy_FLP(&LPC_res[LPC_res_ptr + 1 * sh..], subfr_length)) as f32;

    if nb_subfr == MAX_NB_SUBFR {
        silk_LPC_analysis_filter_FLP(&mut LPC_res, &a[1], &x[2 * sh..], 2 * shift, LPC_order);
        nrgs[2] = ((gains[2] * gains[2]) as f64 * silk_energy_FLP(&LPC_res[LPC_res_ptr + 0 * sh..], subfr_length)) as f32;
        nrgs[3] = ((gains[3] * gains[3]) as f64 * silk_energy_FLP(&LPC_res[LPC_res_ptr + 1 * sh..], subfr_length)) as f32;
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::{Rng, SpeechGen};
    mod c {
        unsafe extern "C" {
            pub fn silk_residual_energy_covar_FLP(c: *const f32, wXX: *mut f32, wXx: *const f32, wxx: f32, D: i32) -> f32;
            pub fn silk_residual_energy_FLP(nrgs: *mut f32, x: *const f32, a: *const [f32; 16], gains: *const f32, subfr_length: i32, nb_subfr: i32, LPC_order: i32);
        }
    }

    #[test]
    fn covar_matches_c() {
        let mut rng = Rng::new(141);
        let mut sg = SpeechGen::new(142);
        for iter in 0..300 {
            let D = [1usize, 2, 5, 10, 16][iter % 5];
            let sig: Vec<f32> = (0..96 + 20).map(|_| sg.next_sample() as f32).collect();
            // wXX = X'X (symmetric, PSD), wXx and wxx from the same data
            let mut wXX = vec![0f32; 256];
            for i in 0..D {
                for j in 0..D {
                    wXX[i + D * j] = (0..96).map(|n| sig[n + i] as f64 * sig[n + j] as f64).sum::<f64>() as f32;
                }
            }
            let wXx: Vec<f32> = (0..D).map(|i| (0..96).map(|n| sig[n + i] as f64 * sig[n + 3] as f64).sum::<f64>() as f32).collect();
            let wxx: f32 = (0..96).map(|n| sig[n + 3] as f64 * sig[n + 3] as f64).sum::<f64>() as f32;
            let mut c = rng.f32_vec(D, 1.0);
            let mut wxx = wxx;
            if iter % 4 == 0 {
                // force the regularisation path (negative energy)
                for v in c.iter_mut() {
                    *v *= 50.0;
                }
                wxx *= 0.01;
            }
            if iter % 11 == 0 {
                wxx = -1.0; // never positive: hits all 10 iterations
                wXX[0] = 0.0;
            }
            let (mut a, mut b) = (wXX.clone(), wXX.clone());
            let r = super::silk_residual_energy_covar_FLP(&c, &mut a, &wXx, wxx, D as i32);
            let e = unsafe { c::silk_residual_energy_covar_FLP(c.as_ptr(), b.as_mut_ptr(), wXx.as_ptr(), wxx, D as i32) };
            assert_eq!(r.to_bits(), e.to_bits(), "iter {iter}");
            for i in 0..256 {
                assert_eq!(a[i].to_bits(), b[i].to_bits(), "iter {iter} i {i}");
            }
        }
    }

    #[test]
    fn residual_energy_matches_c() {
        let mut rng = Rng::new(143);
        let mut sg = SpeechGen::new(144);
        for order in [10, 12, 16] {
            for subfr in [80, 40] {
                for nb_subfr in [4, 2] {
                    let n = (order + subfr) as usize * nb_subfr as usize;
                    let x: Vec<f32> = (0..n).map(|_| sg.next_sample() as f32).collect();
                    let mut a = [[0f32; 16]; 2];
                    for h in 0..2 {
                        for i in 0..16 {
                            a[h][i] = rng.f32_unit() * 0.5;
                        }
                    }
                    let gains: Vec<f32> = (0..4).map(|_| 1.0 + 100.0 * (rng.f32_unit() + 1.0)).collect();
                    let (mut r, mut e) = ([7f32; 4], [7f32; 4]);
                    super::silk_residual_energy_FLP(&mut r, &x, &a, &gains, subfr, nb_subfr, order);
                    unsafe { c::silk_residual_energy_FLP(e.as_mut_ptr(), x.as_ptr(), a.as_ptr(), gains.as_ptr(), subfr, nb_subfr, order) };
                    for i in 0..4 {
                        assert_eq!(r[i].to_bits(), e[i].to_bits(), "order {order} i {i}");
                    }
                }
            }
        }
    }
}
