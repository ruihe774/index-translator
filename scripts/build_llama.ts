// Build the translation engine: libllama and libmtmd (image input) from the pinned llama.cpp source,
// with the Vulkan and CPU backends as loadable libraries and nothing else of llama.cpp (no tools,
// server or examples), and the shim (src/llama-shim.c, src/llama-shim-ext.cpp) as libllama-shim, into
// ./vendor/llama.cpp.
// Usage: bun scripts/build_llama.ts [--native] [--keep] [--shim] [--cuda [--cuda-arch=LIST]]
//
//   --native  build the CPU backend for this machine's processor; the library may then die with
//             SIGILL on another one. By default one CPU backend is built for a baseline: AVX2 and
//             FMA on x86-64 (Haswell, 2013), Armv8.2-A with dot product and fp16 on aarch64. The CPU
//             is only a fallback, so llama.cpp's every-variant set is not worth its build time.
//   --keep    keep the source and the build tree in vendor/.build/llama.cpp, and reuse them
//   --shim    only compile the shim again, against the headers and libraries already in
//             vendor/llama.cpp (after editing the shim)
//   --cuda    the CUDA 13 variant for NVIDIA GPUs instead of the Vulkan one, into ./vendor/llama.cpp-cuda:
//             the CUDA and CPU backends and no Vulkan, with the toolkit's runtime libraries (cudart, cuBLAS)
//             beside them. Linux only (x86-64 or aarch64). The toolkit is found through CUDA_PATH, CUDA_HOME,
//             /usr/local/cuda-13 or /usr/local/cuda. Needs nvcc, not glslc or the Vulkan headers.
//   --cuda-arch=LIST  the GPU architectures to compile for, CMake's CMAKE_CUDA_ARCHITECTURES (`native` for this
//             machine's GPU, which is much faster to build); by default 75-virtual;86-virtual: PTX for Turing and
//             Ampere that the driver compiles for the GPU on the first run (DEFAULT_CUDA_ARCH in build_tools.ts)
//
// Needs git, cmake (3.14 or later), a C and a C++ compiler, glslc and the Vulkan headers; ninja is
// used when it is installed. On Debian and Ubuntu:
//   sudo apt install build-essential git cmake ninja-build glslc libvulkan-dev spirv-headers
// On Windows: git, cmake, Visual Studio 2022 (or its Build Tools) with the "Desktop development
// with C++" workload, and the Vulkan SDK (glslc, the headers and vulkan-1.lib; it sets VULKAN_SDK).
// The result is llama.dll, mtmd.dll, ggml*.dll, ggml-cpu.dll, ggml-vulkan.dll and llama-shim.dll, plus the
// import libraries the shim is linked against. Building needs no administrator rights.

