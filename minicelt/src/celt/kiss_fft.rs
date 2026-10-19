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

// group C: opus_fft_impl, opus_fft (forward only)
