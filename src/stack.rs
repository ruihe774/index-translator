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

/// Scratch size; set from the measured peak (see `peak()`) once the encoder is complete.
pub const GLOBAL_STACK_SIZE: usize = 120000;

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
    use super::*;

    #[test]
    fn nested_alloc_restores() {
        let before = unsafe { *SCRATCH.top.get() };
        {
            let st = save();
            let a = st.alloc::<i16>(3);
            let b = st.alloc::<f64>(2);
            assert_eq!(b.as_ptr() as usize % 8, 0);
            assert!(a.as_ptr() as usize + 6 <= b.as_ptr() as usize);
            {
                let st2 = save();
                let c = st2.alloc::<i32>(10);
                c[9] = 1;
            }
            let d = st.alloc::<u8>(1);
            d[0] = 1;
        }
        assert_eq!(unsafe { *SCRATCH.top.get() }, before);
    }
}
