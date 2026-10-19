//! Link-only crate for the C reference build. Internal SILK symbols are declared by the
//! tests that use them (with minisilk's own `#[repr(C)]` types); only the public API is here.
#![allow(non_camel_case_types)]

use core::ffi::{c_int, c_uchar};

#[repr(C)]
pub struct OpusEncoder {
    _p: [u8; 0],
}
#[repr(C)]
pub struct OpusDecoder {
    _p: [u8; 0],
}

pub const OPUS_OK: c_int = 0;
pub const OPUS_APPLICATION_RESTRICTED_SILK: c_int = 2052;
pub const OPUS_BANDWIDTH_WIDEBAND: c_int = 1103;
pub const OPUS_SET_BITRATE_REQUEST: c_int = 4002;
pub const OPUS_SET_VBR_REQUEST: c_int = 4006;
pub const OPUS_SET_BANDWIDTH_REQUEST: c_int = 4008;
pub const OPUS_SET_COMPLEXITY_REQUEST: c_int = 4010;
pub const OPUS_SET_INBAND_FEC_REQUEST: c_int = 4012;
pub const OPUS_SET_PACKET_LOSS_PERC_REQUEST: c_int = 4014;
pub const OPUS_SET_DTX_REQUEST: c_int = 4016;
pub const OPUS_GET_LOOKAHEAD_REQUEST: c_int = 4027;
pub const OPUS_GET_FINAL_RANGE_REQUEST: c_int = 4031;
pub const OPUS_GET_IN_DTX_REQUEST: c_int = 4049;

unsafe extern "C" {
    pub fn opus_encoder_create(fs: i32, channels: c_int, application: c_int, error: *mut c_int) -> *mut OpusEncoder;
    pub fn opus_encoder_destroy(st: *mut OpusEncoder);
    pub fn opus_encoder_ctl(st: *mut OpusEncoder, request: c_int, ...) -> c_int;
    pub fn opus_encode(st: *mut OpusEncoder, pcm: *const i16, frame_size: c_int, data: *mut c_uchar, max_data_bytes: i32) -> i32;
    pub fn opus_encode_float(st: *mut OpusEncoder, pcm: *const f32, frame_size: c_int, data: *mut c_uchar, max_data_bytes: i32) -> i32;
    pub fn opus_decoder_create(fs: i32, channels: c_int, error: *mut c_int) -> *mut OpusDecoder;
    pub fn opus_decoder_destroy(st: *mut OpusDecoder);
    pub fn opus_decode(st: *mut OpusDecoder, data: *const c_uchar, len: i32, pcm: *mut i16, frame_size: c_int, decode_fec: c_int) -> c_int;
}

/// C encoder configured the way minisilk is fixed: 16 kHz mono RESTRICTED_SILK, WB, VBR, no FEC.
pub struct RefEncoder(*mut OpusEncoder);

impl RefEncoder {
    pub fn new(bitrate: i32, complexity: i32, dtx: bool) -> Self {
        unsafe {
            let mut err = 0;
            let st = opus_encoder_create(16000, 1, OPUS_APPLICATION_RESTRICTED_SILK, &mut err);
            assert_eq!(err, OPUS_OK);
            assert_eq!(opus_encoder_ctl(st, OPUS_SET_BANDWIDTH_REQUEST, OPUS_BANDWIDTH_WIDEBAND), OPUS_OK);
            assert_eq!(opus_encoder_ctl(st, OPUS_SET_BITRATE_REQUEST, bitrate), OPUS_OK);
            assert_eq!(opus_encoder_ctl(st, OPUS_SET_COMPLEXITY_REQUEST, complexity), OPUS_OK);
            assert_eq!(opus_encoder_ctl(st, OPUS_SET_DTX_REQUEST, dtx as c_int), OPUS_OK);
            assert_eq!(opus_encoder_ctl(st, OPUS_SET_VBR_REQUEST, 1), OPUS_OK);
            assert_eq!(opus_encoder_ctl(st, OPUS_SET_INBAND_FEC_REQUEST, 0), OPUS_OK);
            RefEncoder(st)
        }
    }
    pub fn raw(&self) -> *mut OpusEncoder {
        self.0
    }
    fn ctl_set(&mut self, request: c_int, value: i32) -> i32 {
        unsafe { opus_encoder_ctl(self.0, request, value) }
    }
    pub fn set_bitrate(&mut self, v: i32) -> i32 {
        self.ctl_set(OPUS_SET_BITRATE_REQUEST, v)
    }
    pub fn set_complexity(&mut self, v: i32) -> i32 {
        self.ctl_set(OPUS_SET_COMPLEXITY_REQUEST, v)
    }
    pub fn set_dtx(&mut self, v: i32) -> i32 {
        self.ctl_set(OPUS_SET_DTX_REQUEST, v)
    }
    pub fn set_packet_loss_perc(&mut self, v: i32) -> i32 {
        self.ctl_set(OPUS_SET_PACKET_LOSS_PERC_REQUEST, v)
    }
    fn ctl_get(&self, request: c_int) -> i32 {
        let mut v: i32 = 0;
        let r = unsafe { opus_encoder_ctl(self.0, request, &mut v as *mut i32) };
        assert_eq!(r, OPUS_OK);
        v
    }
    pub fn lookahead(&self) -> i32 {
        self.ctl_get(OPUS_GET_LOOKAHEAD_REQUEST)
    }
    pub fn final_range(&self) -> u32 {
        self.ctl_get(OPUS_GET_FINAL_RANGE_REQUEST) as u32
    }
    pub fn in_dtx(&self) -> i32 {
        self.ctl_get(OPUS_GET_IN_DTX_REQUEST)
    }
    /// `opus_encode` with an arbitrary frame size (the slice length) and output buffer.
    pub fn encode_any(&mut self, pcm: &[i16], out: &mut [u8]) -> i32 {
        unsafe { opus_encode(self.0, pcm.as_ptr(), pcm.len() as c_int, out.as_mut_ptr(), out.len() as i32) }
    }
    pub fn encode_float_any(&mut self, pcm: &[f32], out: &mut [u8]) -> i32 {
        unsafe { opus_encode_float(self.0, pcm.as_ptr(), pcm.len() as c_int, out.as_mut_ptr(), out.len() as i32) }
    }
    /// Encodes one 20 ms frame (320 samples).
    pub fn encode(&mut self, pcm: &[i16; 320], out: &mut [u8]) -> i32 {
        unsafe { opus_encode(self.0, pcm.as_ptr(), 320, out.as_mut_ptr(), out.len() as i32) }
    }
}

impl Drop for RefEncoder {
    fn drop(&mut self) {
        unsafe { opus_encoder_destroy(self.0) }
    }
}

pub struct RefDecoder(*mut OpusDecoder);

impl RefDecoder {
    pub fn new() -> Self {
        unsafe {
            let mut err = 0;
            let st = opus_decoder_create(16000, 1, &mut err);
            assert_eq!(err, OPUS_OK);
            RefDecoder(st)
        }
    }
    /// Decodes one packet; returns the number of samples, or a negative error code.
    pub fn decode(&mut self, packet: &[u8], pcm: &mut [i16]) -> i32 {
        unsafe { opus_decode(self.0, packet.as_ptr(), packet.len() as i32, pcm.as_mut_ptr(), pcm.len() as c_int, 0) }
    }
}

impl Default for RefDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for RefDecoder {
    fn drop(&mut self) {
        unsafe { opus_decoder_destroy(self.0) }
    }
}
