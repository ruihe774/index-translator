//! Port of celt/kiss_fft.h and celt/kiss_fft.c (forward FFT, float build, static twiddles).

pub const MAXFACTORS: usize = 8;

pub type kiss_fft_scalar = f32;
pub type kiss_twiddle_scalar = f32;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct kiss_fft_cpx {
    pub r: kiss_fft_scalar,
    pub i: kiss_fft_scalar,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct kiss_twiddle_cpx {
    pub r: kiss_twiddle_scalar,
    pub i: kiss_twiddle_scalar,
}

/// FFT state. The tables are static (static_modes_float.h); `arch_fft` is dropped.
pub struct kiss_fft_state {
    pub nfft: i32,
    pub scale: f32,
    pub shift: i32,
    pub factors: [i16; 2 * MAXFACTORS],
    pub bitrev: &'static [i16],
    pub twiddles: &'static [kiss_twiddle_cpx],
}


// SAFETY: repr(C) pair of f32, no padding, every bit pattern valid.
unsafe impl crate::stack::Pod for kiss_fft_cpx {}

/* The complex-math macros of _kiss_fft_guts.h (float build). Order of operations is kept. */

/// C_MUL(m,a,b): `m.r = a.r*b.r - a.i*b.i; m.i = a.r*b.i + a.i*b.r`
#[inline(always)]
fn C_MUL(a: kiss_fft_cpx, b: kiss_twiddle_cpx) -> kiss_fft_cpx {
    kiss_fft_cpx { r: a.r * b.r - a.i * b.i, i: a.r * b.i + a.i * b.r }
}
/// C_ADD(res,a,b)
#[inline(always)]
fn C_ADD(a: kiss_fft_cpx, b: kiss_fft_cpx) -> kiss_fft_cpx {
    kiss_fft_cpx { r: a.r + b.r, i: a.i + b.i }
}
/// C_SUB(res,a,b)
#[inline(always)]
fn C_SUB(a: kiss_fft_cpx, b: kiss_fft_cpx) -> kiss_fft_cpx {
    kiss_fft_cpx { r: a.r - b.r, i: a.i - b.i }
}
/// C_ADDTO(res,a)
#[inline(always)]
fn C_ADDTO(res: &mut kiss_fft_cpx, a: kiss_fft_cpx) {
    res.r += a.r;
    res.i += a.i;
}
/// HALF_OF(x): `(x)*.5f`
#[inline(always)]
fn HALF_OF(x: f32) -> f32 {
    x * 0.5
}

/// Radix-2 butterfly. `Fout` is the start of the FFT buffer.
fn kf_bfly2(Fout: &mut [kiss_fft_cpx], m: i32, N: i32) {
    // (m==1 is only used by CUSTOM_MODES.)
    let _ = m;
    let tw: f32 = 0.7071067812f32;
    /* We know that m==4 here because the radix-2 is just after a radix-4 */
    debug_assert!(m == 4);
    let mut o = 0usize;
    for _ in 0..N {
        let f = &mut Fout[o..o + 8];
        let mut t = f[4];
        f[4] = C_SUB(f[0], t);
        C_ADDTO(&mut f[0], t);

        t.r = (f[5].r + f[5].i) * tw;
        t.i = (f[5].i - f[5].r) * tw;
        f[5] = C_SUB(f[1], t);
        C_ADDTO(&mut f[1], t);

        t.r = f[6].i;
        t.i = -f[6].r;
        f[6] = C_SUB(f[2], t);
        C_ADDTO(&mut f[2], t);

        t.r = (f[7].i - f[7].r) * tw;
        t.i = (-(f[7].i + f[7].r)) * tw;
        f[7] = C_SUB(f[3], t);
        C_ADDTO(&mut f[3], t);
        o += 8;
    }
}

fn kf_bfly4(Fout: &mut [kiss_fft_cpx], fstride: usize, st: &kiss_fft_state, m: i32, N: i32, mm: i32) {
    if m == 1 {
        /* Degenerate case where all the twiddles are 1. */
        let mut o = 0usize;
        for _ in 0..N {
            let f = &mut Fout[o..o + 4];
            let scratch0 = C_SUB(f[0], f[2]);
            let f2 = f[2];
            C_ADDTO(&mut f[0], f2);
            let mut scratch1 = C_ADD(f[1], f[3]);
            f[2] = C_SUB(f[0], scratch1);
            C_ADDTO(&mut f[0], scratch1);
            scratch1 = C_SUB(f[1], f[3]);

            f[1].r = scratch0.r + scratch1.i;
            f[1].i = scratch0.i - scratch1.r;
            f[3].r = scratch0.r - scratch1.i;
            f[3].i = scratch0.i + scratch1.r;
            o += 4;
        }
    } else {
        let mut scratch = [kiss_fft_cpx::default(); 6];
        let m = m as usize;
        let m2 = 2 * m;
        let m3 = 3 * m;
        for i in 0..N as usize {
            let mut fo = i * mm as usize;
            let (mut tw1, mut tw2, mut tw3) = (0usize, 0usize, 0usize);
            /* m is guaranteed to be a multiple of 4. */
            for _ in 0..m {
                scratch[0] = C_MUL(Fout[fo + m], st.twiddles[tw1]);
                scratch[1] = C_MUL(Fout[fo + m2], st.twiddles[tw2]);
                scratch[2] = C_MUL(Fout[fo + m3], st.twiddles[tw3]);

                scratch[5] = C_SUB(Fout[fo], scratch[1]);
                C_ADDTO(&mut Fout[fo], scratch[1]);
                scratch[3] = C_ADD(scratch[0], scratch[2]);
                scratch[4] = C_SUB(scratch[0], scratch[2]);
                Fout[fo + m2] = C_SUB(Fout[fo], scratch[3]);
                tw1 += fstride;
                tw2 += fstride * 2;
                tw3 += fstride * 3;
                C_ADDTO(&mut Fout[fo], scratch[3]);

                Fout[fo + m].r = scratch[5].r + scratch[4].i;
                Fout[fo + m].i = scratch[5].i - scratch[4].r;
                Fout[fo + m3].r = scratch[5].r - scratch[4].i;
                Fout[fo + m3].i = scratch[5].i + scratch[4].r;
                fo += 1;
            }
        }
    }
}

fn kf_bfly3(Fout: &mut [kiss_fft_cpx], fstride: usize, st: &kiss_fft_state, m: i32, N: i32, mm: i32) {
    let m = m as usize;
    let m2 = 2 * m;
    let mut scratch = [kiss_fft_cpx::default(); 5];
    let epi3 = st.twiddles[fstride * m];
    for i in 0..N as usize {
        let mut fo = i * mm as usize;
        let (mut tw1, mut tw2) = (0usize, 0usize);
        /* For non-custom modes, m is guaranteed to be a multiple of 4. */
        let mut k = m;
        loop {
            scratch[1] = C_MUL(Fout[fo + m], st.twiddles[tw1]);
            scratch[2] = C_MUL(Fout[fo + m2], st.twiddles[tw2]);

            scratch[3] = C_ADD(scratch[1], scratch[2]);
            scratch[0] = C_SUB(scratch[1], scratch[2]);
            tw1 += fstride;
            tw2 += fstride * 2;

            Fout[fo + m].r = Fout[fo].r - HALF_OF(scratch[3].r);
            Fout[fo + m].i = Fout[fo].i - HALF_OF(scratch[3].i);

            /* C_MULBYSCALAR( scratch[0] , epi3.i ) */
            scratch[0].r *= epi3.i;
            scratch[0].i *= epi3.i;

            C_ADDTO(&mut Fout[fo], scratch[3]);

            Fout[fo + m2].r = Fout[fo + m].r + scratch[0].i;
            Fout[fo + m2].i = Fout[fo + m].i - scratch[0].r;

            Fout[fo + m].r = Fout[fo + m].r - scratch[0].i;
            Fout[fo + m].i = Fout[fo + m].i + scratch[0].r;

            fo += 1;
            k -= 1;
            if k == 0 {
                break;
            }
        }
    }
}

fn kf_bfly5(Fout: &mut [kiss_fft_cpx], fstride: usize, st: &kiss_fft_state, m: i32, N: i32, mm: i32) {
    let m = m as usize;
    let mut scratch = [kiss_fft_cpx::default(); 13];
    let ya = st.twiddles[fstride * m];
    let yb = st.twiddles[fstride * 2 * m];
    let tw = st.twiddles;

    for i in 0..N as usize {
        let f0 = i * mm as usize;
        let f1 = f0 + m;
        let f2 = f0 + 2 * m;
        let f3 = f0 + 3 * m;
        let f4 = f0 + 4 * m;

        /* For non-custom modes, m is guaranteed to be a multiple of 4. */
        for u in 0..m {
            scratch[0] = Fout[f0 + u];

            scratch[1] = C_MUL(Fout[f1 + u], tw[u * fstride]);
            scratch[2] = C_MUL(Fout[f2 + u], tw[2 * u * fstride]);
            scratch[3] = C_MUL(Fout[f3 + u], tw[3 * u * fstride]);
            scratch[4] = C_MUL(Fout[f4 + u], tw[4 * u * fstride]);

            scratch[7] = C_ADD(scratch[1], scratch[4]);
            scratch[10] = C_SUB(scratch[1], scratch[4]);
            scratch[8] = C_ADD(scratch[2], scratch[3]);
            scratch[9] = C_SUB(scratch[2], scratch[3]);

            Fout[f0 + u].r = Fout[f0 + u].r + (scratch[7].r + scratch[8].r);
            Fout[f0 + u].i = Fout[f0 + u].i + (scratch[7].i + scratch[8].i);

            scratch[5].r = scratch[0].r + (scratch[7].r * ya.r + scratch[8].r * yb.r);
            scratch[5].i = scratch[0].i + (scratch[7].i * ya.r + scratch[8].i * yb.r);

            scratch[6].r = scratch[10].i * ya.i + scratch[9].i * yb.i;
            scratch[6].i = -(scratch[10].r * ya.i + scratch[9].r * yb.i);

            Fout[f1 + u] = C_SUB(scratch[5], scratch[6]);
            Fout[f4 + u] = C_ADD(scratch[5], scratch[6]);

            scratch[11].r = scratch[0].r + (scratch[7].r * yb.r + scratch[8].r * ya.r);
            scratch[11].i = scratch[0].i + (scratch[7].i * yb.r + scratch[8].i * ya.r);
            scratch[12].r = scratch[9].i * ya.i - scratch[10].i * yb.i;
            scratch[12].i = scratch[10].r * yb.i - scratch[9].r * ya.i;

            Fout[f2 + u] = C_ADD(scratch[11], scratch[12]);
            Fout[f3 + u] = C_SUB(scratch[11], scratch[12]);
        }
    }
}

/// In-place FFT on bit-reversed input (`fft_downshift` is a no-op in the float build).
pub fn opus_fft_impl(st: &kiss_fft_state, fout: &mut [kiss_fft_cpx]) {
    let mut fstride = [0i32; MAXFACTORS];

    /* st->shift can be -1 */
    let shift = if st.shift > 0 { st.shift } else { 0 };

    fstride[0] = 1;
    let mut L = 0usize;
    let mut m;
    loop {
        let p = st.factors[2 * L] as i32;
        m = st.factors[2 * L + 1] as i32;
        fstride[L + 1] = fstride[L] * p;
        L += 1;
        if m == 1 {
            break;
        }
    }
    m = st.factors[2 * L - 1] as i32;
    for i in (0..L).rev() {
        let m2 = if i != 0 { st.factors[2 * i - 1] as i32 } else { 1 };
        match st.factors[2 * i] {
            2 => kf_bfly2(fout, m, fstride[i]),
            4 => kf_bfly4(fout, (fstride[i] << shift) as usize, st, m, fstride[i], m2),
            3 => kf_bfly3(fout, (fstride[i] << shift) as usize, st, m, fstride[i], m2),
            5 => kf_bfly5(fout, (fstride[i] << shift) as usize, st, m, fstride[i], m2),
            _ => {}
        }
        m = m2;
    }
}

/// opus_fft_c: forward FFT, `fin` and `fout` must not alias. The encoder only uses
/// `opus_fft_impl` (via the MDCT); this is the test entry point against C.
#[cfg(test)]
pub fn opus_fft(st: &kiss_fft_state, fin: &[kiss_fft_cpx], fout: &mut [kiss_fft_cpx]) {
    let scale = st.scale;

    /* Bit-reverse the input */
    for i in 0..st.nfft as usize {
        let x = fin[i];
        let b = st.bitrev[i] as usize;
        fout[b].r = x.r * scale;
        fout[b].i = x.i * scale;
    }
    opus_fft_impl(st, fout);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::celt::modes::mode48000_960_120;
    use crate::testutil::Rng;
    use core::ffi::c_void;
    use minicelt_oracle as c;

    fn bits(v: &[kiss_fft_cpx]) -> Vec<(u32, u32)> {
        v.iter().map(|x| (x.r.to_bits(), x.i.to_bits())).collect()
    }

    fn rand_cpx(rng: &mut Rng, n: usize, scale: f32) -> Vec<kiss_fft_cpx> {
        (0..n).map(|_| kiss_fft_cpx { r: rng.f32_unit() * scale, i: rng.f32_unit() * scale }).collect()
    }

    #[test]
    fn opus_fft_matches_c() {
        let mi = c::mode_info(c::mode48000());
        let mut rng = Rng::new(7);
        for shift in 0..4 {
            let st = mode48000_960_120.mdct.kfft[shift];
            let cst = mi.kfft[shift];
            assert_eq!(st.nfft, 480 >> shift);
            let n = st.nfft as usize;
            for iter in 0..300 {
                let scale = [1.0, 1e-3, 1e4, 30000.0][iter % 4];
                let fin = rand_cpx(&mut rng, n, scale);
                let mut fo_r = vec![kiss_fft_cpx { r: f32::from_bits(0x7fc00001), i: 0.0 }; n];
                let mut fo_c = fo_r.clone();
                opus_fft(st, &fin, &mut fo_r);
                unsafe { c::opus_fft_c(cst, fin.as_ptr() as *const c_void, fo_c.as_mut_ptr() as *mut c_void) };
                assert_eq!(bits(&fo_r), bits(&fo_c), "nfft {n} iter {iter}");
            }
        }
    }

    #[test]
    fn opus_fft_impl_matches_c() {
        // opus_fft_impl on arbitrary (not bit-reversed) data is the same code path in C via opus_fft_c
        // with scale; here only check that opus_fft_impl is what opus_fft uses.
        let st = mode48000_960_120.mdct.kfft[3];
        let mut rng = Rng::new(3);
        let fin = rand_cpx(&mut rng, 60, 1.0);
        let mut a = vec![kiss_fft_cpx::default(); 60];
        for i in 0..60 {
            a[st.bitrev[i] as usize] = kiss_fft_cpx { r: fin[i].r * st.scale, i: fin[i].i * st.scale };
        }
        opus_fft_impl(st, &mut a);
        let mut b = vec![kiss_fft_cpx::default(); 60];
        opus_fft(st, &fin, &mut b);
        assert_eq!(bits(&a), bits(&b));
    }

    #[test]
    fn bfly2_matches_c() {
        let mut rng = Rng::new(11);
        for iter in 0..200 {
            let n = 1 + iter % 8;
            let v = rand_cpx(&mut rng, 8 * n, 100.0);
            let mut a = v.clone();
            let mut b = v.clone();
            kf_bfly2(&mut a, 4, n as i32);
            unsafe { c::oracle_kf_bfly2(b.as_mut_ptr() as *mut c_void, 4, n as i32) };
            assert_eq!(bits(&a), bits(&b));
        }
    }

    #[test]
    fn bfly4_m1_matches_c() {
        let mi = c::mode_info(c::mode48000());
        let st = mode48000_960_120.mdct.kfft[0];
        let mut rng = Rng::new(12);
        for iter in 0..200 {
            let n = 1 + iter % 30;
            let v = rand_cpx(&mut rng, 4 * n, 100.0);
            let mut a = v.clone();
            let mut b = v.clone();
            kf_bfly4(&mut a, 1, st, 1, n as i32, 1);
            unsafe { c::oracle_kf_bfly4(b.as_mut_ptr() as *mut c_void, 1, mi.kfft[0], 1, n as i32, 1) };
            assert_eq!(bits(&a), bits(&b));
        }
    }
}
