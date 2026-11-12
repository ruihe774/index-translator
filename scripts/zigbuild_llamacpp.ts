// Build the translation engine with Zig: libllama and libmtmd (image input) from the pinned llama.cpp source,
// with ggml's Vulkan and CPU backends compiled in and nothing else of llama.cpp, and the shim (src/llama-shim.c,
// src/llama-shim-ext.cpp), linked into one library, ./vendor/llama.cpp/libllama.so (llama.dll on Windows), which the
// bindings open for all three.
// Usage: bun scripts/zigbuild_llamacpp.ts [--keep] [--shim] [--target=<triple>]
//
//   --target  the Zig target to build for (scripts/zig/zig-toolchain-<triple>.cmake must exist); this machine's by
//             default, into vendor/llama.cpp, else into vendor/llama.cpp-<triple>, which is not opened here
//   --keep    keep the source and the build tree in vendor/.build/llama.cpp-zig, and reuse them
//   --shim    only compile the shim again and link the library again, from the kept tree (after editing the shim)
//
// The CMake options are scripts/zig/llama.flags, the compiler is Zig (the toolchain file says for which CPU and libc;
// x86_64-linux-gnu, aarch64-linux-gnu and, on Windows, x86_64-windows-gnu). Needs git, cmake, ninja, zig, glslc and
// the Vulkan headers and libvulkan (on Windows the Vulkan SDK, found through VULKAN_SDK); no host C or C++ compiler.
// The library opens libvulkan.so.1 (vulkan-1.dll) when it loads; it is the only one besides libc (Windows' own DLLs).

