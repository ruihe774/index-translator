//! Port of celt/quant_bands.c (encoder side, float build).
//!
//! Dropped: the decoder functions (`unquant_*`), `log2Amp` (decoder/RESYNTH only), and the
//! `lfe` parameter (no LFE). `quant_fine_energy` loses `prev_quant` (always NULL outside
//! ENABLE_QEXT, so `prev == 0`); `quant_energy_finalise` loses the `oldEBands != NULL` check
//! (always non-NULL outside ENABLE_QEXT).

use super::arch::{IMAX, IMIN, MAX32, MIN32};
use super::entcode::{ec_enc, ec_get_buffer, ec_range_bytes, ec_tell, ec_tell_frac};
use super::entenc::{ec_enc_bit_logp, ec_enc_bits, ec_enc_icdf};
use super::laplace::ec_laplace_encode;
use super::mathops::celt_log2_db;
use super::modes::CELTMode;
use super::rate::MAX_FINE_BITS;
use crate::stack;

/// Mean energy in each band quantized in Q4 and converted back to float
pub static eMeans: [f32; 25] = [
    6.437500, 6.250000, 5.750000, 5.312500, 5.062500, 4.812500, 4.500000, 4.375000, 4.875000, 4.687500,
    4.562500, 4.437500, 4.875000, 4.625000, 4.312500, 4.500000, 4.375000, 4.625000, 4.750000, 4.437500,
    3.750000, 3.750000, 3.750000, 3.750000, 3.750000,
];

/* prediction coefficients: 0.9, 0.8, 0.65, 0.5 */
pub static pred_coef: [f32; 4] = [29440.0 / 32768.0, 26112.0 / 32768.0, 21248.0 / 32768.0, 16384.0 / 32768.0];
pub static beta_coef: [f32; 4] = [30147.0 / 32768.0, 22282.0 / 32768.0, 12124.0 / 32768.0, 6554.0 / 32768.0];
pub const beta_intra: f32 = 4915.0 / 32768.0;

/*Parameters of the Laplace-like probability models used for the coarse energy.
  There is one pair of parameters for each frame size, prediction type
   (inter/intra), and band number.
  The first number of each pair is the probability of 0, and the second is the
   decay rate, both in Q8 precision.*/
pub static e_prob_model: [[[u8; 42]; 2]; 4] = [
   // 120 sample frames.
   [
      // Inter
      [
          72, 127,  65, 129,  66, 128,  65, 128,  64, 128,  62, 128,  64, 128,
          64, 128,  92,  78,  92,  79,  92,  78,  90,  79, 116,  41, 115,  40,
         114,  40, 132,  26, 132,  26, 145,  17, 161,  12, 176,  10, 177,  11
      ],
      // Intra
      [
          24, 179,  48, 138,  54, 135,  54, 132,  53, 134,  56, 133,  55, 132,
          55, 132,  61, 114,  70,  96,  74,  88,  75,  88,  87,  74,  89,  66,
          91,  67, 100,  59, 108,  50, 120,  40, 122,  37,  97,  43,  78,  50
      ]
   ],
   // 240 sample frames.
   [
      // Inter
      [
          83,  78,  84,  81,  88,  75,  86,  74,  87,  71,  90,  73,  93,  74,
          93,  74, 109,  40, 114,  36, 117,  34, 117,  34, 143,  17, 145,  18,
         146,  19, 162,  12, 165,  10, 178,   7, 189,   6, 190,   8, 177,   9
      ],
      // Intra
      [
          23, 178,  54, 115,  63, 102,  66,  98,  69,  99,  74,  89,  71,  91,
          73,  91,  78,  89,  86,  80,  92,  66,  93,  64, 102,  59, 103,  60,
         104,  60, 117,  52, 123,  44, 138,  35, 133,  31,  97,  38,  77,  45
      ]
   ],
   // 480 sample frames.
   [
      // Inter
      [
          61,  90,  93,  60, 105,  42, 107,  41, 110,  45, 116,  38, 113,  38,
         112,  38, 124,  26, 132,  27, 136,  19, 140,  20, 155,  14, 159,  16,
         158,  18, 170,  13, 177,  10, 187,   8, 192,   6, 175,   9, 159,  10
      ],
      // Intra
      [
          21, 178,  59, 110,  71,  86,  75,  85,  84,  83,  91,  66,  88,  73,
          87,  72,  92,  75,  98,  72, 105,  58, 107,  54, 115,  52, 114,  55,
         112,  56, 129,  51, 132,  40, 150,  33, 140,  29,  98,  35,  77,  42
      ]
   ],
   // 960 sample frames.
   [
      // Inter
      [
          42, 121,  96,  66, 108,  43, 111,  40, 117,  44, 123,  32, 120,  36,
         119,  33, 127,  33, 134,  34, 139,  21, 147,  23, 152,  20, 158,  25,
         154,  26, 166,  21, 173,  16, 184,  13, 184,  10, 150,  13, 139,  15
      ],
      // Intra
      [
          22, 178,  63, 114,  74,  82,  84,  83,  92,  82, 103,  62,  96,  72,
          96,  67, 101,  73, 107,  72, 113,  55, 118,  52, 125,  52, 118,  52,
         117,  55, 135,  49, 137,  39, 157,  32, 145,  29,  97,  33,  77,  40
      ]
   ]
];

