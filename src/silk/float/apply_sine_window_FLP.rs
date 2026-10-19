//! Port of silk/float/apply_sine_window_FLP.c.

use crate::silk::float::sigproc_flp::PI;

/* Apply sine window to signal vector   */
/* Window types:                        */
/*  1 -> sine window from 0 to pi/2     */
/*  2 -> sine window from pi/2 to pi    */
pub fn silk_apply_sine_window_FLP(
    px_win: &mut [f32], /* O    Pointer to windowed signal                  */
    px: &[f32],         /* I    Pointer to input signal                     */
    win_type: i32,      /* I    Selects a window type                       */
    length: i32,        /* I    Window length, multiple of 4                */
) {
    debug_assert!(win_type == 1 || win_type == 2);
    /* Length must be multiple of 4 */
    debug_assert!((length & 3) == 0);

    let freq: f32 = PI / (length + 1) as f32;

    /* Approximation of 2 * cos(f) */
    let c: f32 = 2.0f32 - freq * freq;

    /* Initialize state */
    let (mut S0, mut S1): (f32, f32);
    if win_type < 2 {
        /* Start from 0 */
        S0 = 0.0f32;
        /* Approximation of sin(f) */
        S1 = freq;
    } else {
        /* Start from 1 */
        S0 = 1.0f32;
        /* Approximation of cos(f) */
        S1 = 0.5f32 * c;
    }

    /* Uses the recursive equation:   sin(n*f) = 2 * cos(f) * sin((n-1)*f) - sin((n-2)*f)   */
    /* 4 samples at a time */
    let mut k = 0usize;
    while k < length as usize {
        px_win[k + 0] = px[k + 0] * 0.5f32 * (S0 + S1);
        px_win[k + 1] = px[k + 1] * S1;
        S0 = c * S1 - S0;
        px_win[k + 2] = px[k + 2] * 0.5f32 * (S1 + S0);
        px_win[k + 3] = px[k + 3] * S0;
        S1 = c * S0 - S1;
        k += 4;
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::{Rng, SpeechGen};
    mod c {
        unsafe extern "C" {
            pub fn silk_apply_sine_window_FLP(px_win: *mut f32, px: *const f32, win_type: i32, length: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(11);
        let mut sg = SpeechGen::new(12);
        let sp: Vec<f32> = (0..512).map(|_| sg.next_sample() as f32).collect();
        let noise = rng.f32_vec(512, 30000.0);
        for length in (0..=400).step_by(4) {
            for win_type in 1..=2 {
                for src in [&sp, &noise] {
                    let mut r = vec![0f32; length as usize];
                    let mut e = r.clone();
                    super::silk_apply_sine_window_FLP(&mut r, src, win_type, length);
                    unsafe { c::silk_apply_sine_window_FLP(e.as_mut_ptr(), src.as_ptr(), win_type, length) };
                    let (r, e): (Vec<u32>, Vec<u32>) = (r.iter().map(|x| x.to_bits()).collect(), e.iter().map(|x| x.to_bits()).collect());
                    assert_eq!(r, e, "length {length} type {win_type}");
                }
            }
        }
    }
}
