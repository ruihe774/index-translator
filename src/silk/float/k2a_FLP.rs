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

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_k2a_FLP(A: *mut f32, rc: *const f32, order: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(51);
        for order in [1, 2, 3, 10, 12, 16, 24] {
            for _ in 0..50 {
                let rc: Vec<f32> = rng.f32_vec(24, 0.95);
                let mut r = vec![0f32; 24];
                let mut e = r.clone();
                super::silk_k2a_FLP(&mut r, &rc, order);
                unsafe { c::silk_k2a_FLP(e.as_mut_ptr(), rc.as_ptr(), order) };
                for i in 0..24 {
                    assert_eq!(r[i].to_bits(), e[i].to_bits(), "order {order} i {i}");
                }
            }
        }
    }
}
