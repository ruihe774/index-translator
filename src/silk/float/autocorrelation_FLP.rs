//! Port of silk/float/autocorrelation_FLP.c.

use crate::silk::float::inner_product_FLP::silk_inner_product_FLP;

/* compute autocorrelation */
pub fn silk_autocorrelation_FLP(
    results: &mut [f32],    /* O    result (length correlationCount)                            */
    inputData: &[f32],      /* I    input data to correlate                                     */
    inputDataSize: i32,     /* I    length of input                                             */
    mut correlationCount: i32, /* I    number of correlation taps to compute                       */
) {
    if correlationCount > inputDataSize {
        correlationCount = inputDataSize;
    }

    for i in 0..correlationCount {
        results[i as usize] =
            silk_inner_product_FLP(inputData, &inputData[i as usize..], inputDataSize - i) as f32;
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::{Rng, SpeechGen};
    mod c {
        unsafe extern "C" {
            pub fn silk_autocorrelation_FLP(results: *mut f32, inputData: *const f32, inputDataSize: i32, correlationCount: i32, arch: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(21);
        let mut sg = SpeechGen::new(22);
        let sp: Vec<f32> = (0..1000).map(|_| sg.next_sample() as f32).collect();
        let noise = rng.f32_vec(1000, 20000.0);
        let mut cases = vec![(384, 17), (320, 25), (384, 25), (160, 17), (10, 17), (0, 5), (1, 1), (5, 5)];
        for _ in 0..100 {
            cases.push((rng.range(0, 450), rng.range(1, 30)));
        }
        for (size, count) in cases {
            for src in [&sp, &noise] {
                let off = rng.range(0, 7) as usize;
                let x = &src[off..off + size as usize];
                let mut r = vec![0f32; 32];
                let mut e = r.clone();
                super::silk_autocorrelation_FLP(&mut r, x, size, count);
                unsafe { c::silk_autocorrelation_FLP(e.as_mut_ptr(), x.as_ptr(), size, count, 0) };
                for i in 0..32 {
                    assert_eq!(r[i].to_bits(), e[i].to_bits(), "size {size} count {count} i {i}");
                }
            }
        }
    }
}
