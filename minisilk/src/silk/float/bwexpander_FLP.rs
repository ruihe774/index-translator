//! Port of silk/float/bwexpander_FLP.c.

/* Chirp (bw expand) LP AR filter */
pub fn silk_bwexpander_FLP(
    ar: &mut [f32], /* I/O  AR filter to be expanded (without leading 1)                */
    d: i32,         /* I    length of ar                                                */
    chirp: f32,     /* I    chirp factor (typically in range (0..1) )                   */
) {
    let mut cfac: f32 = chirp;

    for i in 0..(d - 1) as usize {
        ar[i] *= cfac;
        cfac *= chirp;
    }
    ar[(d - 1) as usize] *= cfac;
}
