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
