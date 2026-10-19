//! Port of silk/float/k2a_FLP.c.

/* step up function, converts reflection coefficients to prediction coefficients */
pub fn silk_k2a_FLP(
    A: &mut [f32],  /* O     prediction coefficients [order]                            */
    rc: &[f32],     /* I     reflection coefficients [order]                            */
    order: i32,     /* I     prediction order                                           */
) {
    for k in 0..order as usize {
        let rck: f32 = rc[k];
        for n in 0..(k + 1) >> 1 {
            let tmp1: f32 = A[n];
            let tmp2: f32 = A[k - n - 1];
            A[n] = tmp1 + tmp2 * rck;
            A[k - n - 1] = tmp2 + tmp1 * rck;
        }
        A[k] = -rck;
    }
}
