//! Port of silk/float/regularize_correlations_FLP.c.

/// Add noise to matrix diagonal
pub fn silk_regularize_correlations_FLP(
    XX: &mut [f32], /* I/O  Correlation matrices                        */
    xx: &mut [f32], /* I/O  Correlation values                          */
    noise: f32,     /* I    Noise energy to add                         */
    D: i32,         /* I    Dimension of XX                             */
) {
    let D = D as usize;
    for i in 0..D {
        /* matrix_ptr( &XX[ 0 ], i, i, D ) */
        XX[i * D + i] += noise;
    }
    xx[0] += noise;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::silk::float::encode_frame_FLP::tests::c;
    use crate::testutil::Rng;

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(91);
        for _ in 0..1000 {
            let D = rng.range(1, 16) as usize;
            let XX = rng.f32_vec(D * D, 1000.0);
            let xx = rng.f32_vec(1, 1000.0);
            let noise = rng.f32_unit().abs() * 10.0;
            let (mut a, mut b) = (XX.clone(), XX);
            let (mut p, mut q) = (xx.clone(), xx);
            silk_regularize_correlations_FLP(&mut a, &mut p, noise, D as i32);
            unsafe { c::silk_regularize_correlations_FLP(b.as_mut_ptr(), q.as_mut_ptr(), noise, D as i32) };
            assert!(a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()));
            assert_eq!(p[0].to_bits(), q[0].to_bits());
        }
    }
}
