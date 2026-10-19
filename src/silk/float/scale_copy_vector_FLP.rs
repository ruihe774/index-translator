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
