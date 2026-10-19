//! Smoke tests of the oracle: struct layout against C, and the reference encoder.

use core::mem::{offset_of, size_of};

use crate::celt::celt_encoder::CELTEncoder;
use crate::testutil;
use minicelt_oracle as c;

macro_rules! check_offsets {
    ($lay:expr, $rust:ty, $cname:expr, $($f:ident),* $(,)?) => {
        $(
            assert_eq!(
                offset_of!($rust, $f),
                $lay.get(concat!($cname, ".", stringify!($f))),
                concat!("offset of ", stringify!($f))
            );
        )*
    };
}

#[test]
fn celt_encoder_layout_matches_c() {
    let lay = c::celt_encoder_layout();
    check_offsets!(
        lay, CELTEncoder, "struct OpusCustomEncoder",
        mode, channels, stream_channels, force_intra, clip, disable_pf, complexity, upsample, start, end,
        bitrate, vbr, signalling, constrained_vbr, loss_rate, lsb_depth, lfe, disable_inv, arch, rng,
        spread_decision, delayedIntra, tonal_average, lastCodedBands, hf_average, tapset_decision,
        prefilter_period, prefilter_gain, prefilter_tapset, consec_transient, analysis, silk_info,
        preemph_memE, preemph_memD, vbr_reservoir, vbr_drift, vbr_offset, vbr_count, overlap_max,
        stereo_saving, intensity, energy_mask, spec_avg, in_mem,
    );
    assert_eq!(size_of::<crate::celt::celt::AnalysisInfo>(), lay.get("AnalysisInfo"));
    assert_eq!(size_of::<crate::celt::celt::SILKInfo>(), lay.get("SILKInfo"));
    // Rust holds the trailing arrays at two-channel size.
    let c_size2 = unsafe { c::celt_encoder_get_size(2) } as usize;
    assert_eq!(lay.get("struct OpusCustomEncoder") <= c_size2, true);
    assert_eq!(size_of::<CELTEncoder>(), c_size2, "sizeof(CELTEncoder) vs celt_encoder_get_size(2)");
    // The C size for one channel is smaller (mono allocation).
    assert!(unsafe { c::celt_encoder_get_size(1) } as usize <= c_size2);
}

#[test]
fn mode_matches_c() {
    let mi = c::mode_info(testutil::c_mode());
    assert_eq!((mi.Fs, mi.overlap, mi.nbEBands, mi.shortMdctSize), (48000, crate::celt::celt_encoder::OVERLAP as i32, crate::celt::celt_encoder::NB_EBANDS as i32, 120));
}

#[test]
fn ref_encoder_smoke() {
    let (fs, nframes) = (960usize, 6usize);
    for channels in [1usize, 2] {
        let mut enc = c::RefEncoder::new(channels);
        enc.set_bitrate(64000);
        enc.set_complexity(10);
        enc.set_vbr(true);
        enc.set_vbr_constraint(true);
        enc.set_dtx(false);
        let frames = testutil::music(1, nframes, fs, channels);
        let mut out = vec![0u8; 1275];
        for (i, f) in frames.iter().enumerate() {
            let n = enc.encode_float(f, fs, &mut out);
            assert!(n > 0, "frame {i}: {n}");
            std::println!("ch={channels} frame {i}: {n} bytes, final_range={:#010x}, in_dtx={}", enc.final_range(), enc.in_dtx());
        }
        assert!(enc.lookahead() > 0);
        assert_eq!(enc.celt_state_bytes().len(), unsafe { c::celt_encoder_get_size(channels as i32) } as usize);
    }
}
