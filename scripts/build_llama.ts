// Build the translation engine: libllama and libmtmd (image input) from the pinned llama.cpp source,
// with the Vulkan and CPU backends as loadable libraries and nothing else of llama.cpp (no tools,
// server or examples), and the C shim (src/llama-shim.c) as libllama-shim, into ./vendor/llama.cpp.
// Usage: bun scripts/build_llama.ts [--native] [--keep] [--shim]
//
//   --native  build one CPU backend for this machine's processor; the library may then die with
//             SIGILL on another one. By default every CPU variant is built (as in llama.cpp's
//             releases) and the best one the processor supports is picked when the engine starts.
//   --keep    keep the source and the build tree in vendor/.build/llama.cpp, and reuse them
//   --shim    only compile src/llama-shim.c again, against the headers and libraries already in
//             vendor/llama.cpp (after editing the shim)
//
// Needs git, cmake (3.14 or later), a C and a C++ compiler, glslc and the Vulkan headers; ninja is
// used when it is installed. On Debian and Ubuntu:
//   sudo apt install build-essential git cmake ninja-build glslc libvulkan-dev spirv-headers
// On Windows: git, cmake, Visual Studio 2022 (or its Build Tools) with the "Desktop development
// with C++" workload, and the Vulkan SDK (glslc, the headers and vulkan-1.lib; it sets VULKAN_SDK).
// The result is llama.dll, mtmd.dll, ggml*.dll, ggml-cpu-*.dll, ggml-vulkan.dll and llama-shim.dll, plus the
// import libraries the shim is linked against. Building needs no administrator rights.