pub static small_energy_icdf: [u8; 3] = [2, 1, 0];

pub fn loss_distortion(eBands: &[f32], oldEBands: &[f32], start: i32, end: i32, len: i32, C: i32) -> f32 {
    let mut dist: f32 = 0.0;
    for c in 0..C {
        for i in start..end {
            let k = (i + c * len) as usize;
            let d = eBands[k] - oldEBands[k];
            dist = dist + d * d;
        }
    }
    MIN32(200.0, dist)
}

fn quant_coarse_energy_impl(
    m: &CELTMode,
    start: i32,
    end: i32,
    eBands: &[f32],
    oldEBands: &mut [f32],
    budget: i32,
    mut tell: i32,
    prob_model: &[u8; 42],
    error: &mut [f32],
    enc: &mut ec_enc,
    C: i32,
    LM: i32,
    intra: i32,
    max_decay: f32,
) -> i32 {
    let mut badness: i32 = 0;
    let mut prev: [f32; 2] = [0.0, 0.0];
    let coef: f32;
    let beta: f32;

    if tell + 3 <= budget {
        ec_enc_bit_logp(enc, intra, 3);
    }
    if intra != 0 {
        coef = 0.0;
        beta = beta_intra;
    } else {
        beta = beta_coef[LM as usize];
        coef = pred_coef[LM as usize];
    }

    /* Encode at a fixed coarse resolution */
    for i in start..end {
        let mut c = 0;
        loop {
            let k = (i + c * m.nbEBands) as usize;
            let x = eBands[k];
            let oldE = MAX32(-9.0, oldEBands[k]);
            let f = x - coef * oldE - prev[c as usize];
            /* Rounding to nearest integer here is really important! */
            let mut qi = libm::floor((0.5f32 + f) as f64) as i32;
            let decay_bound = MAX32(-28.0, oldEBands[k]) - max_decay;
            /* Prevent the energy from going down too quickly (e.g. for bands
            that have just one bin) */
            if qi < 0 && x < decay_bound {
                qi += (decay_bound - x) as i32;
                if qi > 0 {
                    qi = 0;
                }
            }
            let qi0 = qi;
            /* If we don't have enough bits to encode all the energy, just assume
            something safe. */
            tell = ec_tell(enc);
            let bits_left = budget - tell - 3 * C * (end - i);
            if i != start && bits_left < 30 {
                if bits_left < 24 {
                    qi = IMIN(1, qi);
                }
                if bits_left < 16 {
                    qi = IMAX(-1, qi);
                }
            }
            if budget - tell >= 15 {
                let pi = (2 * IMIN(i, 20)) as usize;
                ec_laplace_encode(enc, &mut qi, (prob_model[pi] as u32) << 7, (prob_model[pi + 1] as i32) << 6);
            } else if budget - tell >= 2 {
                qi = IMAX(-1, IMIN(qi, 1));
                ec_enc_icdf(enc, (2 * qi) ^ -((qi < 0) as i32), &small_energy_icdf, 2);
            } else if budget - tell >= 1 {
                qi = IMIN(0, qi);
                ec_enc_bit_logp(enc, -qi, 1);
            } else {
                qi = -1;
            }
            error[k] = f - qi as f32;
            badness += (qi0 - qi).abs();
            let q = qi as f32;

            let tmp = coef * oldE + prev[c as usize] + q;
            oldEBands[k] = tmp;
            prev[c as usize] = prev[c as usize] + q - beta * q;
            c += 1;
            if c >= C {
                break;
            }
        }
    }
    badness
}

