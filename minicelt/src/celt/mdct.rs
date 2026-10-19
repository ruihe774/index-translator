//! Port of celt/mdct.h and celt/mdct.c (forward MDCT, float build, non-PFA).

use super::kiss_fft::{kiss_fft_state, kiss_twiddle_scalar};

pub struct mdct_lookup {
    pub n: i32,
    pub maxshift: i32,
    pub kfft: [&'static kiss_fft_state; 4],
    pub trig: &'static [kiss_twiddle_scalar],
}

// group C: clt_mdct_forward
