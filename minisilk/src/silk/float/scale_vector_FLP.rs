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
