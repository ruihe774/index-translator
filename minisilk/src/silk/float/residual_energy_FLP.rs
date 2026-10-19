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