pub fn quant_coarse_energy(
    m: &CELTMode,
    start: i32,
    end: i32,
    effEnd: i32,
    eBands: &[f32],
    oldEBands: &mut [f32],
    budget: u32,
    error: &mut [f32],
    enc: &mut ec_enc,
    C: i32,
    LM: i32,
    nbAvailableBytes: i32,
    force_intra: i32,
    delayedIntra: &mut f32,
    mut two_pass: i32,
    loss_rate: i32,
) {
    let mut badness1: i32 = 0;
    let sg = stack::save();

    let mut intra: i32 = (force_intra != 0
        || (two_pass == 0 && *delayedIntra > (2 * C * (end - start)) as f32 && nbAvailableBytes > (end - start) * C))
        as i32;
    /* budget (unsigned) * float * int / int: the whole expression is float. */
    let intra_bias: i32 = (((budget as f32 * *delayedIntra) * loss_rate as f32) / (C * 512) as f32) as i32;
    let new_distortion = loss_distortion(eBands, oldEBands, start, effEnd, m.nbEBands, C);

    let tell: u32 = ec_tell(enc) as u32;
    if tell.wrapping_add(3) > budget {
        two_pass = 0;
        intra = 0;
    }

    let mut max_decay: f32 = 16.0;
    if end - start > 10 {
        max_decay = MIN32(max_decay, 0.125f32 * nbAvailableBytes as f32);
    }
    let enc_start_state: ec_enc = *enc;

    let nb = (C * m.nbEBands) as usize;
    let oldEBands_intra = sg.alloc::<f32>(nb);
    let error_intra = sg.alloc::<f32>(nb);
    oldEBands_intra.copy_from_slice(&oldEBands[..nb]);

    if two_pass != 0 || intra != 0 {
        badness1 = quant_coarse_energy_impl(
            m, start, end, eBands, oldEBands_intra, budget as i32, tell as i32,
            &e_prob_model[LM as usize][1], error_intra, enc, C, LM, 1, max_decay,
        );
    }

    if intra == 0 {
        let tell_intra: i32 = ec_tell_frac(enc) as i32;

        let enc_intra_state: ec_enc = *enc;

        let nstart_bytes: u32 = ec_range_bytes(&enc_start_state);
        let nintra_bytes: u32 = ec_range_bytes(&enc_intra_state);
        // SAFETY: the encoder buffer holds at least nintra_bytes bytes.
        let intra_buf: *mut u8 = unsafe { ec_get_buffer(&enc_intra_state).add(nstart_bytes as usize) };
        let save_bytes: u32 = nintra_bytes - nstart_bytes;
        // (save_bytes == 0 is ALLOC_NONE in C; a zero-length alloc here.)
        let intra_bits = sg.alloc::<u8>(save_bytes as usize);
        /* Copy bits from intra bit-stream */
        unsafe { core::ptr::copy_nonoverlapping(intra_buf, intra_bits.as_mut_ptr(), save_bytes as usize) };

        *enc = enc_start_state;

        let badness2 = quant_coarse_energy_impl(
            m, start, end, eBands, oldEBands, budget as i32, tell as i32,
            &e_prob_model[LM as usize][intra as usize], error, enc, C, LM, 0, max_decay,
        );

        if two_pass != 0
            && (badness1 < badness2
                || (badness1 == badness2 && (ec_tell_frac(enc) as i32) + intra_bias > tell_intra))
        {
            *enc = enc_intra_state;
            /* Copy intra bits to bit-stream */
            unsafe { core::ptr::copy_nonoverlapping(intra_bits.as_ptr(), intra_buf, save_bytes as usize) };
            oldEBands[..nb].copy_from_slice(oldEBands_intra);
            error[..nb].copy_from_slice(error_intra);
            intra = 1;
        }
    } else {
        oldEBands[..nb].copy_from_slice(oldEBands_intra);
        error[..nb].copy_from_slice(error_intra);
    }

    if intra != 0 {
        *delayedIntra = new_distortion;
    } else {
        *delayedIntra = (pred_coef[LM as usize] * pred_coef[LM as usize]) * *delayedIntra + new_distortion;
    }
}

