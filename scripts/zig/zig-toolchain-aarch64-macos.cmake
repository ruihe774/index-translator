# Zig as the C toolchain, for Apple silicon macOS with the macOS libc Zig ships (no Xcode SDK). Only libsoxr and
# libopus are built for it, for the e2e mock server of CI's WebKit job; the engines need Vulkan.
# Use: cmake -DCMAKE_TOOLCHAIN_FILE=scripts/zig/zig-toolchain-aarch64-macos.cmake ...
set(CMAKE_SYSTEM_NAME Darwin)
set(CMAKE_SYSTEM_PROCESSOR arm64)

set(ZIG_TARGET "aarch64-macos")
set(ZIG_CPU "apple_m1")

set(CMAKE_C_COMPILER zig)
set(CMAKE_C_COMPILER_ARG1 cc)
set(CMAKE_CXX_COMPILER zig)
set(CMAKE_CXX_COMPILER_ARG1 c++)
# CMake takes one executable for these, so they are one-line wrappers
get_filename_component(_here "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
set(CMAKE_AR "${_here}/zig-ar")
set(CMAKE_RANLIB "${_here}/zig-ranlib")

set(CMAKE_C_COMPILER_TARGET ${ZIG_TARGET})
set(CMAKE_CXX_COMPILER_TARGET ${ZIG_TARGET})
# No -flto=thin: Zig links Mach-O with its own linker, and LTO needs LLD
set(CMAKE_C_FLAGS_INIT "-mcpu=${ZIG_CPU}")
set(CMAKE_CXX_FLAGS_INIT "-mcpu=${ZIG_CPU}")
