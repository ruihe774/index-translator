//! Shared helpers for the differential tests against the C oracle (`minicelt-oracle`).

#![allow(dead_code)]

extern crate std;

use std::vec::Vec;

use crate::celt::entcode::{ec_enc, ec_tell, ec_tell_frac};

/// Small deterministic PRNG (xorshift64*).
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545F4914F6CDD1D)
    }
    pub fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }
    /// Uniform signed value that fits in `bits` bits (two's complement), 1 <= bits <= 32.
    pub fn i32_bits(&mut self, bits: u32) -> i32 {
        ((self.next_u32() as i32) >> (32 - bits)) as i32
    }
    /// Uniform in [lo, hi] (inclusive).
    pub fn range(&mut self, lo: i32, hi: i32) -> i32 {
        lo + (self.next_u64() % ((hi as i64 - lo as i64 + 1) as u64)) as i32
    }
    /// Uniform in [-1, 1).
    pub fn f32_unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 23) as f32 * 2.0 - 1.0
    }
    pub fn i16_vec(&mut self, n: usize, bits: u32) -> Vec<i16> {
        (0..n).map(|_| self.i32_bits(bits) as i16).collect()
    }
    pub fn i32_vec(&mut self, n: usize, bits: u32) -> Vec<i32> {
        (0..n).map(|_| self.i32_bits(bits)).collect()
    }
    pub fn f32_vec(&mut self, n: usize, scale: f32) -> Vec<f32> {
        (0..n).map(|_| self.f32_unit() * scale).collect()
    }
}

/// Asserts that all range-coder fields (and the derived `ec_tell*`) are equal.
pub fn same_enc(a: &ec_enc, b: &ec_enc) {
    assert_eq!(a.storage, b.storage);
    assert_eq!(a.end_offs, b.end_offs);
    assert_eq!(a.end_window, b.end_window);
    assert_eq!(a.nend_bits, b.nend_bits);
    assert_eq!(a.nbits_total, b.nbits_total);
    assert_eq!(a.offs, b.offs);
    assert_eq!(a.rng, b.rng);
    assert_eq!(a.val, b.val);
    assert_eq!(a.ext, b.ext);
    assert_eq!(a.rem, b.rem);
    assert_eq!(a.error, b.error);
    assert_eq!(ec_tell(a), ec_tell(b));
    assert_eq!(ec_tell_frac(a), ec_tell_frac(b));
}

/// The C 48 kHz / 960 `CELTMode *`.
pub fn c_mode() -> *const core::ffi::c_void {
    minicelt_oracle::mode48000()
}

/// Music-like 48 kHz test signal generator: a few slowly gliding harmonic tones with vibrato
/// and decaying envelopes, a noise floor, and periodic percussive transients (decaying noise
/// bursts plus a click). Channel 1 is a decorrelated, slightly delayed/attenuated variant of
/// channel 0, so stereo coding decisions (intensity, M/S) are exercised.
pub struct MusicGen {
    n: u64,
    rng: Rng,
    /// Amplitude scale (the float API uses +-1.0 full scale).
    pub gain: f32,
    /// Noise floor relative to the tones.
    pub noise: f32,
    /// Transient period in samples (0 = none).
    pub hit_period: u64,
    hit_age: u64,
    hist: [f32; 64],
}

impl MusicGen {
    pub fn new(seed: u64) -> Self {
        MusicGen { n: 0, rng: Rng::new(seed), gain: 0.25, noise: 0.02, hit_period: 11_000, hit_age: u64::MAX / 2, hist: [0.0; 64] }
    }

    fn next_mono(&mut self) -> f32 {
        use core::f64::consts::PI;
        let fs = 48000.0;
        let t = self.n as f64 / fs;
        if self.hit_period != 0 && self.n % self.hit_period == self.hit_period / 2 {
            self.hit_age = 0;
        }
        self.n += 1;
        let mut x = 0.0f64;
        // A chord with vibrato; each partial has its own slow tremolo.
        for (k, (f, a)) in [(220.0, 0.35), (329.6, 0.25), (440.0, 0.2), (880.0, 0.1), (1760.0, 0.06), (5300.0, 0.03)]
            .into_iter()
            .enumerate()
        {
            let vib = 1.0 + 0.004 * (2.0 * PI * (5.0 + k as f64 * 0.3) * t).sin();
            let trem = 0.6 + 0.4 * (2.0 * PI * (0.3 + 0.17 * k as f64) * t).sin();
            x += a * trem * (2.0 * PI * f * vib * t + k as f64).sin();
        }
        let mut s = x as f32;
        if self.hit_age < 4000 {
            let env = (-(self.hit_age as f32) / 600.0).exp();
            let click = if self.hit_age < 3 { 1.5 } else { 0.0 };
            s += env * (self.rng.f32_unit() * 0.8 + click);
            self.hit_age += 1;
        }
        s + self.noise * self.rng.f32_unit()
    }

    /// Next frame of `n` samples per channel, interleaved (`channels` 1 or 2), scaled by `gain`.
    pub fn next_frame(&mut self, n: usize, channels: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(n * channels);
        for _ in 0..n {
            let m = self.next_mono();
            self.hist.rotate_right(1);
            self.hist[0] = m;
            out.push(m * self.gain);
            if channels == 2 {
                let side = 0.6 * self.hist[17] + 0.3 * self.noise * self.rng.f32_unit();
                out.push(side * self.gain);
            }
        }
        out
    }
}

/// `nframes` frames of `frame_size` samples per channel of music-like signal.
pub fn music(seed: u64, nframes: usize, frame_size: usize, channels: usize) -> Vec<Vec<f32>> {
    let mut g = MusicGen::new(seed);
    (0..nframes).map(|_| g.next_frame(frame_size, channels)).collect()
}

/// Full-band white noise frames (stress input).
pub fn noise(seed: u64, nframes: usize, frame_size: usize, channels: usize, scale: f32) -> Vec<Vec<f32>> {
    let mut r = Rng::new(seed);
    (0..nframes).map(|_| r.f32_vec(frame_size * channels, scale)).collect()
}
