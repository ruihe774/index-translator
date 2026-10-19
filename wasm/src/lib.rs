//! C-ABI exports for wasm32-unknown-unknown. The API is filled in once the encoder exists.
#![no_std]

use minisilk as _;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
