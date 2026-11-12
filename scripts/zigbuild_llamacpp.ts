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

/** The names in a 64-bit PE file's export table (a DLL). */
function peExportNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(0x3c, true);
  if (view.getUint32(pe, true) !== 0x00_00_45_50 /* "PE\0\0" */) {
    throw new Error("not a PE file");
  }
  const sectionCount = view.getUint16(pe + 6, true);
  const optionalSize = view.getUint16(pe + 20, true);
  const optional = pe + 24;
  if (view.getUint16(optional, true) !== 0x02_0b) {
    throw new Error("not a PE32+ file");
  }
  // Data directory 0 is the export table, 112 bytes into the optional header
  const exportRva = view.getUint32(optional + 112, true);
  if (exportRva === 0) {
    return [];
  }
  const sections = optional + optionalSize;
  const offsetOf = (rva: number): number => {
    for (let i = 0; i < sectionCount; i++) {
      const at = sections + i * 40;
      const start = view.getUint32(at + 12, true);
      const size = Math.max(view.getUint32(at + 8, true), view.getUint32(at + 16, true));
      if (rva >= start && rva < start + size) {
        return rva - start + view.getUint32(at + 20, true);
      }
    }
    throw new Error(`RVA ${rva} is in no section`);
  };
  const table = offsetOf(exportRva);
  const count = view.getUint32(table + 24, true);
  const namesAt = offsetOf(view.getUint32(table + 32, true));
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = offsetOf(view.getUint32(namesAt + i * 4, true));
    const end = bytes.indexOf(0, start);
    names.push(decoder.decode(bytes.subarray(start, end)));
  }
  return names;
}

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
    // Nothing is marked dllexport (llama.h under MinGW, and the shim alike), so a link without a .def exports every
    // symbol (about 8,800, ggml and libc++ inside). A .def has no wildcards, so the first link only finds the names:
    // its export table is filtered by EXPORTS, the same list as the Linux version script, and the second link
    // exports exactly those.
    await run([...common, ...archives, vulkan]);
    const names = peExportNames(await Bun.file(libraryPath(stage)).bytes());
    const globs = EXPORTS.map((pattern) => new Bun.Glob(pattern));
    const wanted = names.filter((name) => globs.some((glob) => glob.match(name))).sort();
    if (wanted.length === 0 || !wanted.some((name) => name.startsWith("llama_"))) {
      throw new Error(`the first link exports no llama_* symbol (${names.length} exports in all)`);
    }
    const def = join(work, "exports.def");
    await Bun.write(def, `LIBRARY llama.dll\nEXPORTS\n${wanted.map((name) => `  ${name}`).join("\n")}\n`);
    await rm(libraryPath(stage), { force: true });
    await run([...common, ...archives, vulkan, def]);
    console.log(`exports: ${wanted.length} of ${names.length} symbols`);
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
