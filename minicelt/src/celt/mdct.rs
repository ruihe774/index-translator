//! Port of celt/mdct.h and celt/mdct.c (upstream libopus 1.6.1; forward MDCT, float build, non-PFA).
//! The twiddles are planar: `t[i]` = cos, `t[N4+i]` = -sin.

use super::kiss_fft::{kiss_fft_cpx, kiss_fft_state, kiss_twiddle_scalar, opus_fft_impl};
use crate::stack;

pub struct mdct_lookup {
    pub n: i32,
    pub maxshift: i32,
    pub kfft: [&'static kiss_fft_state; 4],
    pub trig: &'static [kiss_twiddle_scalar],
}

/// clt_mdct_forward_c. Forward MDCT (the C comment says it trashes the input array; it does not).
///
/// C passes pointers `in` and `out` into larger buffers; here `in_`/`out` are the whole buffers
/// and `in_off`/`out_off` the offsets of the C pointers, e.g. from compute_mdcts:
/// `clt_mdct_forward(&mode.mdct, &in_, c*(B*N+overlap)+b*N, &mut out, b+c*N*B, mode.window, overlap, shift, B)`.
/// `out` is written at `out_off + stride*k`.
pub fn clt_mdct_forward(
    l: &mdct_lookup,
    in_: &[f32],
    in_off: usize,
    out: &mut [f32],
    out_off: usize,
    window: &[f32],
    overlap: i32,
    shift: i32,
    stride: i32,
) {
    let st = l.kfft[shift as usize];
    let scale = st.scale;

    let mut N = l.n;
    let mut trig = 0usize;
    for _ in 0..shift {
        N >>= 1;
        trig += N as usize;
    }
    let trig = &l.trig[trig..];
    let N2 = (N >> 1) as usize;
    let N4 = (N >> 2) as usize;

    let sg = stack::save();
    let f = sg.alloc::<f32>(N2);
    let f2 = sg.alloc::<kiss_fft_cpx>(N4);

    let ov2 = (overlap >> 1) as usize;
    let nq = ((overlap + 3) >> 2) as usize;

    /* Consider the input to be composed of four blocks: [a, b, c, d] */
    /* Window, shuffle, fold */
    {
        /* xp2 steps downwards by 2 and may end one below the buffer start, so use signed indices. */
        let base = in_off as isize;
        let n2 = N2 as isize;
        let mut xp1: isize = base + ov2 as isize;
        let mut xp2: isize = base + n2 - 1 + ov2 as isize;
        let mut yp = 0usize;
        let mut wp1 = ov2;
        let mut wp2 = ov2 as isize - 1;
        let mut i = 0usize;
        while i < nq {
            /* Real part arranged as -d-cR, Imag part arranged as -b+aR*/
            f[yp] = in_[(xp1 + n2) as usize] * window[wp2 as usize] + in_[xp2 as usize] * window[wp1];
            f[yp + 1] = in_[xp1 as usize] * window[wp1] - in_[(xp2 - n2) as usize] * window[wp2 as usize];
            yp += 2;
            xp1 += 2;
            xp2 -= 2;
            wp1 += 2;
            wp2 -= 2;
            i += 1;
        }
        wp1 = 0;
        wp2 = overlap as isize - 1;
        while i < N4 - nq {
            /* Real part arranged as a-bR, Imag part arranged as -c-dR */
            f[yp] = in_[xp2 as usize];
            f[yp + 1] = in_[xp1 as usize];
            yp += 2;
            xp1 += 2;
            xp2 -= 2;
            i += 1;
        }
        while i < N4 {
            /* Real part arranged as a-bR, Imag part arranged as -c-dR */
            f[yp] = -(in_[(xp1 - n2) as usize] * window[wp1]) + in_[xp2 as usize] * window[wp2 as usize];
            f[yp + 1] = in_[xp1 as usize] * window[wp2 as usize] + in_[(xp2 + n2) as usize] * window[wp1];
            yp += 2;
            xp1 += 2;
            xp2 -= 2;
            wp1 += 2;
            wp2 -= 2;
            i += 1;
        }
    }
    /* Pre-rotation */
    for i in 0..N4 {
        let t0 = trig[i];
        let t1 = trig[N4 + i];
        let re = f[2 * i];
        let im = f[2 * i + 1];
        let yr = re * t0 - im * t1;
        let yi = im * t0 + re * t1;
        /* For floating-point it is best to scale after the rotation (no QEXT). */
        f2[st.bitrev[i] as usize] = kiss_fft_cpx { r: yr * scale, i: yi * scale };
    }

    /* N/4 complex FFT, does not downscale anymore */
    opus_fft_impl(st, f2);

    /* Post-rotate */
    {
        let mut yp1 = out_off;
        let mut yp2 = out_off + stride as usize * (N2 - 1);
        let stride2 = 2 * stride as usize;
        for i in 0..N4 {
            let t0 = trig[i];
            let t1 = trig[N4 + i];
            let fp = f2[i];
            let yr = fp.i * t1 - fp.r * t0;
            let yi = fp.r * t1 + fp.i * t0;
            out[yp1] = yr;
            out[yp2] = yi;
            yp1 += stride2;
            /* the last step may leave yp2 below out_off */
            yp2 = yp2.wrapping_sub(stride2);
        }
    }
}