pub fn quant_fine_energy(
    m: &CELTMode,
    start: i32,
    end: i32,
    oldEBands: &mut [f32],
    error: &mut [f32],
    extra_quant: &[i32],
    enc: &mut ec_enc,
    C: i32,
) {
    /* prev_quant is always NULL here (it is only used with ENABLE_QEXT): prev == 0 */
    let prev: i32 = 0;
    /* Encode finer resolution */
    for i in start..end {
        let eq = extra_quant[i as usize];
        if eq <= 0 {
            continue;
        }
        let extra: i32 = (1i32 << eq) as i16 as i32;
        if ec_tell(enc) + C * eq > (enc.storage as i32) * 8 {
            continue;
        }
        for c in 0..C {
            let k = (i + c * m.nbEBands) as usize;
            let mut q2 = libm::floor(((error[k] * (1 << prev) as f32 + 0.5f32) * extra as f32) as f64) as i32;
            if q2 > extra - 1 {
                q2 = extra - 1;
            }
            if q2 < 0 {
                q2 = 0;
            }
            ec_enc_bits(enc, q2 as u32, eq as u32);
            let mut offset: f32 = (q2 as f32 + 0.5f32) * (1 << (14 - eq)) as f32 * (1.0f32 / 16384.0) - 0.5f32;
            offset *= (1 << (14 - prev)) as f32 * (1.0f32 / 16384.0);
            oldEBands[k] += offset;
            error[k] -= offset;
        }
    }
}

pub fn quant_energy_finalise(
    m: &CELTMode,
    start: i32,
    end: i32,
    oldEBands: &mut [f32],
    error: &mut [f32],
    fine_quant: &[i32],
    fine_priority: &[i32],
    mut bits_left: i32,
    enc: &mut ec_enc,
    C: i32,
) {
    /* Use up the remaining bits */
    for prio in 0..2 {
        let mut i = start;
        while i < end && bits_left >= C {
            if fine_quant[i as usize] >= MAX_FINE_BITS || fine_priority[i as usize] != prio {
                i += 1;
                continue;
            }
            for c in 0..C {
                let k = (i + c * m.nbEBands) as usize;
                let q2: i32 = if error[k] < 0.0 { 0 } else { 1 };
                ec_enc_bits(enc, q2 as u32, 1);
                let offset: f32 = (q2 as f32 - 0.5f32) * (1 << (14 - fine_quant[i as usize] - 1)) as f32 * (1.0f32 / 16384.0);
                oldEBands[k] += offset;
                error[k] -= offset;
                bits_left -= 1;
            }
            i += 1;
        }
    }
}

