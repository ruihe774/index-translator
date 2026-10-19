//! Port of the `NONTHREADSAFE_PSEUDOSTACK` mode of celt/stack_alloc.h: one static scratch
//! buffer with a bump pointer.
//!
//! C → Rust:
//! ```text
//! SAVE_STACK;                     let st = stack::save();
//! VARDECL(opus_int32, x);
//! ALLOC(x, n, opus_int32);        let x = st.alloc::<i32>(n);
//! RESTORE_STACK;                  (st dropped at end of scope)
//! ```
//! Allocations borrow the guard, so they cannot outlive the matching RESTORE_STACK. Like C,
//! memory is not cleared; `Pod` restricts allocations to types for which every bit pattern
//! is valid. Not thread-safe: the encoder must only run on one thread at a time.

use core::cell::UnsafeCell;
use core::marker::PhantomData;
use core::mem::{align_of, size_of};

/// Scratch size: the measured worst-case peak is 45056 bytes (stereo, `stack::tests`), plus
/// headroom.
pub const GLOBAL_STACK_SIZE: usize = 49152;

#[repr(C, align(16))]
struct Scratch {
    buf: UnsafeCell<[u8; GLOBAL_STACK_SIZE]>,
    top: UnsafeCell<usize>,
    peak: UnsafeCell<usize>,
}

// SAFETY: single-threaded use only, as with NONTHREADSAFE_PSEUDOSTACK in C.
unsafe impl Sync for Scratch {}

static SCRATCH: Scratch = Scratch {
    buf: UnsafeCell::new([0; GLOBAL_STACK_SIZE]),
    top: UnsafeCell::new(0),
    peak: UnsafeCell::new(0),
};

/// Types for which every bit pattern is a valid value.
///
/// # Safety
/// Implementors must be plain data with no invalid bit patterns and no padding.
pub unsafe trait Pod: Copy {}

macro_rules! pod {
    ($($t:ty),*) => { $(unsafe impl Pod for $t {})* };
}
pod!(i8, i16, i32, i64, u8, u16, u32, u64, f32, f64, core::arch::wasm32::v128);
unsafe impl<T: Pod, const N: usize> Pod for [T; N] {}

/// SAVE_STACK; dropping it is RESTORE_STACK.
pub struct StackGuard {
    saved: usize,
    _not_send: PhantomData<*mut u8>,
}

/// SAVE_STACK
#[inline(always)]
pub fn save() -> StackGuard {
    StackGuard { saved: unsafe { *SCRATCH.top.get() }, _not_send: PhantomData }
}

impl StackGuard {
    /// ALLOC(var, n, T): `n` uninitialized-in-the-C-sense (stale but valid) elements.
    #[inline(always)]
    #[allow(clippy::mut_from_ref)]
    pub fn alloc<T: Pod>(&self, n: usize) -> &mut [T] {
        unsafe {
            let top = &mut *SCRATCH.top.get();
            let base = SCRATCH.buf.get() as *mut u8;
            let start = (*top + align_of::<T>() - 1) & !(align_of::<T>() - 1);
            let end = start + n * size_of::<T>();
            if end > GLOBAL_STACK_SIZE {
                panic!("pseudostack overflow");
            }
            *top = end;
            let peak = &mut *SCRATCH.peak.get();
            if end > *peak {
                *peak = end;
            }
            core::slice::from_raw_parts_mut(base.add(start) as *mut T, n)
        }
    }
}

impl Drop for StackGuard {
    #[inline(always)]
    fn drop(&mut self) {
        unsafe { *SCRATCH.top.get() = self.saved }
    }
}

/// High-water mark of the scratch buffer in bytes.
pub fn peak() -> usize {
    unsafe { *SCRATCH.peak.get() }
}

#[cfg(test)]
mod tests {
    use crate::opus::encoder::OpusEncoder;
    use crate::testutil::{Rng, music, noise};
    use std::boxed::Box;
    use std::vec::Vec;

    /// Worst-case pseudostack use over the configuration space (allocation sizes depend on the
    /// channel count, complexity and block decisions, not on the signal values). Run alone
    /// (`oracle-test.sh 2 stack::tests --nocapture`): `peak()` is global to the test binary.
    #[test]
    fn peak_fits() {
        let mut rng = Rng::new(3);
        for channels in 1..=2usize {
            let mut frames: Vec<Vec<f32>> = music(1, 40, 960, channels);
            frames.extend(noise(2, 20, 960, channels, 0.5));
            frames.extend((0..20).map(|i| {
                let mut f = std::vec![0.0f32; 960 * channels];
                f[(i * 37) % 960 * channels] = 0.9;
                f
            }));
            for complexity in 0..=10 {
                for &bitrate in &[6000, 24000, 64000, 128000, 256000, 510000, -1] {
                    let mut st: Box<OpusEncoder> = Box::new(OpusEncoder::new_zeroed());
                    assert_eq!(st.init(channels as i32), 0);
                    st.set_bitrate(bitrate);
                    st.set_complexity(complexity);
                    st.set_vbr_constraint(rng.range(0, 1));
                    let mut out = [0u8; 1276];
                    for f in &frames {
                        assert!(st.encode_float(f, &mut out) > 0);
                    }
                }
            }
        }
        std::println!("pseudostack peak: {} bytes (GLOBAL_STACK_SIZE {})", super::peak(), super::GLOBAL_STACK_SIZE);
        assert!(super::peak() <= super::GLOBAL_STACK_SIZE);
    }
}
