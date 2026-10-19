//! Port of silk/float/scale_vector_FLP.c.

/* multiply a vector by a constant */
pub fn silk_scale_vector_FLP(data1: &mut [f32], gain: f32, dataSize: i32) {
    /* 4x unrolled loop */
    let dataSize4 = (dataSize & 0xFFFC) as usize;
    let mut i = 0usize;
    while i < dataSize4 {
        data1[i + 0] *= gain;
        data1[i + 1] *= gain;
        data1[i + 2] *= gain;
        data1[i + 3] *= gain;
        i += 4;
    }

    /* any remaining elements */
    while i < dataSize as usize {
        data1[i] *= gain;
        i += 1;
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_scale_vector_FLP(data1: *mut f32, gain: f32, dataSize: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(71);
        for n in 0..=100 {
            let x = rng.f32_vec(100, 20000.0);
            let gain = rng.f32_unit() * 3.0;
            let (mut r, mut e) = (x.clone(), x.clone());
            super::silk_scale_vector_FLP(&mut r, gain, n);
            unsafe { c::silk_scale_vector_FLP(e.as_mut_ptr(), gain, n) };
            for i in 0..100 {
                assert_eq!(r[i].to_bits(), e[i].to_bits(), "n {n} i {i}");
            }
        }
    }
}
