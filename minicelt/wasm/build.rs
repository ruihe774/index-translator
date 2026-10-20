// Linker settings of the cdylib.
//
// The shadow stack (`__stack_pointer`, which rustc/lld place at the start of linear memory, 1 MiB by
// default) only holds the locals of the Rust frames: all the scratch buffers are in the static
// pseudostack (`minicelt::stack`). Its measured peak is under 1 KiB (see PORTING.md), so 2 KiB
// leaves a wide margin and the whole module fits in one 64 KiB wasm page instead of 18.
// `MINICELT_SHADOW_STACK=<bytes>` overrides the size (to measure the peak, see PORTING.md).
fn main() {
    println!("cargo:rerun-if-env-changed=MINICELT_SHADOW_STACK");
    let size = std::env::var("MINICELT_SHADOW_STACK").unwrap_or_else(|_| "2048".into());
    println!("cargo:rustc-link-arg-cdylib=-zstack-size={size}");
}
