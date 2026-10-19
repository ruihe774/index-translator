//! Shared helpers for the differential tests against the C oracle.

#![allow(dead_code)]

extern crate std;

use std::boxed::Box;
use std::vec::Vec;

use crate::celt::entcode::ec_enc;
use crate::silk::float::structs_flp::silk_encoder;
use crate::silk::structs::silk_EncControlStruct;

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

/// Synthetic voiced-speech-like 16 kHz signal (same generator as the opus-silk-only test
/// harness): a glottal-ish sawtooth with vibrato through two formant resonators, with
/// amplitude modulation and a little noise.
pub struct SpeechGen {
    n: u64,
    ph: f64,
    y: [f64; 2],
    z: [f64; 2],
    rng: Rng,
    pub gain: f64,
}

impl SpeechGen {
    pub fn new(seed: u64) -> Self {
        SpeechGen { n: 0, ph: 0.0, y: [0.0; 2], z: [0.0; 2], rng: Rng::new(seed), gain: 3000.0 }
    }

    pub fn next_sample(&mut self) -> f64 {
        use core::f64::consts::PI;
        let fs = 16000.0;
        let t = self.n as f64 / fs;
        self.n += 1;
        let f0 = 110.0 + 25.0 * (2.0 * PI * 0.7 * t).sin();
        self.ph += f0 / fs;
        if self.ph >= 1.0 {
            self.ph -= 1.0;
        }
        let x = (if self.ph < 0.5 { self.ph * 2.0 } else { self.ph * 2.0 - 2.0 }) * 0.6
            + 0.01 * self.rng.f32_unit() as f64;
        let (a1, a2) = (2.0 * 0.97 * (2.0 * PI * 700.0 / fs).cos(), -0.97 * 0.97);
        let y = x + a1 * self.y[0] + a2 * self.y[1];
        self.y = [y, self.y[0]];
        let (b1, b2) = (2.0 * 0.95 * (2.0 * PI * 1800.0 / fs).cos(), -0.95 * 0.95);
        let z = y * 0.3 + b1 * self.z[0] + b2 * self.z[1];
        self.z = [z, self.z[0]];
        let env = 0.5 + 0.5 * (2.0 * PI * 2.5 * t).sin();
        ((0.25 * y + 0.1 * z) * env * self.gain).clamp(-32000.0, 32000.0)
    }

    pub fn frame_i16(&mut self) -> [i16; 320] {
        core::array::from_fn(|_| self.next_sample() as i16)
    }
}

/// Zero-initialized boxed value (for the large `#[repr(C)]` state structs).
pub fn zeroed_box<T>() -> Box<T> {
    unsafe {
        let layout = std::alloc::Layout::new::<T>();
        let p = std::alloc::alloc_zeroed(layout) as *mut T;
        assert!(!p.is_null());
        Box::from_raw(p)
    }
}

mod c {
    use super::*;
    unsafe extern "C" {
        pub fn silk_InitEncoder(encState: *mut silk_encoder, channels: i32, arch: i32, encStatus: *mut silk_EncControlStruct) -> i32;
        pub fn silk_Encode(
            encState: *mut silk_encoder,
            encControl: *mut silk_EncControlStruct,
            samplesIn: *const f32,
            nSamplesIn: i32,
            psRangeEnc: *mut ec_enc,
            nBytesOut: *mut i32,
            prefillFlag: i32,
            activity: i32,
        ) -> i32;
        pub fn ec_enc_init(this: *mut ec_enc, buf: *mut u8, size: u32);
        pub fn ec_enc_done(this: *mut ec_enc);
    }
}

/// A SILK encoder state (Rust struct, mono C layout) driven by the C `silk_Encode`, for
/// producing realistic states to feed into individual Rust/C functions.
pub struct CSilkEncoder {
    pub st: Box<silk_encoder>,
    pub ctl: silk_EncControlStruct,
}

impl CSilkEncoder {
    /// 16 kHz mono, WB, 20 ms, VBR, no FEC: the configuration opus_encoder.c sets up for
    /// minisilk's fixed mode.
    pub fn new(bitrate: i32, complexity: i32, dtx: bool) -> Self {
        let mut st = zeroed_box::<silk_encoder>();
        let mut ctl: silk_EncControlStruct = unsafe { core::mem::zeroed() };
        assert_eq!(unsafe { c::silk_InitEncoder(&mut *st, 1, 0, &mut ctl) }, 0);
        ctl.nChannelsAPI = 1;
        ctl.nChannelsInternal = 1;
        ctl.API_sampleRate = 16000;
        ctl.maxInternalSampleRate = 16000;
        ctl.minInternalSampleRate = 8000;
        ctl.desiredInternalSampleRate = 16000;
        ctl.payloadSize_ms = 20;
        ctl.bitRate = bitrate;
        ctl.packetLossPercentage = 0;
        ctl.complexity = complexity;
        ctl.useInBandFEC = 0;
        ctl.useDTX = dtx as i32;
        ctl.useCBR = 0;
        ctl.maxBits = 1275 * 8;
        CSilkEncoder { st, ctl }
    }

    /// Encodes one 20 ms frame with the C encoder; returns the payload. Activity is
    /// VAD_NO_DECISION, as opus_encoder.c passes for non-silent input without analysis.
    pub fn encode(&mut self, pcm: &[i16; 320]) -> Vec<u8> {
        let input: Vec<f32> = pcm.iter().map(|&x| x as f32 * (1.0 / 32768.0)).collect();
        let mut buf = [0u8; 1275];
        let mut enc: ec_enc = unsafe { core::mem::zeroed() };
        let mut nbytes = buf.len() as i32;
        unsafe {
            c::ec_enc_init(&mut enc, buf.as_mut_ptr(), buf.len() as u32);
            let ret = c::silk_Encode(&mut *self.st, &mut self.ctl, input.as_ptr(), 320, &mut enc, &mut nbytes, 0, -1);
            assert_eq!(ret, 0);
            c::ec_enc_done(&mut enc);
        }
        buf[..nbytes as usize].to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c_silk_encoder_runs() {
        let mut enc = CSilkEncoder::new(20000, 10, false);
        let mut sig = SpeechGen::new(7);
        let mut total = 0;
        for _ in 0..50 {
            let pkt = enc.encode(&sig.frame_i16());
            total += pkt.len();
        }
        assert_eq!(enc.st.state_Fxx[0].sCmn.fs_kHz, 16);
        assert!(total > 50 * 20, "{total}");
    }
}