import { cp, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { devices, libraryPath } from "../src/llama-ffi";
import { checkout, run, windows } from "./build_tools";
import {
  cacheValue,
  cmakeBuild,
  copyRuntimeLicenses,
  getHostTriple,
  parseOptions,
  requireZigBuildTools,
  targetDirectory,
  ZIG_TOOLS_HINT,
} from "./zigbuild_tools";

const TAG = "v0.9.0";
/** The commit of the tag. It is fetched by this id, so the source is what was reviewed even if the tag moves. */
const COMMIT = "cd959bae99ff4bed22bef2604f45241c09bbb8c8";
const REPO = "https://github.com/ggml-org/llama.cpp.git";
/** What the library exports: the calls the bindings make. ggml and the C++ runtime stay inside. */
const EXPORTS = ["llama_*", "mtmd_*", "shim_*"];

const { flags, triple } = await parseOptions(["--keep", "--shim"]);
const keep = flags.has("--keep");
const shimOnly = flags.has("--shim");
if (shimOnly && flags.size > 1) {
  throw new Error("--shim is used alone (or with --target)");
}

const root = resolve(import.meta.dir, "..");
const directory = targetDirectory("llama.cpp", triple);
const dest = join(root, "vendor", directory);
// Not the old scripts' tree: CMake's configuration there is another one
const work = join(root, "vendor", ".build", `${directory}-zig`);
const source = join(work, "src");
const build = join(work, "build");
const objects = join(work, "shim");
/** The new copy is put together here, so a failed build leaves the installed one alone. */
const stage = join(work, "stage");

/** Compiles the shim and links it with the static libraries of `build` into `stage`/libllama.so. */
async function link(): Promise<void> {
  await rm(objects, { recursive: true, force: true });
  await mkdir(objects, { recursive: true });
  const compile = [
    "-target",
    triple,
    "-O2",
    ...(windows ? [] : ["-fPIC"]),
    "-Wall",
    "-Wextra",
    ...["include", "src", "tools/mtmd", "ggml/include"].map((dir) => `-I${join(source, dir)}`),
  ];
  const cObject = join(objects, "llama-shim.o");
  const cxxObject = join(objects, "llama-shim-ext.o");
  await run(["zig", "cc", ...compile, "-c", "-o", cObject, join(root, "src", "llama-shim.c")]);
  await run(["zig", "c++", ...compile, "-std=c++17", "-c", "-o", cxxObject, join(root, "src", "llama-shim-ext.cpp")]);

  const archives = (await Array.fromAsync(new Bun.Glob("**/*.a").scan({ cwd: build })))
    // The shader generator's own build, a program for this machine
    .filter((path) => !path.includes("vulkan-shaders-gen"))
    .map((path) => join(build, path))
    .sort();
  await mkdir(stage, { recursive: true });
  const common = ["zig", "c++", "-target", triple, "-O2", "-shared", "-o", libraryPath(stage), cObject, cxxObject];
  const vulkan = await cacheValue(build, "Vulkan_LIBRARY");
  if (windows) {
    // Nothing is marked dllexport (llama.h under MinGW, and the shim alike), so the linker exports every symbol.
    // Hiding nothing is harmless here: a DLL's imports name the DLL, so libaudiocpp's ggml cannot bind to this one's.
    await run([...common, ...archives, vulkan]);
    // The linker's side products: the debug database and the import library
    for (const name of await readdir(stage)) {
      if (name.endsWith(".pdb") || name.endsWith(".lib")) {
        await rm(join(stage, name));
      }
    }
    return;
  }
  const exports = join(work, "exports.map");
  await Bun.write(exports, `{ global: ${EXPORTS.map((name) => `${name};`).join(" ")} local: *; };\n`);
  await run([
    ...common,
    // Stripped: the exports are the version script's
    "-Wl,--strip-all",
    "-Wl,--start-group",
    ...archives,
    "-Wl,--end-group",
    vulkan,
    `-Wl,--version-script=${exports}`,
    "-Wl,-soname,libllama.so",
    // Everything but what the system's libvulkan needs of a newer glibc than Zig's default target has
    "-Wl,--no-undefined",
    "-Wl,--allow-shlib-undefined",
  ]);
}

/** Opens the library in `dir` with the declarations the server uses and lists what it can compute on. */
function report(what: string): void {
  if (triple !== getHostTriple()) {
    console.log(`ok ${dest} (${what}; for ${triple}, so not opened here)`);
    return;
  }
  const found = devices(dest);
  for (const device of found) {
    console.log(`${device.type} ${device.label}`);
  }
  if (!found.some((d) => d.type === "cpu")) {
    throw new Error(`no CPU backend could be loaded from ${dest}`);
  }
  if (!found.some((d) => d.type === "gpu" || d.type === "igpu")) {
    console.log("no GPU with a Vulkan driver on this machine; the engine would need GPU_LAYERS=0 here");
  }
  console.log(`ok ${dest} (${what})`);
}

if (shimOnly) {
  if (!(await Bun.file(join(build, "CMakeCache.txt")).exists())) {
    throw new Error(`no build tree in ${build}; build with --keep first: bun scripts/zigbuild_llamacpp.ts --keep`);
  }
  await requireZigBuildTools();
  await rm(stage, { recursive: true, force: true });
  await link();
  await rm(libraryPath(dest), { force: true });
  await cp(libraryPath(stage), libraryPath(dest));
  await rm(stage, { recursive: true, force: true });
  report("shim rebuilt");
  process.exit(0);
}

await requireZigBuildTools();
if (!keep) {
  await rm(work, { recursive: true, force: true });
}
await checkout(REPO, COMMIT, source);

const started = performance.now();
try {
  await cmakeBuild("llama", triple, source, build);
  await rm(stage, { recursive: true, force: true });
  await link();
} catch (e) {
  console.error(`the build failed; if a tool or a header is missing, ${ZIG_TOOLS_HINT}`);
  throw e;
}
await cp(join(source, "LICENSE"), join(stage, "LICENSE"));
await copyRuntimeLicenses(triple, stage);
await Bun.write(join(stage, "VERSION"), `${TAG}\n`);

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await cp(stage, dest, { recursive: true });
if (!keep) {
  await rm(work, { recursive: true, force: true });
  // Gone too, unless another build keeps its tree there.
  await rmdir(join(root, "vendor", ".build")).catch(() => {});
}

const seconds = Math.round((performance.now() - started) / 1000);
if (!(await Bun.file(libraryPath(dest)).exists())) {
  throw new Error(`the build left no ${libraryPath(dest)}`);
}
report(`${TAG}, ${triple}, built in ${seconds} s`);
