// Build the translation engine with Zig: libllama and libmtmd (image input) from the pinned llama.cpp source,
// with ggml's Vulkan and CPU backends compiled in and nothing else of llama.cpp, and the shim (src/llama-shim.c,
// src/llama-shim-ext.cpp), linked into one library, ./vendor/llama.cpp-zig/libllama.so. libmtmd.so and
// libllama-shim.so there are links to it, so the bindings open one file three times.
// Usage: bun scripts/zigbuild_llamacpp.ts [--keep] [--shim] [--target=<triple>]
//
//   --target  the Zig target to build for (scripts/zig/zig-toolchain-<triple>.cmake must exist); this machine's by
//             default, into vendor/llama.cpp-zig, else into vendor/llama.cpp-zig-<triple>, which is not opened here
//   --keep    keep the source and the build tree in vendor/.build/llama.cpp-zig, and reuse them
//   --shim    only compile the shim again and link the library again, from the kept tree (after editing the shim)
//
// The CMake options are scripts/zig/llama.flags, the compiler is Zig (the toolchain file says for which CPU and libc;
// x86_64-linux-gnu is the only target so far). Needs git, cmake, ninja, zig, glslc and the Vulkan
// headers and libvulkan; no host C or C++ compiler. The library opens libvulkan.so.1 when it loads; it is the only
// one besides libc.

import { cp, mkdir, rm, rmdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { devices, libraryPath, shimPath } from "../src/llama-ffi";
import { checkout, requireTools, run, TOOLS_HINT } from "./build_tools";
import {
  cacheValue,
  cmakeBuild,
  getHostTriple,
  parseOptions,
  targetDirectory,
  ZIG_BUILD_TOOLS,
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
const directory = targetDirectory("llama.cpp-zig", triple);
const dest = join(root, "vendor", directory);
const work = join(root, "vendor", ".build", directory);
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
    "-fPIC",
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
  const exports = join(work, "exports.map");
  await Bun.write(exports, `{ global: ${EXPORTS.map((name) => `${name};`).join(" ")} local: *; };\n`);
  await mkdir(stage, { recursive: true });
  await run([
    "zig",
    "c++",
    "-target",
    triple,
    "-O2",
    "-shared",
    // Stripped: the exports are the version script's
    "-Wl,--strip-all",
    "-o",
    libraryPath(stage),
    cObject,
    cxxObject,
    "-Wl,--start-group",
    ...archives,
    "-Wl,--end-group",
    await cacheValue(build, "Vulkan_LIBRARY"),
    `-Wl,--version-script=${exports}`,
    "-Wl,-soname,libllama.so",
    // Everything but what the system's libvulkan needs of a newer glibc than Zig's default target has
    "-Wl,--no-undefined",
    "-Wl,--allow-shlib-undefined",
  ]);
  for (const path of [join(stage, "libmtmd.so"), shimPath(stage)]) {
    await rm(path, { force: true });
    await symlink("libllama.so", path);
  }
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
  await requireTools(["zig"], TOOLS_HINT);
  await rm(stage, { recursive: true, force: true });
  await link();
  for (const name of ["libllama.so", "libmtmd.so", "libllama-shim.so"]) {
    await rm(join(dest, name), { force: true });
    await cp(join(stage, name), join(dest, name), { verbatimSymlinks: true });
  }
  await rm(stage, { recursive: true, force: true });
  report("shim rebuilt");
  process.exit(0);
}

await requireTools(ZIG_BUILD_TOOLS, TOOLS_HINT);
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
if (!(await Bun.file(libraryPath(dest)).exists())) {
  throw new Error(`the build left no ${libraryPath(dest)}`);
}
report(`${TAG}, ${triple}, built in ${seconds} s`);
