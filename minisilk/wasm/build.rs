// Link settings of the cdylib: the wasm shadow stack (the Rust call stack, placed first in linear
// memory) is shrunk from the 1 MiB default to what the encoder needs; see minisilk/PORTING.md,
// "Memory", and `test/stack_peak.ts`, which measures it with MINISILK_STACK_SIZE=1048576.
fn main() {
    println!("cargo:rerun-if-env-changed=MINISILK_STACK_SIZE");
    let size = std::env::var("MINISILK_STACK_SIZE").unwrap_or_else(|_| "49152".into());
    println!("cargo:rustc-link-arg-cdylib=-zstack-size={size}");
}
