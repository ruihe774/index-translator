//! Port of celt/celt.h and the encoder-side parts of celt/celt.c.

use super::arch::{COEF_ONE, IMAX};
use super::modes::CELTMode;
use super::pitch::comb_filter_const;

pub const LEAK_BANDS: usize = 19;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct AnalysisInfo {
    pub valid: i32,
    pub tonality: f32,
    pub tonality_slope: f32,
    pub noisiness: f32,
    pub activity: f32,
    pub music_prob: f32,
    pub music_prob_min: f32,
    pub music_prob_max: f32,
    pub bandwidth: i32,
    pub activity_probability: f32,
    pub max_pitch_ratio: f32,
    /* Store as Q6 char to save space. */
    pub leak_boost: [u8; LEAK_BANDS],
}

impl AnalysisInfo {
    pub const fn new_zeroed() -> Self {
        AnalysisInfo {
            valid: 0,
            tonality: 0.0,
            tonality_slope: 0.0,
            noisiness: 0.0,
            activity: 0.0,
            music_prob: 0.0,
            music_prob_min: 0.0,
            music_prob_max: 0.0,
            bandwidth: 0,
            activity_probability: 0.0,
            max_pitch_ratio: 0.0,
            leak_boost: [0; LEAK_BANDS],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct SILKInfo {
    pub signalType: i32,
    pub offset: i32,
}

#[inline(always)]
pub fn bits_to_bitrate(bits: i32, Fs: i32, frame_size: i32) -> i32 {
    bits * (6 * Fs / frame_size) / 6
}

#[inline(always)]
pub fn bitrate_to_bits(bitrate: i32, Fs: i32, frame_size: i32) -> i32 {
    bitrate * 6 / (6 * Fs / frame_size)
}

pub static trim_icdf: [u8; 11] = [126, 124, 119, 109, 87, 41, 19, 9, 4, 2, 0];
/* Probs: NONE: 21.875%, LIGHT: 6.25%, NORMAL: 65.625%, AGGRESSIVE: 6.25% */
pub static spread_icdf: [u8; 4] = [25, 23, 2, 0];
pub static tapset_icdf: [u8; 3] = [2, 1, 0];

pub const COMBFILTER_MAXPERIOD: i32 = 1024;
pub const COMBFILTER_MINPERIOD: i32 = 15;

pub fn init_caps(m: &CELTMode, cap: &mut [i32], LM: i32, C: i32) {
    for i in 0..m.nbEBands {
        let N = (m.eBands[i as usize + 1] as i32 - m.eBands[i as usize] as i32) << LM;
        cap[i as usize] =
            (m.cache.caps[(m.nbEBands * (2 * LM + C - 1) + i) as usize] as i32 + 64) * C * N >> 2;
    }
}

/* The tf_select_table second index is 4*isTransient + 2*tf_select + per_band_flag */
pub static tf_select_table: [[i8; 8]; 4] = [
    /*isTransient=0     isTransient=1 */
    [0, -1, 0, -1, 0, -1, 0, -1], /* 2.5 ms */
    [0, -1, 0, -2, 1, 0, 1, -1],  /* 5 ms */
    [0, -2, 0, -3, 2, 0, 1, -1],  /* 10 ms */
    [0, -2, 0, -3, 3, 0, 1, -1],  /* 20 ms */
];

// group D: comb_filter (+ comb_filter_const in pitch);
// group E: tf_select_table, celt_preemphasis (celt_encoder.c), resampling_factor is not needed (48 kHz only).

// ---- group D: comb_filter ----

/// Gains of the three comb filter tapsets (QCONST16(x,15) = x in float).
static gains: [[f32; 3]; 3] = [
    [0.3066406250, 0.2170410156, 0.1296386719],
    [0.4638671875, 0.2680664062, 0.0],
    [0.7998046875, 0.1000976562, 0.0],
];

/// Comb filter `y[i] = x[i] + taps` for i in 0..N, cross-fading from (T0,g0,tapset0) to
/// (T1,g1,tapset1) over `overlap` samples using `window`.
///
/// # Safety
/// `x` must have `max(T0,T1,15)+2` readable floats before it and `N` after it; `y` must have
/// `N` writable floats. `y == x` (in place) is allowed; the regions otherwise must not overlap.
/// `window` must have `overlap` entries.
pub unsafe fn comb_filter(
    y: *mut f32,
    x: *const f32,
    mut T0: i32,
    mut T1: i32,
    N: i32,
    g0: f32,
    g1: f32,
    tapset0: i32,
    tapset1: i32,
    window: &[f32],
    mut overlap: i32,
) {
    unsafe {
        if g0 == 0.0 && g1 == 0.0 {
            /* OPT: Happens to work without the OPUS_MOVE(), but only because the current encoder already copies x to y */
            if x != y as *const f32 {
                core::ptr::copy(x, y, N as usize);
            }
            return;
        }
        /* When the gain is zero, T0 and/or T1 is set to zero. We need
        to have then be at least 2 to avoid processing garbage data. */
        T0 = IMAX(T0, COMBFILTER_MINPERIOD);
        T1 = IMAX(T1, COMBFILTER_MINPERIOD);
        let g00 = g0 * gains[tapset0 as usize][0];
        let g01 = g0 * gains[tapset0 as usize][1];
        let g02 = g0 * gains[tapset0 as usize][2];
        let g10 = g1 * gains[tapset1 as usize][0];
        let g11 = g1 * gains[tapset1 as usize][1];
        let g12 = g1 * gains[tapset1 as usize][2];
        let (t0, t1) = (T0 as isize, T1 as isize);
        let mut x1 = *x.offset(-t1 + 1);
        let mut x2 = *x.offset(-t1);
        let mut x3 = *x.offset(-t1 - 1);
        let mut x4 = *x.offset(-t1 - 2);
        /* If the filter didn't change, we don't need the overlap */
        if g0 == g1 && T0 == T1 && tapset0 == tapset1 {
            overlap = 0;
        }
        let mut i: isize = 0;
        while i < overlap as isize {
            let x0 = *x.offset(i - t1 + 2);
            let f: f32 = window[i as usize] * window[i as usize];
            *y.offset(i) = *x.offset(i)
                + ((COEF_ONE - f) * g00) * *x.offset(i - t0)
                + ((COEF_ONE - f) * g01) * (*x.offset(i - t0 + 1) + *x.offset(i - t0 - 1))
                + ((COEF_ONE - f) * g02) * (*x.offset(i - t0 + 2) + *x.offset(i - t0 - 2))
                + (f * g10) * x2
                + (f * g11) * (x1 + x3)
                + (f * g12) * (x0 + x4);
            x4 = x3;
            x3 = x2;
            x2 = x1;
            x1 = x0;
            i += 1;
        }
        if g1 == 0.0 {
            /* OPT: Happens to work without the OPUS_MOVE(), but only because the current encoder already copies x to y */
            if x != y as *const f32 {
                core::ptr::copy(x.offset(overlap as isize), y.offset(overlap as isize), (N - overlap) as usize);
            }
            return;
        }

        /* Compute the part with the constant filter. */
        comb_filter_const(y.offset(i), x.offset(i), T1, N - i as i32, g10, g11, g12);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{Rng, c_mode};
    use minicelt_oracle as c;
    use std::vec::Vec;

    fn bits(v: &[f32]) -> Vec<u32> {
        v.iter().map(|x| x.to_bits()).collect()
    }

    #[test]
    fn comb_filter_matches_c() {
        let mut rng = Rng::new(7);
        let mi = c::mode_info(c_mode());
        assert_eq!(mi.overlap, 120);
        let window = unsafe { core::slice::from_raw_parts(mi.window, mi.overlap as usize) };
        const H: usize = 1040;
        for iter in 0..4000 {
            let overlap = if iter % 2 == 0 { 120 } else { 0 };
            let n = if iter % 5 == 0 { 120 } else { rng.range(120, 400) } as usize;
            let t0 = if iter % 7 == 0 { 0 } else { rng.range(15, 1024) };
            let t1 = match iter % 4 {
                0 => t0,
                1 => rng.range(0, 40),
                _ => rng.range(15, 1024),
            };
            let pick = |rng: &mut Rng, k: usize| if k == 0 { 0.0 } else { rng.f32_unit().abs() };
            let g0 = pick(&mut rng, if (iter / 3) % 5 == 0 { 0 } else { 1 });
            let mut g1 = pick(&mut rng, if (iter / 5) % 5 == 0 { 0 } else { 1 });
            if iter % 8 == 0 {
                g1 = g0;
            }
            let (ts0, ts1) = (rng.range(0, 2), if iter % 6 == 0 { 0 } else { rng.range(0, 2) });
            let ts1 = if iter % 8 == 0 { ts0 } else { ts1 };
            let in_place = iter % 3 == 0;
            let buf = rng.f32_vec(H + n + 16, 10000.0);
            let ybuf = rng.f32_vec(n + 16, 10000.0);
            let (mut br, mut bc) = (buf.clone(), buf.clone());
            let (mut yr, mut yc) = (ybuf.clone(), ybuf.clone());
            unsafe {
                let (xr, xc) = (br.as_mut_ptr().add(H), bc.as_mut_ptr().add(H));
                let (pyr, pyc) = if in_place { (xr, xc) } else { (yr.as_mut_ptr(), yc.as_mut_ptr()) };
                comb_filter(pyr, xr, t0, t1, n as i32, g0, g1, ts0, ts1, window, overlap);
                c::comb_filter(pyc, xc, t0, t1, n as i32, g0, g1, ts0, ts1, window.as_ptr(), overlap, 0);
            }
            let msg = std::format!("t0={t0} t1={t1} n={n} g0={g0} g1={g1} ts={ts0},{ts1} ov={overlap} ip={in_place}");
            assert_eq!(bits(&br), bits(&bc), "x {msg}");
            assert_eq!(bits(&yr), bits(&yc), "y {msg}");
        }
    }
}
