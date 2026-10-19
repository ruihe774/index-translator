//! Port of silk/interpolate.c.

use crate::silk::macros::*;

/// Interpolate two vectors.
/// `xi`: interpolated vector (O); `x0`: first vector; `x1`: second vector;
/// `ifact_Q2`: interp. factor, weight on 2nd vector; `d`: number of parameters.
pub fn silk_interpolate(xi: &mut [i16], x0: &[i16], x1: &[i16], ifact_Q2: i32, d: i32) {
    debug_assert!(ifact_Q2 >= 0);
    debug_assert!(ifact_Q2 <= 4);

    for i in 0..d as usize {
        xi[i] = silk_ADD_RSHIFT(x0[i] as i32, silk_SMULBB(x1[i] as i32 - x0[i] as i32, ifact_Q2), 2) as i16;
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_interpolate(xi: *mut i16, x0: *const i16, x1: *const i16, ifact_Q2: i32, d: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(12);
        for _ in 0..3000 {
            let d = [10, 16][rng.range(0, 1) as usize];
            let x0: Vec<i16> = (0..d).map(|_| rng.range(0, 32767) as i16).collect();
            let x1: Vec<i16> = (0..d).map(|_| rng.range(0, 32767) as i16).collect();
            let f = rng.range(0, 4);
            let mut a = vec![0i16; 16];
            let mut b = vec![0i16; 16];
            super::silk_interpolate(&mut a, &x0, &x1, f, d);
            unsafe { c::silk_interpolate(b.as_mut_ptr(), x0.as_ptr(), x1.as_ptr(), f, d) };
            assert_eq!(a, b, "f={f}");
        }
    }
}
