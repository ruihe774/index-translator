//! Port of silk/float/energy_FLP.c.

/// sum of squares of a silk_float array, with result as double
pub fn silk_energy_FLP(data: &[f32], dataSize: i32) -> f64 {
    let n = dataSize.max(0) as usize;
    let data = &data[..n];

    /* 4x unrolled loop */
    let mut result: f64 = 0.0;
    let mut i = 0usize;
    while i + 3 < n {
        result += data[i + 0] as f64 * data[i + 0] as f64
            + data[i + 1] as f64 * data[i + 1] as f64
            + data[i + 2] as f64 * data[i + 2] as f64
            + data[i + 3] as f64 * data[i + 3] as f64;
        i += 4;
    }

    /* add any remaining products */
    while i < n {
        result += data[i] as f64 * data[i] as f64;
        i += 1;
    }

    debug_assert!(result >= 0.0);
    result
}
