//! The static mode tables (`static_modes_float.rs`) against the C mode.

use crate::celt::modes::mode48000_960_120 as M;
use crate::testutil::c_mode;
use minicelt_oracle as c;

/// C `struct kiss_fft_state` on wasm32 (kiss_fft.h; `arch_fft` pointer last).
#[repr(C)]
struct CKissFft {
    nfft: i32,
    scale: f32,
    shift: i32,
    factors: [i16; 16],
    bitrev: *const i16,
    twiddles: *const f32,
    arch_fft: *const core::ffi::c_void,
}

unsafe fn sl<'a, T>(p: *const T, n: usize) -> &'a [T] {
    unsafe { core::slice::from_raw_parts(p, n) }
}

fn bits<T: Copy>(v: &[T]) -> Vec<u8> {
    unsafe { core::slice::from_raw_parts(v.as_ptr() as *const u8, core::mem::size_of_val(v)).to_vec() }
}

#[test]
fn static_mode_tables_match_c() {
    let mi = c::mode_info(c_mode());
    let n = M.nbEBands as usize;
    assert_eq!((M.Fs, M.overlap, M.nbEBands, M.effEBands), (mi.Fs, mi.overlap, mi.nbEBands, mi.effEBands));
    assert_eq!((M.maxLM, M.nbShortMdcts, M.shortMdctSize, M.nbAllocVectors), (mi.maxLM, mi.nbShortMdcts, mi.shortMdctSize, mi.nbAllocVectors));
    assert_eq!(bits(&M.preemph), bits(&mi.preemph));
    unsafe {
        assert_eq!(M.eBands, sl(mi.eBands, n + 1));
        assert_eq!(M.logN, sl(mi.logN, n));
        assert_eq!(M.allocVectors, sl(mi.allocVectors, n * mi.nbAllocVectors as usize));
        assert_eq!(bits(M.window), bits(sl(mi.window, mi.overlap as usize)));
        assert_eq!(M.cache.size, mi.cache_size);
        assert_eq!(M.cache.index, sl(mi.cache_index, n * (mi.maxLM as usize + 2)));
        assert_eq!(M.cache.bits, sl(mi.cache_bits, mi.cache_size as usize));
        assert_eq!(M.cache.caps, sl(mi.cache_caps, n * 2 * (mi.maxLM as usize + 1)));

        assert_eq!((M.mdct.n, M.mdct.maxshift), (mi.mdct_n, mi.mdct_maxshift));
        // trig: sum over shifts of N>>(shift+1)
        let mut tn = 0usize;
        let mut nn = M.mdct.n;
        for _ in 0..=M.mdct.maxshift {
            nn >>= 1;
            tn += nn as usize;
        }
        assert_eq!(M.mdct.trig.len(), tn);
        assert_eq!(bits(M.mdct.trig), bits(sl(mi.mdct_trig, tn)));

        for s in 0..=M.mdct.maxshift as usize {
            let r = M.mdct.kfft[s];
            let k = &*(mi.kfft[s] as *const CKissFft);
            assert_eq!(r.nfft, k.nfft, "kfft[{s}].nfft");
            assert_eq!(r.scale.to_bits(), k.scale.to_bits(), "kfft[{s}].scale");
            assert_eq!(r.shift, k.shift, "kfft[{s}].shift");
            assert_eq!(r.factors, k.factors, "kfft[{s}].factors");
            assert_eq!(r.bitrev, sl(k.bitrev, r.nfft as usize), "kfft[{s}].bitrev");
            // The twiddles are shared by all FFT sizes of the mode (480 complex values).
            assert_eq!(r.twiddles.len(), 480);
            assert_eq!(bits(r.twiddles), bits(sl(k.twiddles, 2 * 480)), "kfft[{s}].twiddles");
        }
    }
}