import { cp, mkdir, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { devices, libraryPath, shimPath } from "../src/llama-ffi";
import { COMPILERS, checkout, msvc, requireTools, run, TOOLS_HINT, windows } from "./build_tools";

const TAG = "b11552";
/** The commit of the tag. It is fetched by this id, so the source is what was reviewed even if the tag moves. */
const COMMIT = "23b0202a189c44a54625aadcb37a946dd1d6278d";
const REPO = "https://github.com/ggml-org/llama.cpp.git";
/** llama.h, libmtmd's headers and everything they include, relative to the source tree. The shim is compiled against them. */
const HEADERS = [
  "include/llama.h",
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
 * What the code outside the CPU variants is compiled for. Said outright because a compiler's own
 * default can be newer (Ubuntu's x86-64-v3 builds default to AVX2), and every variant, the plain
 * "x64" one included, would then need that.
 */
const BASELINE = process.arch === "x64" && !windows ? ["-march=x86-64"] : [];
/** The import libraries the shim is linked against on Windows; they stay beside the DLLs so `--shim` works. */
const IMPORT_LIBS = ["llama", "mtmd", "ggml", "ggml-base"];

const OPTIONS = ["--native", "--keep", "--shim"];
const flags = new Set(Bun.argv.slice(2));
for (const flag of flags) {
  if (!OPTIONS.includes(flag)) throw new Error(`unknown option ${flag}; see the head of this file`);
}
const native = flags.has("--native");
const keep = flags.has("--keep");

const root = resolve(import.meta.dir, "..");
const dest = join(root, "vendor", "llama.cpp");
const work = join(root, "vendor", ".build", "llama.cpp");
const source = join(work, "src");
const build = join(work, "build");
/** The new copy is put together here, so a failed build leaves the installed one alone. */
const stage = join(work, "stage");

/** Compiles the shim into `dir`, against the headers and the libraries that are in it. */
async function buildShim(dir: string): Promise<void> {
  if (windows) {
    const objects = join(work, "shim");
    await mkdir(objects, { recursive: true });
    await run(
      [
        "cl",
        "/nologo",
        "/O2",
        "/LD",
        "/W3",
        `/Fo${objects}\\`,
        `/Fe${shimPath(dir)}`,
        join(root, "src", "llama-shim.c"),
        `/I${join(dir, "include")}`,
        "/link",
        `/LIBPATH:${dir}`,
        ...IMPORT_LIBS.map((name) => `${name}.lib`),
      ],
      undefined,
      (await msvc()).env,
    );
    // The shim's own import library and export file are not needed.
    for (const ext of [".lib", ".exp"]) await unlink(shimPath(dir).replace(/\.dll$/, ext)).catch(() => {});
    return;
  }
  await run([
    "cc",
    "-O2",
    ...BASELINE,
    "-fPIC",
    "-shared",
    "-Wall",
    "-Wextra",
    "-o",
    shimPath(dir),
    join(root, "src", "llama-shim.c"),
    `-I${join(dir, "include")}`,
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
  for (const device of found) console.log(`${device.type} ${device.label}`);
  if (!found.some((d) => d.type === "cpu")) throw new Error(`no CPU backend could be loaded from ${dir}`);
  if (!found.some((d) => d.type === "gpu" || d.type === "igpu")) {
    console.log("no GPU with a Vulkan driver on this machine; the engine would need GPU_LAYERS=0 here");
  }
  console.log(`ok ${dir} (${what})`);
}

if (flags.has("--shim")) {
  if (flags.size > 1) throw new Error("--shim is used alone");
  requireTools(windows ? [] : ["cc"], TOOLS_HINT);
  await buildShim(dest);
  await rm(join(work, "shim"), { recursive: true, force: true });
  report(dest, "shim rebuilt");
  process.exit(0);
}

requireTools(["git", "cmake", ...COMPILERS, "glslc"], TOOLS_HINT);
const visualStudio = windows ? await msvc() : undefined;

if (!keep) await rm(work, { recursive: true, force: true });
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
    "-DGGML_VULKAN=ON",
    `-DGGML_NATIVE=${native ? "ON" : "OFF"}`,
    `-DGGML_CPU_ALL_VARIANTS=${native ? "OFF" : "ON"}`,
    ...(native ? [] : BASELINE.flatMap((flag) => [`-DCMAKE_C_FLAGS=${flag}`, `-DCMAKE_CXX_FLAGS=${flag}`])),
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
      if (name.endsWith(".dll")) await cp(join(bin, name), join(stage, name));
    }
    for (const name of IMPORT_LIBS) {
      const [found] = await Array.fromAsync(
        new Bun.Glob(`**/Release/${name}.lib`).scan({ cwd: build, absolute: true }),
      );
      if (!found) throw new Error(`the build left no ${name}.lib`);
      await cp(found, join(stage, `${name}.lib`));
    }
  } else {
    // The libraries and the links to them (libllama.so -> libllama.so.0 -> the file), kept as links.
    for (const name of await readdir(join(build, "bin"))) {
      if (/\.so(\.|$)/.test(name)) await cp(join(build, "bin", name), join(stage, name), { verbatimSymlinks: true });
    }
  }
  for (const header of HEADERS) {
    await cp(join(source, header), join(stage, "include", header.slice(header.lastIndexOf("/") + 1)));
  }
  await buildShim(stage);
} catch (e) {
  console.error(`the build failed; if a tool or a header is missing, ${TOOLS_HINT}`);
  throw e;
}
await cp(join(source, "LICENSE"), join(stage, "LICENSE"));
await Bun.write(join(stage, "VERSION"), `${TAG}\n`);

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await cp(stage, dest, { recursive: true, verbatimSymlinks: true });
if (!keep) {
  await rm(work, { recursive: true, force: true });
  // Gone too, unless another build keeps its tree there.
  await rmdir(join(root, "vendor", ".build")).catch(() => {});
}

const seconds = Math.round((performance.now() - started) / 1000);
const variants = (await readdir(dest)).filter((name) => /^(lib)?ggml-cpu/.test(name)).length;
if (!(await Bun.file(libraryPath(dest)).exists())) throw new Error(`the build left no ${libraryPath(dest)}`);
report(dest, `${TAG}, ${native ? "this machine's CPU" : `${variants} CPU variants`}, built in ${seconds} s`);
