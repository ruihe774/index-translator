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
