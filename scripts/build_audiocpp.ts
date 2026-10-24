// Build the speech engine: audio.cpp's C API (libaudiocpp) from the pinned source, with the Vulkan
// backend and only the model families the server uses (IndexTTS-2 for speech, RoFormer for
// separating a voice from music and noise in a recording), into ./vendor/audio.cpp.
// Usage: bun scripts/build_audiocpp.ts [--native] [--keep] [--cuda [--cuda-arch=LIST]]
//
//   --cuda    the CUDA 13 variant for NVIDIA GPUs instead of the Vulkan one, into ./vendor/audio.cpp-cuda:
//             CUDA and the CPU, no Vulkan, with the toolkit's runtime libraries (cudart, cuBLAS) beside the
//             library. Run it with SPEECH_BACKEND=cuda. Linux only; see scripts/build_llama.ts for the toolkit
//             and --cuda-arch (the default list is the same).
//
//   --native  build the CPU code for this machine's processor; the library may then die with
//             SIGILL on another one. By default it needs AVX2, like llama.cpp's "haswell" variant.
//   --keep    keep the source and the build tree in vendor/.build/audio.cpp, and reuse them
//
// Needs git, cmake (3.20 or later), ninja, a C++ compiler, glslc and the Vulkan headers. On Debian and Ubuntu:
//   sudo apt install build-essential git cmake ninja-build glslc libvulkan-dev spirv-headers
// On Windows: git, cmake, ninja (winget install Ninja-build.Ninja), Visual Studio 2022 or later (or its Build Tools) with the "Desktop development
// with C++" workload, and the Vulkan SDK (glslc, the headers and vulkan-1.lib; it sets VULKAN_SDK).
// The result is audiocpp.dll. Building needs no administrator rights.
//
// audio.cpp publishes no build of its C API, and the library has to be this particular one: ggml
// is linked in statically and only the audiocpp_* functions are exported. audio.cpp's ggml is a
// fork that shares its library name (libggml.so.0) with llama.cpp's, so a build with shared ggml
// libraries cannot be loaded into the process that has libllama.

