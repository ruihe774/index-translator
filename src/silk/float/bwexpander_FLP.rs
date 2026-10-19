//! Port of silk/float/bwexpander_FLP.c.

/* Chirp (bw expand) LP AR filter */
pub fn silk_bwexpander_FLP(
    ar: &mut [f32], /* I/O  AR filter to be expanded (without leading 1)                */
    d: i32,         /* I    length of ar                                                */
    chirp: f32,     /* I    chirp factor (typically in range (0..1) )                   */
) {
    let mut cfac: f32 = chirp;

    for i in 0..(d - 1) as usize {
        ar[i] *= cfac;
        cfac *= chirp;
    }
    ar[(d - 1) as usize] *= cfac;
}

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_bwexpander_FLP(ar: *mut f32, d: i32, chirp: f32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(31);
        for d in [1, 2, 6, 10, 12, 16, 24] {
            for _ in 0..50 {
                let ar = rng.f32_vec(24, 2.0);
                let chirp = (rng.f32_unit() * 0.5 + 0.5) * 0.999;
                let (mut r, mut e) = (ar.clone(), ar.clone());
                super::silk_bwexpander_FLP(&mut r, d, chirp);
                unsafe { c::silk_bwexpander_FLP(e.as_mut_ptr(), d, chirp) };
                for i in 0..24 {
                    assert_eq!(r[i].to_bits(), e[i].to_bits(), "d {d} i {i}");
                }
            }
        }
    }
}
