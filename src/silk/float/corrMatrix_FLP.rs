//! Port of silk/float/corrMatrix_FLP.c.

/**********************************************************************
 * Correlation matrix computations for LS estimate.
 **********************************************************************/

use crate::silk::float::energy_FLP::silk_energy_FLP;
use crate::silk::float::inner_product_FLP::silk_inner_product_FLP;

/* Calculates correlation vector X'*t */
pub fn silk_corrVector_FLP(
    x: &[f32],      /* I    x vector [L+order-1] used to create X       */
    t: &[f32],      /* I    Target vector [L]                           */
    L: i32,         /* I    Length of vecors                            */
    Order: i32,     /* I    Max lag for correlation                     */
    Xt: &mut [f32], /* O    X'*t correlation vector [order]             */
) {
    /* ptr1 points to first sample of column 0 of X: X[:,0]; x[Order - 1 - lag] for column lag */
    for lag in 0..Order {
        /* Calculate X[:,lag]'*t */
        Xt[lag as usize] = silk_inner_product_FLP(&x[(Order - 1 - lag) as usize..], t, L) as f32;
    }
}

/* Calculates correlation matrix X'*X */
pub fn silk_corrMatrix_FLP(
    x: &[f32],       /* I    x vector [ L+order-1 ] used to create X     */
    L: i32,          /* I    Length of vectors                           */
    Order: i32,      /* I    Max lag for correlation                     */
    XX: &mut [f32],  /* O    X'*X correlation matrix [order x order]     */
) {
    // ptr1 = &x[Order - 1]: first sample of column 0 of X
    let p1 = (Order - 1) as isize;
    let at = |i: isize| x[i as usize];
    let (L_, Order_) = (L as isize, Order as usize);
    let mp = |row: usize, col: usize| row * Order_ + col;

    let mut energy: f64 = silk_energy_FLP(&x[p1 as usize..], L); /* X[:,0]'*X[:,0] */
    XX[mp(0, 0)] = energy as f32;
    for j in 1..Order_ {
        let jj = j as isize;
        /* Calculate X[:,j]'*X[:,j] */
        energy += (at(p1 - jj) * at(p1 - jj) - at(p1 + L_ - jj) * at(p1 + L_ - jj)) as f64;
        XX[mp(j, j)] = energy as f32;
    }

    // ptr2 = &x[Order - 2]: first sample of column 1 of X; decremented for each lag
    for lag in 1..Order_ {
        let p2 = p1 - lag as isize;
        /* Calculate X[:,0]'*X[:,lag] */
        energy = silk_inner_product_FLP(&x[p1 as usize..], &x[p2 as usize..], L);
        XX[mp(lag, 0)] = energy as f32;
        XX[mp(0, lag)] = energy as f32;
        /* Calculate X[:,j]'*X[:,j + lag] */
        for j in 1..(Order_ - lag) {
            let jj = j as isize;
            energy += (at(p1 - jj) * at(p2 - jj) - at(p1 + L_ - jj) * at(p2 + L_ - jj)) as f64;
            XX[mp(lag + j, j)] = energy as f32;
            XX[mp(j, lag + j)] = energy as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::{Rng, SpeechGen};
    mod c {
        unsafe extern "C" {
            pub fn silk_corrVector_FLP(x: *const f32, t: *const f32, L: i32, Order: i32, Xt: *mut f32, arch: i32);
            pub fn silk_corrMatrix_FLP(x: *const f32, L: i32, Order: i32, XX: *mut f32, arch: i32);
        }
    }

    fn signals() -> (Vec<f32>, Vec<f32>) {
        let mut sg = SpeechGen::new(101);
        let sp: Vec<f32> = (0..1000).map(|_| sg.next_sample() as f32).collect();
        (sp, Rng::new(102).f32_vec(1000, 20000.0))
    }

    #[test]
    fn corr_vector_matches_c() {
        let (sp, noise) = signals();
        let mut rng = Rng::new(103);
        for (L, Order) in [(80, 5), (96, 16), (80, 16), (336, 16), (80, 1), (7, 3), (200, 12), (81, 5)] {
            for (a, b) in [(&sp, &noise), (&sp, &sp), (&noise, &sp)] {
                let off = rng.range(0, 5) as usize;
                let x = &a[off..off + (L + Order - 1) as usize];
                let t = &b[off + 3..off + 3 + L as usize];
                let mut r = vec![0f32; 24];
                let mut e = r.clone();
                super::silk_corrVector_FLP(x, t, L, Order, &mut r);
                unsafe { c::silk_corrVector_FLP(x.as_ptr(), t.as_ptr(), L, Order, e.as_mut_ptr(), 0) };
                for i in 0..24 {
                    assert_eq!(r[i].to_bits(), e[i].to_bits(), "L {L} Order {Order} i {i}");
                }
            }
        }
    }

    #[test]
    fn corr_matrix_matches_c() {
        let (sp, noise) = signals();
        let mut rng = Rng::new(104);
        for (L, Order) in [(80, 5), (96, 16), (80, 16), (336, 16), (80, 1), (7, 3), (200, 12), (81, 5), (16, 2)] {
            for a in [&sp, &noise] {
                let off = rng.range(0, 5) as usize;
                let x = &a[off..off + (L + Order - 1) as usize];
                let mut r = vec![0f32; 256];
                let mut e = r.clone();
                super::silk_corrMatrix_FLP(x, L, Order, &mut r);
                unsafe { c::silk_corrMatrix_FLP(x.as_ptr(), L, Order, e.as_mut_ptr(), 0) };
                for i in 0..256 {
                    assert_eq!(r[i].to_bits(), e[i].to_bits(), "L {L} Order {Order} i {i}");
                }
            }
        }
    }
}
