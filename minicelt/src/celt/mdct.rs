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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::celt::modes::mode48000_960_120;
    use crate::testutil::{Rng, music};
    use minicelt_oracle as c;

    fn bits(v: &[f32]) -> Vec<u32> {
        v.iter().map(|x| x.to_bits()).collect()
    }

    fn run(shift: i32, stride: i32, input: &[f32], in_off: usize, out_off: usize, out_len: usize) {
        let mi = c::mode_info(c::mode48000());
        let window = unsafe { core::slice::from_raw_parts(mi.window, mi.overlap as usize) };
        let overlap = mi.overlap;
        let sentinel = f32::from_bits(0x7fc00123);
        let mut out_r = vec![sentinel; out_len];
        let mut out_c = out_r.clone();
        clt_mdct_forward(&mode48000_960_120.mdct, input, in_off, &mut out_r, out_off, window, overlap, shift, stride);
        let mut in_c = input.to_vec();
        unsafe {
            c::clt_mdct_forward_c(
                mi.mdct,
                in_c.as_mut_ptr().add(in_off),
                out_c.as_mut_ptr().add(out_off),
                window.as_ptr(),
                overlap,
                shift,
                stride,
                0,
            )
        };
        assert_eq!(bits(&out_r), bits(&out_c), "shift {shift} stride {stride}");
    }

    #[test]
    fn mdct_forward_matches_c_random() {
        let mut rng = Rng::new(21);
        for iter in 0..200 {
            let shift = (iter % 4) as i32;
            let n2 = 960usize >> shift;
            let stride = [1, 2, 4, 8, 3][iter / 4 % 5] as i32;
            let in_off = (iter % 7) * 5;
            let input = rng.f32_vec(in_off + n2 + 120 + 8, [1.0, 1e4, 1e-3][iter % 3]);
            let out_off = iter % stride as usize;
            run(shift, stride, &input, in_off, out_off, n2 * stride as usize + out_off + 3);
        }
    }

    /// The calls of compute_mdcts: one long block per channel (B=1, shift = maxLM-LM) and
    /// short blocks (B=8, N=120, shift=3) interleaved with stride B.
    #[test]
    fn mdct_forward_matches_c_music() {
        let frames = music(5, 12, 960 + 120, 2);
        for f in &frames {
            for ch in 0..2 {
                let chan: Vec<f32> = f.chunks(2).map(|p| p[ch] * 32768.0).collect();
                for lm in 0..4 {
                    let shift = 3 - lm;
                    let n = 120usize << lm;
                    let b_count = 960 / n;
                    // short blocks: B = 960/N sub-frames, stride B
                    let mut inbuf = chan.clone();
                    inbuf.resize(b_count * n + 120 + n, 0.0);
                    for b in 0..b_count {
                        run(shift, b_count as i32, &inbuf, b * n, b, n * b_count);
                    }
                }
                run(0, 1, &chan, 0, 0, 960);
            }
        }
    }
}
