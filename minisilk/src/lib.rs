//! Minimal Opus encoder: a mechanical Rust port of the libopus SILK-only float encoder
//! (OPUS_APPLICATION_RESTRICTED_SILK) for wasm32, fixed to 16 kHz mono wideband, 20 ms
//! frames and VBR, with DTX. `no_std`, no allocation; scratch memory is a static
//! pseudostack (see `stack`).

#![no_std]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]
#![allow(clippy::all)]

#[cfg(not(target_arch = "wasm32"))]
compile_error!("minisilk only supports wasm32 (build with -Ctarget-feature=+simd128)");
#[cfg(not(target_feature = "simd128"))]
compile_error!("minisilk requires -Ctarget-feature=+simd128");

pub mod celt;
pub mod opus;
pub mod silk;
pub mod stack;
