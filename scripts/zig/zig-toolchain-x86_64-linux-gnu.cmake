# Zig as the C/C++ toolchain, for x86-64-v3 Linux with Zig's default glibc.
# Use: cmake -DCMAKE_TOOLCHAIN_FILE=scripts/zig/zig-toolchain-x86_64-linux-gnu.cmake ...
# Zig takes the CPU from the target, so -mavx2 and the like have no effect; -mcpu is what counts.
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(ZIG_TARGET "x86_64-linux-gnu")
set(ZIG_CPU "x86_64_v3")

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
set(CMAKE_C_FLAGS_INIT "-mcpu=${ZIG_CPU} -flto=thin")
set(CMAKE_CXX_FLAGS_INIT "-mcpu=${ZIG_CPU} -flto=thin")

# Stripped. The system libvulkan needs a newer glibc than Zig's default target; its symbols resolve at run time
foreach(_kind EXE SHARED MODULE)
  set(CMAKE_${_kind}_LINKER_FLAGS_INIT "-Wl,--strip-all -Wl,--allow-shlib-undefined")
endforeach()

# ggml builds its Vulkan shader generator, a program that runs during the build, for the machine that builds
set(GGML_VULKAN_SHADERS_GEN_TOOLCHAIN "${_here}/zig-toolchain-host.cmake" CACHE FILEPATH "")

# CMake takes the multiarch directory (/usr/lib/<triple> on Debian and Ubuntu) from the compiler's own library
# directories, which Zig's are not; named here, find_package(Vulkan) finds libvulkan there, as in /usr/lib64 (Fedora)
# and /usr/lib (Arch), which it searches anyway. -DVulkan_LIBRARY=<path> overrides it
set(CMAKE_LIBRARY_ARCHITECTURE x86_64-linux-gnu)
