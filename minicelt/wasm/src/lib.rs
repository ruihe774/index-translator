//! C-ABI exports for wasm32-unknown-unknown: one static 48 kHz 20 ms CELT-only encoder.
//!
//! Usage from the host (single-threaded):
//! 1. `minicelt_init(channels, bitrate, complexity, vbr_constraint, dtx)`: (re)initialises the
//!    encoder for 1 or 2 channels; returns 0 or a negative Opus error code. `bitrate` is
//!    bits/s, -1000 (`OPUS_AUTO`) or -1 (`OPUS_BITRATE_MAX`). VBR is always on.
//! 2. Write 960 samples per channel, interleaved, to `minicelt_input_ptr()` (f32, nominal
//!    range +-1) or `minicelt_input_i16_ptr()` (i16), then call `minicelt_encode()` /
//!    `minicelt_encode_i16()`. The return value is the packet length (bytes at
//!    `minicelt_output_ptr()`, capacity 1276) or a negative Opus error code.
//! 3. `minicelt_set_*` mirror the matching `OPUS_SET_*` ctls and return 0 or a negative code.
//!    `minicelt_lookahead()` is `OPUS_GET_LOOKAHEAD` (samples at 48 kHz),
//!    `minicelt_final_range()` `OPUS_GET_FINAL_RANGE` and `minicelt_in_dtx()` `OPUS_GET_IN_DTX`.
#![no_std]

use core::ptr::addr_of_mut;
use minicelt::opus::encoder::OpusEncoder;

const FRAME: usize = 960;
const MAX_CHANNELS: usize = 2;
const OUT_CAP: usize = 1276;

static mut ENCODER: OpusEncoder = OpusEncoder::new_zeroed();
static mut CHANNELS: usize = 0;
static mut INPUT_F32: [f32; FRAME * MAX_CHANNELS] = [0.0; FRAME * MAX_CHANNELS];
static mut INPUT_I16: [i16; FRAME * MAX_CHANNELS] = [0; FRAME * MAX_CHANNELS];
static mut OUTPUT: [u8; OUT_CAP] = [0; OUT_CAP];

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// SAFETY (all accessors): wasm32-unknown-unknown here is single-threaded and the exports are
// not re-entrant, so these statics are never aliased.
fn enc() -> &'static mut OpusEncoder {
    unsafe { &mut *addr_of_mut!(ENCODER) }
}

fn channels() -> usize {
    unsafe { *addr_of_mut!(CHANNELS) }
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_init(channels: i32, bitrate: i32, complexity: i32, vbr_constraint: i32, dtx: i32) -> i32 {
    unsafe { *addr_of_mut!(CHANNELS) = 0 };
    let e = enc();
    let mut r = e.init(channels);
    if r >= 0 {
        r = e.set_bitrate(bitrate);
    }
    if r >= 0 {
        r = e.set_complexity(complexity);
    }
    if r >= 0 {
        r = e.set_vbr_constraint(vbr_constraint);
    }
    if r >= 0 {
        r = e.set_dtx(dtx);
    }
    // Leave the encoder unusable unless every setting was accepted.
    if r >= 0 {
        unsafe { *addr_of_mut!(CHANNELS) = channels as usize };
    }
    r
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_set_bitrate(v: i32) -> i32 {
    enc().set_bitrate(v)
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_set_complexity(v: i32) -> i32 {
    enc().set_complexity(v)
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_set_vbr_constraint(v: i32) -> i32 {
    enc().set_vbr_constraint(v)
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_set_dtx(v: i32) -> i32 {
    enc().set_dtx(v)
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_set_packet_loss_perc(v: i32) -> i32 {
    enc().set_packet_loss_perc(v)
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_set_bandwidth(v: i32) -> i32 {
    enc().set_bandwidth(v)
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_input_ptr() -> *mut f32 {
    addr_of_mut!(INPUT_F32) as *mut f32
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_input_i16_ptr() -> *mut i16 {
    addr_of_mut!(INPUT_I16) as *mut i16
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_output_ptr() -> *const u8 {
    addr_of_mut!(OUTPUT) as *const u8
}

/// Encodes `960 * channels` interleaved samples from `minicelt_input_ptr()`.
#[unsafe(no_mangle)]
pub extern "C" fn minicelt_encode() -> i32 {
    let n = FRAME * channels();
    unsafe {
        let pcm = core::slice::from_raw_parts(addr_of_mut!(INPUT_F32) as *const f32, n);
        enc().encode_float(pcm, &mut *addr_of_mut!(OUTPUT))
    }
}

/// Encodes `960 * channels` interleaved samples from `minicelt_input_i16_ptr()`.
#[unsafe(no_mangle)]
pub extern "C" fn minicelt_encode_i16() -> i32 {
    let n = FRAME * channels();
    unsafe {
        let pcm = core::slice::from_raw_parts(addr_of_mut!(INPUT_I16) as *const i16, n);
        enc().encode(pcm, &mut *addr_of_mut!(OUTPUT))
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_lookahead() -> i32 {
    enc().get_lookahead()
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_final_range() -> u32 {
    enc().get_final_range()
}

#[unsafe(no_mangle)]
pub extern "C" fn minicelt_in_dtx() -> i32 {
    enc().get_in_dtx()
}
