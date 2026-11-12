# Zig as the C/C++ compiler for programs that run on the machine that builds: no target, so Zig compiles for this
# machine's own CPU and libc. ggml's Vulkan shader generator is built with it (GGML_VULKAN_SHADERS_GEN_TOOLCHAIN in
# the toolchain files).
set(CMAKE_C_COMPILER zig)
set(CMAKE_C_COMPILER_ARG1 cc)
set(CMAKE_CXX_COMPILER zig)
set(CMAKE_CXX_COMPILER_ARG1 c++)
