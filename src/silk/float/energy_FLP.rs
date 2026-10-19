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

#[cfg(test)]
mod tests {
    use crate::testutil::{Rng, SpeechGen};
    mod c {
        unsafe extern "C" {
            pub fn silk_energy_FLP(data: *const f32, dataSize: i32) -> f64;
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(41);
        let mut sg = SpeechGen::new(42);
        let sp: Vec<f32> = (0..1000).map(|_| sg.next_sample() as f32).collect();
        let noise = rng.f32_vec(1000, 20000.0);
        for n in 0..=400usize {
            for src in [&sp, &noise] {
                let off = rng.range(0, 7) as usize;
                let x = &src[off..off + n];
                let r = super::silk_energy_FLP(x, n as i32);
                let e = unsafe { c::silk_energy_FLP(x.as_ptr(), n as i32) };
                assert_eq!(r.to_bits(), e.to_bits(), "n = {n}");
            }
        }
    }
}
