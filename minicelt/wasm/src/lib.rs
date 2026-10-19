//! C-ABI exports for wasm32-unknown-unknown: one static 48 kHz 20 ms CELT-only encoder.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// group G: minicelt_* exports.