import { cp, mkdir, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { devices, libraryPath, shimPath } from "../src/llama-ffi";
import {
  bundleCuda,
  checkout,
  COMPILERS,
  CUDA_ARCH_OPTION,
  cudaArch,
  cudaCMakeOptions,
  findCuda,
  msvc,
  requireTools,
  run,
  TOOLS_HINT,
  windows,
} from "./build_tools";

const TAG = "v0.7.0";
/** The commit of the tag. It is fetched by this id, so the source is what was reviewed even if the tag moves. */
const COMMIT = "620d2225cc436ab0b001e3200e590e3b286ef9ab";
const REPO = "https://github.com/ggml-org/llama.cpp.git";
/**
 * llama.h, libmtmd's headers and everything they include, relative to the source tree. The shim is compiled against
 * them. src/llama-ext.h is llama.cpp's C++ staging header, which declares the calls multi-token prediction needs.
 */
const HEADERS = [
  "include/llama.h",
  "src/llama-ext.h",
  "tools/mtmd/mtmd.h",
  "tools/mtmd/mtmd-helper.h",
  "ggml/include/ggml.h",
  "ggml/include/ggml-alloc.h",
  "ggml/include/ggml-backend.h",
  "ggml/include/ggml-cpu.h",
  "ggml/include/ggml-opt.h",
  "ggml/include/gguf.h",
];

/**
 * What the code outside the CPU backend is compiled for. Said outright because a compiler's own
 * default can be newer (Ubuntu's x86-64-v3 builds default to AVX2), and the libraries that load
 * before the backend is checked against the processor would then need that.
 */
const BASELINE = process.arch === "x64" && !windows ? ["-march=x86-64"] : [];
/**
 * The CPU backend's instruction sets, named because ggml's defaults depend on the environment
 * (none of them without GGML_NATIVE_DEFAULT, which a set SOURCE_DATE_EPOCH turns off). On x86-64 a
 * processor without them fails to load the backend, which preflight reports; on aarch64 nothing
 * checks, and an older core dies with SIGILL.
 */
const CPU_ISA =
  process.arch === "x64"
    ? ["SSE42", "AVX", "AVX2", "BMI2", "FMA", "F16C"].map((isa) => `-DGGML_${isa}=ON`)
    : process.arch === "arm64"
      ? ["-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16"]
      : [];
const CPU_ISA_NAME = process.arch === "x64" ? "AVX2" : process.arch === "arm64" ? "Armv8.2-A" : process.arch;
/** The import libraries the shim is linked against on Windows; they stay beside the DLLs so `--shim` works. */
const IMPORT_LIBS = ["llama", "mtmd", "ggml", "ggml-base"];

const OPTIONS = ["--native", "--keep", "--shim", "--cuda"];
const flags = new Set(Bun.argv.slice(2));
for (const flag of flags) {
  if (!OPTIONS.includes(flag) && !flag.startsWith(CUDA_ARCH_OPTION)) {
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
// One GPU backend per directory: Vulkan in vendor/llama.cpp, CUDA in vendor/llama.cpp-cuda.
const directory = cuda ? "llama.cpp-cuda" : "llama.cpp";
const dest = join(root, "vendor", directory);
const work = join(root, "vendor", ".build", directory);
const source = join(work, "src");
const build = join(work, "build");
/** The new copy is put together here, so a failed build leaves the installed one alone. */
const stage = join(work, "stage");

/** The shim's C part, and its C++ part, which gives the staging header's functions C names. */
const SHIM_C = join(root, "src", "llama-shim.c");
const SHIM_CXX = join(root, "src", "llama-shim-ext.cpp");

/** Compiles the shim into `dir`, against the headers and the libraries that are in it. */
async function buildShim(dir: string): Promise<void> {
  const objects = join(work, "shim");
  await mkdir(objects, { recursive: true });
  if (windows) {
    // cl compiles the .c file as C and the .cpp file as C++.
    await run(
      [
        "cl",
        "/nologo",
        "/O2",
        "/LD",
        "/W3",
        "/EHsc",
        "/std:c++17",
        `/Fo${objects}\\`,
        `/Fe${shimPath(dir)}`,
        SHIM_C,
        SHIM_CXX,
        `/I${join(dir, "include")}`,
        "/link",
        `/LIBPATH:${dir}`,
        ...IMPORT_LIBS.map((name) => `${name}.lib`),
      ],
      undefined,
      (await msvc()).env,
    );
    // The shim's own import library and export file are not needed.
    for (const ext of [".lib", ".exp"]) {
      await unlink(shimPath(dir).replace(/\.dll$/, ext)).catch(() => {});
    }
    return;
  }
  const compile = ["-O2", ...BASELINE, "-fPIC", "-Wall", "-Wextra", `-I${join(dir, "include")}`];
  const cObject = join(objects, "llama-shim.o");
  const cxxObject = join(objects, "llama-shim-ext.o");
  await run(["cc", ...compile, "-c", "-o", cObject, SHIM_C]);
  await run(["c++", ...compile, "-std=c++17", "-c", "-o", cxxObject, SHIM_CXX]);
  // Linked as C++, which brings in its runtime library (libllama needs it anyway).
  await run([
    "c++",
    ...BASELINE,
    "-shared",
    "-o",
    shimPath(dir),
    cObject,
    cxxObject,
    `-L${dir}`,
    "-lllama",
    "-lmtmd",
    "-lggml",
    "-lggml-base",
    // The shim finds libllama beside itself, and a function the libraries lack fails here, not at startup.
    "-Wl,-rpath,$ORIGIN",
    "-Wl,--no-undefined",
  ]);
}

/** Opens the libraries in `dir` with the declarations the server uses and lists what they can compute on. */
function report(dir: string, what: string): void {
  const found = devices(dir);
  for (const device of found) {
    console.log(`${device.type} ${device.label}`);
  }
  if (!found.some((d) => d.type === "cpu")) {
    throw new Error(`no CPU backend could be loaded from ${dir}`);
  }
  if (!found.some((d) => d.type === "gpu" || d.type === "igpu")) {
    console.log(
      `no GPU with ${cuda ? "an NVIDIA driver" : "a Vulkan driver"} on this machine; the engine would need GPU_LAYERS=0 here`,
    );
  }
  console.log(`ok ${dir} (${what})`);
}

if (flags.has("--shim")) {
  if (flags.size > (cuda ? 2 : 1)) {
    throw new Error("--shim is used alone, or with --cuda");
  }
  requireTools(windows ? [] : ["cc", "c++"], TOOLS_HINT);
  for (const header of HEADERS) {
    const name = header.slice(header.lastIndexOf("/") + 1);
    if (!(await Bun.file(join(dest, "include", name)).exists())) {
      throw new Error(`${dest} has no ${name} (an older build); build it again: bun scripts/build_llama.ts`);
    }
  }
  await buildShim(dest);
  await rm(join(work, "shim"), { recursive: true, force: true });
  report(dest, "shim rebuilt");
  process.exit(0);
}

requireTools(["git", "cmake", ...COMPILERS, ...(cuda ? [] : ["glslc"])], TOOLS_HINT);
const cudaToolkit = cuda ? await findCuda() : undefined;
const visualStudio = windows ? await msvc() : undefined;

if (!keep) {
  await rm(work, { recursive: true, force: true });
}
await checkout(REPO, COMMIT, source);

const started = performance.now();
try {
  await run([
    "cmake",
    "-S",
    source,
    "-B",
    build,
    ...(visualStudio
      ? ["-G", visualStudio.generator, "-A", "x64"]
      : [...(Bun.which("ninja") ? ["-G", "Ninja"] : []), "-DCMAKE_BUILD_TYPE=Release"]),
    "-DBUILD_SHARED_LIBS=ON",
    // The libraries find each other in their own directory, wherever that is (on Windows a DLL's
    // dependencies are looked for beside it without any setting).
    ...(windows ? [] : ["-DCMAKE_INSTALL_RPATH=$ORIGIN", "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON"]),
    // Backends are libraries the shim loads from that directory (ggml_backend_load_all_from_path).
    "-DGGML_BACKEND_DL=ON",
    // Exactly one GPU backend, whichever the variant: a kept tree must not carry the other one over.
    `-DGGML_VULKAN=${cudaToolkit ? "OFF" : "ON"}`,
    `-DGGML_CUDA=${cudaToolkit ? "ON" : "OFF"}`,
    ...(cudaToolkit
      ? [
          ...cudaCMakeOptions(cudaToolkit, arch),
          // No NCCL (multi-GPU communication): one more library to ship, for a single-GPU engine.
          "-DGGML_CUDA_NCCL=OFF",
        ]
      : []),
    `-DGGML_NATIVE=${native ? "ON" : "OFF"}`,
    "-DGGML_CPU_ALL_VARIANTS=OFF",
    ...(native
      ? []
      : [...CPU_ISA, ...BASELINE.flatMap((flag) => [`-DCMAKE_C_FLAGS=${flag}`, `-DCMAKE_CXX_FLAGS=${flag}`])]),
    // Only libllama, libmtmd and ggml: the tools, the server and the tests all need the common library.
    "-DLLAMA_BUILD_COMMON=OFF",
    // libmtmd on its own, for image input. Its video support would start an ffmpeg found in PATH.
    "-DLLAMA_BUILD_MTMD=ON",
    "-DMTMD_VIDEO=OFF",
    "-DLLAMA_BUILD_TOOLS=OFF",
    "-DLLAMA_BUILD_SERVER=OFF",
    "-DLLAMA_BUILD_APP=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
  ]);
  await run(["cmake", "--build", build, "--config", "Release", "--parallel", String(navigator.hardwareConcurrency)]);

  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, "include"), { recursive: true });
  if (windows) {
    // The Visual Studio generator puts the DLLs in bin/Release and each import library in its target's own directory.
    const bin = join(build, "bin", "Release");
    for (const name of await readdir(bin)) {
      if (name.endsWith(".dll")) {
        await cp(join(bin, name), join(stage, name));
      }
    }
    for (const name of IMPORT_LIBS) {
      const [found] = await Array.fromAsync(
        new Bun.Glob(`**/Release/${name}.lib`).scan({ cwd: build, absolute: true }),
      );
      if (!found) {
        throw new Error(`the build left no ${name}.lib`);
      }
      await cp(found, join(stage, `${name}.lib`));
    }
  } else {
    // The libraries and the links to them (libllama.so -> libllama.so.0 -> the file), kept as links.
    for (const name of await readdir(join(build, "bin"))) {
      if (/\.so(\.|$)/.test(name)) {
        await cp(join(build, "bin", name), join(stage, name), { verbatimSymlinks: true });
      }
    }
  }
  for (const header of HEADERS) {
    await cp(join(source, header), join(stage, "include", header.slice(header.lastIndexOf("/") + 1)));
  }
  await buildShim(stage);
  if (cudaToolkit) {
    await bundleCuda(cudaToolkit, stage, ["libggml-cuda.so"]);
  }
} catch (e) {
  console.error(`the build failed; if a tool or a header is missing, ${TOOLS_HINT}`);
  throw e;
}
await cp(join(source, "LICENSE"), join(stage, "LICENSE"));
await Bun.write(join(stage, "VERSION"), `${TAG}\n`);
if (cudaToolkit) {
  await Bun.write(join(stage, "CUDA_VERSION"), `${cudaToolkit.version}\n`);
}

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await cp(stage, dest, { recursive: true, verbatimSymlinks: true });
if (!keep) {
  await rm(work, { recursive: true, force: true });
  // Gone too, unless another build keeps its tree there.
  await rmdir(join(root, "vendor", ".build")).catch(() => {});
}

const seconds = Math.round((performance.now() - started) / 1000);
if (!(await Bun.file(libraryPath(dest)).exists())) {
  throw new Error(`the build left no ${libraryPath(dest)}`);
}
report(
  dest,
  `${TAG}${cudaToolkit ? `, CUDA ${cudaToolkit.version}` : ""}, ${native ? "this machine's CPU" : CPU_ISA_NAME}, built in ${seconds} s`,
);
