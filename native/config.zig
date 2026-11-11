// Build-time tunables of native/sat.zig. These defaults are the as-is port of src/sat.wat; native/build.sh writes
// a copy with overrides (`key=value` arguments) for each variant.

/// f32 lanes per vector: 4 is WASM SIMD128's width (what sat.wat has), 8 is AVX2's.
pub const vw = 4;
/// Rows of the GEMM micro-kernel.
pub const mr = 2;
/// Columns of the GEMM micro-kernel, and so the width of the weight panels (a multiple of 16).
pub const nr = 16;
/// Rows of the attention micro-kernel (always 16 columns: the K and V panels are 16 wide).
pub const amr = 2;
/// K block of the GEMM (a multiple of 32, the quantization block).
pub const kc = 256;
/// @mulAdd in the micro-kernels (scores, P·V and the GEMMs) instead of a separate mul and add.
pub const fma = false;
/// @mulAdd in exp, GELU, LayerNorm and the classifier.
pub const fma_math = false;
/// .manual: @Vector code shaped like sat.wat. .auto: the same algorithm (packing, blocking, panels), but every
/// loop written on scalars, for LLVM to vectorize. .naive: textbook loops (dot products over the quantized
/// row-major weights, attention row by row), no packing or panels. .naive2: .naive with each dot product split
/// at the 32-wide quantization block (one scale per block instead of one lookup per product).
pub const kernel = .manual;
/// @setFloatMode(.optimized) in the .auto / .naive code (lets LLVM reassociate reductions and contract to FMA).
pub const fast = false;
/// Atomic loads a worker spins for before it sleeps on the futex.
pub const spin = 20000;