import { cp, mkdir, rm, rmdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { $ } from "bun";

import { libraryPath, libraryVersion } from "../src/audiocpp-ffi";
import {
  BUILD_TOOLS,
  bundleCuda,
  checkout,
  COMPILERS,
  CUDA_ARCH_OPTION,
  CUDA_FFT,
  cudaArch,
  cudaCMakeOptions,
  findCuda,
  msvc,
  requireTools,
  run,
  TOOLS_HINT,
  windows,
} from "./build_tools";

const TAG = "v0.9.2";
/** The commit of the tag. It is fetched by this id, so the source is what was reviewed even if the tag moves. */
const COMMIT = "0097d365a00b52a6991ad7618f0a04e8d2935e47";
const REPO = "https://github.com/0xShug0/audio.cpp.git";
/**
 * audio.cpp's CMake names of the model families to compile in; all of them take about ten times as long.
 * `roformer` holds BS-RoFormer (used) and Mel-Band RoFormer, which share their code.
 */
const MODELS = ["index_tts2", "roformer"];
/**
 * Our one change to audio.cpp: `audiocpp_set_abort_flag`, a flag that stops a running IndexTTS-2
 * utterance (upstream has no way to). Applied to the checkout before it is built.
 */
const PATCH = join(import.meta.dir, "patches", "audiocpp-abort.patch");

const flags = new Set(Bun.argv.slice(2));
for (const flag of flags) {
  if (flag !== "--native" && flag !== "--keep" && flag !== "--cuda" && !flag.startsWith(CUDA_ARCH_OPTION)) {
    throw new Error(`unknown option ${flag}; see the head of this file`);
  }
}
const native = flags.has("--native");
const keep = flags.has("--keep");
const cuda = flags.has("--cuda");
const arch = cudaArch(flags);
if (arch && !cuda) {
  throw new Error(`${CUDA_ARCH_OPTION} goes with --cuda`);
}

const root = resolve(import.meta.dir, "..");
// One GPU backend per directory: Vulkan in vendor/audio.cpp, CUDA in vendor/audio.cpp-cuda.
const directory = cuda ? "audio.cpp-cuda" : "audio.cpp";
const dest = join(root, "vendor", directory);
const work = join(root, "vendor", ".build", directory);
const source = join(work, "src");
const build = join(work, "build");

requireTools([...BUILD_TOOLS, ...COMPILERS, ...(cuda ? [] : ["glslc"])], TOOLS_HINT);
const cudaToolkit = cuda ? await findCuda() : undefined;
// On Windows Ninja finds `cl` through the environment of a Developer Command Prompt.
const buildEnv = windows ? (await msvc()).env : undefined;

if (!keep) {
  await rm(work, { recursive: true, force: true });
}
await checkout(REPO, COMMIT, source);
// A tree kept by --keep has the patch already: taking it out again would then work.
const reverse = await $`git apply --reverse --check --ignore-whitespace ${PATCH}`.cwd(source).quiet().nothrow();
if (reverse.exitCode !== 0) {
  await run(["git", "apply", "--ignore-whitespace", PATCH], source);
}

const started = performance.now();
try {
  await run(
    [
      "cmake",
      "-S",
      source,
      "-B",
      build,
      "-G",
      "Ninja",
      "-DCMAKE_BUILD_TYPE=Release",
      "-DAUDIOCPP_BUILD_C_API=ON",
      // The BS-RoFormer GGUF embeds only a legacy model spec; the library then needs the current one
      // from its own catalog, which this compiles in (no model_specs/ directory at run time).
      "-DAUDIOCPP_DEPLOYMENT_BUILD=ON",
      // Exactly one GPU backend, whichever the variant: a kept tree must not carry the other one over.
      `-DENGINE_ENABLE_VULKAN=${cudaToolkit ? "OFF" : "ON"}`,
      `-DENGINE_ENABLE_CUDA=${cudaToolkit ? "ON" : "OFF"}`,
      ...(cudaToolkit
        ? [
            ...cudaCMakeOptions(cudaToolkit, arch),
            // The CUDA libraries are found beside libaudiocpp.so, wherever that is.
            "-DCMAKE_INSTALL_RPATH=$ORIGIN",
            "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
          ]
        : []),
      `-DENGINE_ENABLE_NATIVE_CPU=${native ? "ON" : "OFF"}`,
      // Static ggml inside the library; the "all variants" mode would build shared ggml libraries.
      "-DENGINE_ENABLE_CPU_ALL_VARIANTS=OFF",
      // As audio.cpp's own Windows script asks for "avx2": MSVC has no -march, so the instruction sets are named.
      ...(windows && !native
        ? [
            "-DGGML_AVX=ON",
            "-DGGML_AVX2=ON",
            "-DGGML_AVX512=OFF",
            "-DGGML_AVX512_VBMI=OFF",
            "-DGGML_AVX512_VNNI=OFF",
            "-DGGML_AVX512_BF16=OFF",
            "-DGGML_AVX_VNNI=OFF",
          ]
        : []),
      "-DAUDIOCPP_MODEL_SET=custom",
      `-DAUDIOCPP_MODELS=${MODELS.join(";")}`,
    ],
    undefined,
    buildEnv,
  );
  await run(["cmake", "--build", build, "--target", "audiocpp"], undefined, buildEnv);
} catch (e) {
  console.error(`the build failed; if a tool or a header is missing, ${TOOLS_HINT}`);
  throw e;
}

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await mkdir(join(dest, "include"), { recursive: true });
// audio.cpp's CMakeLists sets bin as the output directory of its libraries. On Linux build/bin/libaudiocpp.so
// is a link to the versioned file; the copy is the file.
await cp(libraryPath(join(build, "bin")), libraryPath(dest), { dereference: true });
await cp(join(source, "include", "audiocpp.h"), join(dest, "include", "audiocpp.h"));
await cp(join(source, "LICENSE"), join(dest, "LICENSE"));
await cp(join(source, "external", "ggml", "LICENSE"), join(dest, "LICENSE.ggml"));
await Bun.write(join(dest, "VERSION"), `${TAG}\n`);
if (cudaToolkit) {
  await bundleCuda(cudaToolkit, dest, [basename(libraryPath(dest))], [CUDA_FFT]);
  await Bun.write(join(dest, "CUDA_VERSION"), `${cudaToolkit.version}\n`);
}
if (!keep) {
  await rm(work, { recursive: true, force: true });
  // Gone too, unless another build keeps its tree there.
  await rmdir(join(root, "vendor", ".build")).catch(() => {});
}

// Opens the library with the declarations the server uses, so a function it needs cannot be missing. A CUDA build
// cannot open without the NVIDIA driver (CI has none); `bundleCuda` has already checked that nothing else is missing.
let abi = "not opened, no NVIDIA driver here";
try {
  abi = `C API ${libraryVersion(dest).abi}`;
} catch (e) {
  if (!cudaToolkit || !String(e).includes("libcuda.so.1")) {
    throw e;
  }
}
const seconds = Math.round((performance.now() - started) / 1000);
console.log(
  `ok ${dest} (${TAG}${cudaToolkit ? `, CUDA ${cudaToolkit.version}` : ""}, ${abi}, ${native ? "this machine's CPU" : process.arch === "x64" ? "AVX2" : process.arch}, built in ${seconds} s)`,
);
