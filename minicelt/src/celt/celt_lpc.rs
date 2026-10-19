//! Port of celt/celt_lpc.c (float build): `_celt_lpc` and `_celt_autocorr` only.

use super::pitch::celt_pitch_xcorr;
use crate::stack;

/// `_lpc`: out, `[0..p-1]` LPC coefficients; `ac`: in, `[0..p]` autocorrelation values.
pub fn _celt_lpc(_lpc: &mut [f32], ac: &[f32], p: i32) {
    let p = p as usize;
    let lpc = &mut _lpc[..p];
    let mut error: f32 = ac[0];

    lpc.fill(0.0);
    if ac[0] > 1e-10 {
        for i in 0..p {
            /* Sum up this iteration's reflection coefficient */
            let mut rr: f32 = 0.0;
            for j in 0..i {
                rr += lpc[j] * ac[i - j];
            }
            rr += ac[i + 1];
            let r: f32 = -(rr / error);
            /*  Update LPC coefficients and total error */
            lpc[i] = r;
            for j in 0..(i + 1) >> 1 {
                let tmp1 = lpc[j];
                let tmp2 = lpc[i - 1 - j];
                lpc[j] = tmp1 + r * tmp2;
                lpc[i - 1 - j] = tmp2 + r * tmp1;
            }

            error = error - (r * r) * error;
            /* Bail out once we get 30 dB gain */
            if error <= 0.001 * ac[0] {
                break;
            }
        }
    }
}

/// `x`: in, `[0..n-1]` samples; `ac`: out, `[0..lag]` autocorrelation values (`lag+1` entries).
/// `window` is only read when `overlap > 0`. Returns the (always 0 in float) shift.
pub fn _celt_autocorr(x: &[f32], ac: &mut [f32], window: &[f32], overlap: i32, lag: i32, n: i32) -> i32 {
    let fastN = n - lag;
    let st = stack::save();
    let xx = st.alloc::<f32>(n as usize);
    debug_assert!(n > 0);
    debug_assert!(overlap >= 0);
    let (nu, ov, lagu) = (n as usize, overlap as usize, lag as usize);
    assert!(x.len() >= nu && ac.len() > lagu);
    let xptr: &[f32] = if overlap == 0 {
        x
    } else {
        xx[..nu].copy_from_slice(&x[..nu]);
        for i in 0..ov {
            let w = window[i];
            xx[i] = x[i] * w;
            xx[nu - i - 1] = x[nu - i - 1] * w;
        }
        xx
    };
    let shift = 0;
    celt_pitch_xcorr(xptr, xptr, ac, fastN, lag + 1);
    for k in 0..=lagu {
        let mut d: f32 = 0.0;
        for i in k + fastN as usize..nu {
            d = d + xptr[i] * xptr[i - k];
        }
        ac[k] += d;
    }
    shift
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
    fn autocorr_and_lpc_match_c() {
        let mut rng = Rng::new(6);
        let mi = c::mode_info(c_mode());
        let window = unsafe { core::slice::from_raw_parts(mi.window, mi.overlap as usize) };
        for iter in 0..1500 {
            let lag = [4, 4, 24, rng.range(1, 30)][iter % 4];
            let n = rng.range(lag + 1, 1000);
            let overlap = if iter % 3 == 0 { rng.range(1, (n / 2).min(120)) } else { 0 };
            let scale = [1.0f32, 1000.0, 30000.0][iter % 3];
            let mut x = rng.f32_vec(n as usize + 4, scale);
            if iter % 7 == 0 {
                for (i, v) in x.iter_mut().enumerate() {
                    *v = scale * libm::sinf(i as f32 * 0.1);
                }
            }
            let mut ar = rng.f32_vec(lag as usize + 5, 1.0);
            let mut ac = ar.clone();
            let sr = _celt_autocorr(&x, &mut ar, window, overlap, lag, n);
            let mut xc = x.clone();
            let sc = unsafe { c::_celt_autocorr(xc.as_mut_ptr(), ac.as_mut_ptr(), window.as_ptr(), overlap, lag, n, 0) };
            assert_eq!(sr, sc);
            assert_eq!(bits(&ar), bits(&ac), "autocorr n={n} lag={lag} overlap={overlap}");

            // _celt_lpc on a conditioned autocorrelation, and on arbitrary/degenerate inputs
            let p = lag.min(24);
            let mut a = ar[..p as usize + 1].to_vec();
            if iter % 11 == 0 {
                a[0] = 0.0;
            } else if iter % 13 == 0 {
                a[0] = 1e-11;
            } else {
                a[0] *= 1.0001;
            }
            let mut lr = rng.f32_vec(p as usize + 3, 1.0);
            let mut lc = lr.clone();
            _celt_lpc(&mut lr, &a, p);
            unsafe { c::_celt_lpc(lc.as_mut_ptr(), a.as_ptr(), p) };
            assert_eq!(bits(&lr), bits(&lc), "lpc p={p}");
        }
    }
}
