//! Port of silk/float/scale_copy_vector_FLP.c.

/* copy and multiply a vector by a constant */
pub fn silk_scale_copy_vector_FLP(data_out: &mut [f32], data_in: &[f32], gain: f32, dataSize: i32) {
    /* 4x unrolled loop */
    let dataSize4 = (dataSize & 0xFFFC) as usize;
    let mut i = 0usize;
    while i < dataSize4 {
        data_out[i + 0] = gain * data_in[i + 0];
        data_out[i + 1] = gain * data_in[i + 1];
        data_out[i + 2] = gain * data_in[i + 2];
        data_out[i + 3] = gain * data_in[i + 3];
        i += 4;
    }

    /* any remaining elements */
    while i < dataSize as usize {
        data_out[i] = gain * data_in[i];
        i += 1;
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_scale_copy_vector_FLP(data_out: *mut f32, data_in: *const f32, gain: f32, dataSize: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(61);
        for n in 0..=100 {
            let x = rng.f32_vec(100, 20000.0);
            let gain = rng.f32_unit() * 3.0;
            let mut r = vec![7f32; 100];
            let mut e = r.clone();
            super::silk_scale_copy_vector_FLP(&mut r, &x, gain, n);
            unsafe { c::silk_scale_copy_vector_FLP(e.as_mut_ptr(), x.as_ptr(), gain, n) };
            for i in 0..100 {
                assert_eq!(r[i].to_bits(), e[i].to_bits(), "n {n} i {i}");
            }
        }
    }
}