pub fn amp2Log2(m: &CELTMode, effEnd: i32, end: i32, bandE: &[f32], bandLogE: &mut [f32], C: i32) {
    for c in 0..C {
        for i in 0..effEnd {
            bandLogE[(i + c * m.nbEBands) as usize] =
                celt_log2_db(bandE[(i + c * m.nbEBands) as usize]) - eMeans[i as usize];
        }
        for i in effEnd..end {
            bandLogE[(c * m.nbEBands + i) as usize] = -14.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::celt::entenc::ec_enc_init;
    use crate::celt::mdct::clt_mdct_forward;
    use crate::celt::modes::mode48000_960_120 as MODE;
    use crate::testutil::{Rng, music, same_enc};
    use core::ffi::c_void;
    use minicelt_oracle as c;

    const NB: usize = 21;

    fn bits(v: &[f32]) -> Vec<u32> {
        v.iter().map(|x| x.to_bits()).collect()
    }

    /// Band log-energies (amp2Log2 of MDCT band amplitudes) of music frames, 2 channels.
    fn music_band_loge(seed: u64, nframes: usize) -> Vec<Vec<f32>> {
        let frames = music(seed, nframes, 960 + 120, 2);
        frames
            .iter()
            .map(|f| {
                let mut bande = vec![0.0f32; 2 * NB];
                for ch in 0..2 {
                    let inp: Vec<f32> = f.chunks(2).map(|p| p[ch] * 32768.0).collect();
                    let mut spec = vec![0.0f32; 960];
                    clt_mdct_forward(&MODE.mdct, &inp, 0, &mut spec, 0, MODE.window, 120, 0, 1);
                    for i in 0..NB {
                        let (a, b) = (MODE.eBands[i] as usize * 8, MODE.eBands[i + 1] as usize * 8);
                        let e: f32 = spec[a..b].iter().map(|x| x * x).sum();
                        bande[ch * NB + i] = libm::sqrtf(1e-27 + e);
                    }
                }
                let mut l = vec![0.0f32; 2 * NB];
                amp2Log2(&MODE, 21, 21, &bande, &mut l, 2);
                l
            })
            .collect()
    }

    fn rand_loge(rng: &mut Rng) -> Vec<f32> {
        let mut v = vec![0.0f32; 2 * NB];
        for c in 0..2 {
            let mut x = rng.f32_unit() * 6.0;
            for i in 0..NB {
                x += rng.f32_unit() * 2.0;
                v[c * NB + i] = if rng.range(0, 30) == 0 { -14.0 } else { x };
            }
        }
        v
    }

    #[test]
    fn tables_match_c() {
        unsafe {
            let p = c::oracle_e_prob_model();
            let cm = core::slice::from_raw_parts(p, 4 * 2 * 42);
            let flat: Vec<u8> = e_prob_model.iter().flatten().flatten().copied().collect();
            assert_eq!(flat, cm);
            assert_eq!(core::slice::from_raw_parts(c::oracle_small_energy_icdf(), 3), &small_energy_icdf);
            assert_eq!(bits(core::slice::from_raw_parts(c::oracle_pred_coef(), 4)), bits(&pred_coef));
            assert_eq!(bits(core::slice::from_raw_parts(c::oracle_beta_coef(), 4)), bits(&beta_coef));
            assert_eq!(c::oracle_beta_intra().to_bits(), beta_intra.to_bits());
        }
    }

    #[test]
    fn amp2Log2_matches_c() {
        let mut rng = Rng::new(31);
        let cm = c::mode48000();
        for iter in 0..300 {
            let end = rng.range(1, 21);
            let eff = rng.range(0, end);
            let cc = 1 + iter % 2;
            let bande: Vec<f32> = (0..2 * NB)
                .map(|_| {
                    let e = rng.range(-30, 30) as f64;
                    (libm::exp2(e) * (1.0 + rng.f32_unit().abs() as f64)) as f32
                })
                .collect();
            let mut a = vec![f32::from_bits(0x7fc00001); 2 * NB];
            let mut b = a.clone();
            amp2Log2(&MODE, eff, end, &bande, &mut a, cc);
            unsafe { c::amp2Log2(cm, eff, end, bande.as_ptr(), b.as_mut_ptr(), cc) };
            assert_eq!(bits(&a), bits(&b));
        }
    }

    #[test]
    fn loss_distortion_matches_c() {
        let mut rng = Rng::new(32);
        let mus = music_band_loge(3, 8);
        for iter in 0..300 {
            let (e, o) = if iter % 2 == 0 {
                (rand_loge(&mut rng), rand_loge(&mut rng))
            } else {
                (mus[iter / 2 % 8].clone(), mus[(iter / 2 + 1) % 8].clone())
            };
            let start = rng.range(0, 5);
            let end = rng.range(start, 21);
            let cc = 1 + (iter as i32 / 2) % 2;
            let mut oc = o.clone();
            let r = loss_distortion(&e, &o, start, end, NB as i32, cc);
            let cr = unsafe { c::oracle_loss_distortion(e.as_ptr(), oc.as_mut_ptr(), start, end, NB as i32, cc) };
            assert_eq!(r.to_bits(), cr.to_bits());
        }
    }

    struct Pair {
        br: Vec<u8>,
        bc: Vec<u8>,
        er: ec_enc,
        ec: ec_enc,
    }

    impl Pair {
        fn new(rng: &mut Rng, size: usize) -> Box<Pair> {
            let mut p = Box::new(Pair {
                br: vec![0x55; size],
                bc: vec![0x55; size],
                er: unsafe { core::mem::zeroed() },
                ec: unsafe { core::mem::zeroed() },
            });
            ec_enc_init(&mut p.er, p.br.as_mut_ptr(), size as u32);
            unsafe { c::ec_enc_init(&mut p.ec as *mut ec_enc as *mut c_void, p.bc.as_mut_ptr(), size as u32) };
            // some prior bits so that the coder is not at its start
            let nb = rng.range(0, 12);
            for _ in 0..nb {
                let v = rng.range(0, 255) as u32;
                ec_enc_bits(&mut p.er, v, 8);
                unsafe { c::ec_enc_bits(&mut p.ec as *mut ec_enc as *mut c_void, v, 8) };
            }
            p
        }
        fn check(&self) {
            same_enc(&self.er, &self.ec);
            assert_eq!(self.br, self.bc);
        }
    }

    #[test]
    fn quant_coarse_energy_matches_c() {
        let mut rng = Rng::new(33);
        let cm = c::mode48000();
        let mus = music_band_loge(4, 40);
        let mut n_intra = 0;
        let mut n_two = 0;
        for iter in 0..3000 {
            let size = [8, 20, 40, 80, 160, 300][rng.range(0, 5) as usize];
            let mut p = Pair::new(&mut rng, size);
            let cc = 1 + (iter % 2) as i32;
            let lm = rng.range(0, 3);
            let (e, o) = if iter % 3 == 0 {
                (rand_loge(&mut rng), rand_loge(&mut rng))
            } else {
                let k = rng.range(0, 38) as usize;
                let mut o = mus[k].clone();
                if iter % 7 == 0 {
                    // previous frame the codec would have: a bit off
                    for x in o.iter_mut() {
                        *x += rng.f32_unit() * 0.7;
                    }
                }
                (mus[k + 1].clone(), o)
            };
            let start = if iter % 11 == 0 { rng.range(0, 4) } else { 0 };
            let end = if iter % 5 == 0 { rng.range(start + 1, 21) } else { 21 };
            let eff_end = if iter % 4 == 0 { rng.range(start, end) } else { end };
            let budget = if iter % 6 == 0 { rng.range(0, size as i32 * 8) as u32 } else { size as u32 * 8 };
            let nbytes = if iter % 3 == 0 { rng.range(1, 3) * 0 + rng.range(0, 200) } else { size as i32 };
            let force_intra = (rng.range(0, 5) == 0) as i32;
            let two_pass = (rng.range(0, 3) != 0) as i32;
            let loss_rate = if iter % 2 == 0 { 0 } else { rng.range(0, 100) };
            let delayed0 = [0.0f32, 1.0, 40.0, 150.0, 1000.0][rng.range(0, 4) as usize] * (0.5 + rng.f32_unit().abs());

            let mut old_r = o.clone();
            let mut old_c = o.clone();
            let sent = f32::from_bits(0x7fc00077);
            let mut err_r = vec![sent; 2 * NB];
            let mut err_c = err_r.clone();
            let (mut d_r, mut d_c) = (delayed0, delayed0);
            quant_coarse_energy(
                &MODE, start, end, eff_end, &e, &mut old_r, budget, &mut err_r, &mut p.er, cc, lm, nbytes,
                force_intra, &mut d_r, two_pass, loss_rate,
            );
            unsafe {
                c::quant_coarse_energy(
                    cm, start, end, eff_end, e.as_ptr(), old_c.as_mut_ptr(), budget, err_c.as_mut_ptr(),
                    &mut p.ec as *mut ec_enc as *mut c_void, cc, lm, nbytes, force_intra, &mut d_c, two_pass,
                    loss_rate, 0,
                )
            };
            assert_eq!(bits(&old_r), bits(&old_c), "iter {iter} oldEBands");
            // outside [start,end) `error` holds uninitialized pseudostack bytes in C: compare in range only
            for ch in 0..cc as usize {
                let r = ch * NB + start as usize..ch * NB + end as usize;
                assert_eq!(bits(&err_r[r.clone()]), bits(&err_c[r]), "iter {iter} error");
            }
            assert_eq!(d_r.to_bits(), d_c.to_bits(), "iter {iter} delayedIntra");
            p.check();
            n_intra += (d_r.to_bits() == (loss_distortion(&e, &o, start, eff_end, NB as i32, cc)).to_bits()) as i32;
            n_two += two_pass;
        }
        // both decisions must have been exercised
        assert!(n_intra > 50 && n_intra < 2950, "intra decisions {n_intra}");
        assert!(n_two > 0);
    }

    #[test]
    fn quant_fine_energy_matches_c() {
        let mut rng = Rng::new(34);
        let cm = c::mode48000();
        for iter in 0..1000 {
            let size = [4, 10, 30, 100, 300][rng.range(0, 4) as usize];
            let mut p = Pair::new(&mut rng, size);
            let cc = 1 + (iter % 2) as i32;
            let start = rng.range(0, 3);
            let end = rng.range(start, 21);
            let mut extra: Vec<i32> = (0..NB).map(|_| rng.range(-1, 8)).collect();
            if iter % 3 == 0 {
                extra.iter_mut().for_each(|x| *x = (*x).clamp(0, 3));
            }
            let old = rand_loge(&mut rng);
            let err: Vec<f32> = (0..2 * NB).map(|_| rng.f32_unit() * 0.5).collect();
            let (mut or_, mut oc) = (old.clone(), old.clone());
            let (mut er_, mut ec_) = (err.clone(), err.clone());
            let mut extra_c = extra.clone();
            quant_fine_energy(&MODE, start, end, &mut or_, &mut er_, &extra, &mut p.er, cc);
            unsafe {
                c::quant_fine_energy(
                    cm, start, end, oc.as_mut_ptr(), ec_.as_mut_ptr(), core::ptr::null_mut(),
                    extra_c.as_mut_ptr(), &mut p.ec as *mut ec_enc as *mut c_void, cc,
                )
            };
            assert_eq!(bits(&or_), bits(&oc));
            assert_eq!(bits(&er_), bits(&ec_));
            p.check();
        }
    }

    #[test]
    fn quant_energy_finalise_matches_c() {
        let mut rng = Rng::new(35);
        let cm = c::mode48000();
        for iter in 0..1000 {
            let size = [10, 30, 100, 300][rng.range(0, 3) as usize];
            let mut p = Pair::new(&mut rng, size);
            let cc = 1 + (iter % 2) as i32;
            let start = rng.range(0, 3);
            let end = rng.range(start, 21);
            let fine: Vec<i32> = (0..NB).map(|_| rng.range(0, 8)).collect();
            let prio: Vec<i32> = (0..NB).map(|_| rng.range(0, 1)).collect();
            let bits_left = rng.range(0, 60);
            let old = rand_loge(&mut rng);
            let err: Vec<f32> = (0..2 * NB).map(|_| rng.f32_unit() * 0.5).collect();
            let (mut or_, mut oc) = (old.clone(), old.clone());
            let (mut er_, mut ec_) = (err.clone(), err.clone());
            let (mut fc, mut pc) = (fine.clone(), prio.clone());
            quant_energy_finalise(&MODE, start, end, &mut or_, &mut er_, &fine, &prio, bits_left, &mut p.er, cc);
            unsafe {
                c::quant_energy_finalise(
                    cm, start, end, oc.as_mut_ptr(), ec_.as_mut_ptr(), fc.as_mut_ptr(), pc.as_mut_ptr(),
                    bits_left, &mut p.ec as *mut ec_enc as *mut c_void, cc,
                )
            };
            assert_eq!(bits(&or_), bits(&oc));
            assert_eq!(bits(&er_), bits(&ec_));
            p.check();
        }
    }
}
