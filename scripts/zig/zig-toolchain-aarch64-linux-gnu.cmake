# Zig as the C/C++ toolchain, for armv8.2-a+dotprod+fp16 Linux with Zig's default glibc.
# Use: cmake -DCMAKE_TOOLCHAIN_FILE=scripts/zig/zig-toolchain-aarch64-linux-gnu.cmake ...
# Zig takes the CPU from the target, so -m<feature> and the like have no effect; -mcpu is what counts.
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)

set(ZIG_TARGET "aarch64-linux-gnu")
# Armv8.2-A with dot product and fp16, in Zig's spelling: a CPU model, then features
set(ZIG_CPU "generic+v8_2a+fullfp16+dotprod")

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
set(CMAKE_C_FLAGS_INIT "-mcpu=${ZIG_CPU}")
set(CMAKE_CXX_FLAGS_INIT "-mcpu=${ZIG_CPU}")

# Stripped. The system libvulkan needs a newer glibc than Zig's default target; its symbols resolve at run time
foreach(_kind EXE SHARED MODULE)
  set(CMAKE_${_kind}_LINKER_FLAGS_INIT "-Wl,--strip-all -Wl,--allow-shlib-undefined")
endforeach()

# ggml builds its Vulkan shader generator, a program that runs during the build, for the machine that builds
set(GGML_VULKAN_SHADERS_GEN_TOOLCHAIN "${_here}/zig-toolchain-host.cmake" CACHE FILEPATH "")

set(Vulkan_LIBRARY /usr/lib/aarch64-linux-gnu/libvulkan.so CACHE FILEPATH "libvulkan, which find_package does not search for when cross-compiling")
