# Zig as the C/C++ toolchain, for x86-64-v3 Windows with Zig's MinGW-w64 libc (UCRT) and libc++ linked in, so a DLL
# needs nothing but Windows' own libraries (and vulkan-1.dll, which comes with the graphics driver).
# Use: cmake -DCMAKE_TOOLCHAIN_FILE=scripts/zig/zig-toolchain-x86_64-windows-gnu.cmake ...
# Zig takes the CPU from the target, so -mavx2 and the like have no effect; -mcpu is what counts.
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR AMD64)

set(ZIG_TARGET "x86_64-windows-gnu")
set(ZIG_CPU "x86_64_v3")

set(CMAKE_C_COMPILER zig)
set(CMAKE_C_COMPILER_ARG1 cc)
set(CMAKE_CXX_COMPILER zig)
set(CMAKE_CXX_COMPILER_ARG1 c++)
# CMake takes one executable for these, so they are one-line wrappers
get_filename_component(_here "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
set(CMAKE_AR "${_here}/zig-ar.cmd")
set(CMAKE_RANLIB "${_here}/zig-ranlib.cmd")
# Zig has no windres; neither engine needs a resource file
set(CMAKE_RC_COMPILER "" CACHE FILEPATH "")

set(CMAKE_C_COMPILER_TARGET ${ZIG_TARGET})
set(CMAKE_CXX_COMPILER_TARGET ${ZIG_TARGET})
set(CMAKE_C_FLAGS_INIT "-mcpu=${ZIG_CPU} -flto=thin")
set(CMAKE_CXX_FLAGS_INIT "-mcpu=${ZIG_CPU} -flto=thin")
# The objects are bitcode, which the linker optimizes together all the same; -flto on a link (CMake repeats the
# compile flags there) makes Zig 0.17.1 build its MinGW libc as bitcode too, which then misses its own math and
# string functions. The last of -flto and -fno-lto wins
foreach(_kind EXE SHARED MODULE)
  set(CMAKE_${_kind}_LINKER_FLAGS_INIT "-fno-lto")
endforeach()

# ggml builds its Vulkan shader generator, a program that runs during the build, for the machine that builds
set(GGML_VULKAN_SHADERS_GEN_TOOLCHAIN "${_here}/zig-toolchain-host.cmake" CACHE FILEPATH "")

# The Vulkan SDK's import library. find_package does not search for it when cross-compiling, which CMake takes a set
# CMAKE_SYSTEM_NAME for; the SDK's installer sets VULKAN_SDK. The engines' scripts require it (requireZigBuildTools);
# libsoxr and libopus need no Vulkan
if(DEFINED ENV{VULKAN_SDK})
  file(TO_CMAKE_PATH "$ENV{VULKAN_SDK}" _vulkan_sdk)
  set(Vulkan_LIBRARY "${_vulkan_sdk}/Lib/vulkan-1.lib" CACHE FILEPATH "vulkan-1's import library, from the Vulkan SDK")
  set(Vulkan_INCLUDE_DIR "${_vulkan_sdk}/Include" CACHE PATH "the Vulkan headers, from the Vulkan SDK")
endif()
