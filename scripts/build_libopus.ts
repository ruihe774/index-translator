// Build libopus from the pinned source into ./vendor/opus: the encoder of the speech stream's Ogg Opus
// (src/opus-stream.ts) and its decoder, which the tests read that stream back with (Bun decodes no Opus).
// Usage: bun scripts/build_libopus.ts [--keep]
//
//   --keep  keep the source and the build tree in vendor/.build/opus, and reuse them
//
// The library picks its SIMD code (SSE to AVX2, or Neon) at run time, so the build is the same on every
// machine of an architecture. None of the neural parts (deep PLC, DRED, OSCE) is built: they need model
// weights that are not in the repository, and the speech stream is not sent over a lossy link.
//
// Needs git, cmake (3.16 or later), ninja and a C compiler. On Windows, Visual Studio 2022 or later (or its Build
// Tools) with the "Desktop development with C++" workload; the result is opus.dll. Building needs no administrator
// rights.

import { cp, mkdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { opusLibraryPath, opusVersion } from "../src/opus-ffi";
import { BUILD_TOOLS, checkout, COMPILERS, msvc, requireTools, run, TOOLS_HINT, windows } from "./build_tools";

const VERSION = "1.6.1";
/** The commit of the tag v1.6.1, fetched by this id so the source is what was reviewed. */
const COMMIT = "22244de5a79bd1d6d623c32e72bf1954b56235be";
const REPO = "https://github.com/xiph/opus.git";

const flags = new Set(Bun.argv.slice(2));
for (const flag of flags) {
  if (flag !== "--keep") {
    throw new Error(`unknown option ${flag}; see the head of this file`);
  }
}
const keep = flags.has("--keep");

const root = resolve(import.meta.dir, "..");
const dest = join(root, "vendor", "opus");
const work = join(root, "vendor", ".build", "opus");
const source = join(work, "src");
const build = join(work, "build");

await requireTools([...BUILD_TOOLS, ...COMPILERS], TOOLS_HINT);
// On Windows Ninja finds `cl` through the environment of a Developer Command Prompt.
const buildEnv = windows ? (await msvc()).env : undefined;

if (!keep) {
  await rm(work, { recursive: true, force: true });
}
await checkout(REPO, COMMIT, source);
// libopus's CMake build never defines the version that opus_get_version_string reports ("libopus unknown"); this
// file, run after its project(), does, quoted by CMake for whichever shell runs the compiler.
const versionScript = join(work, "version.cmake");
await Bun.write(versionScript, `add_compile_definitions(PACKAGE_VERSION="${VERSION}")\n`);

const started = performance.now();
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
    "-DOPUS_BUILD_SHARED_LIBRARY=ON",
    "-DOPUS_BUILD_TESTING=OFF",
    "-DOPUS_BUILD_PROGRAMS=OFF",
    "-DOPUS_INSTALL_PKG_CONFIG_MODULE=OFF",
    "-DOPUS_INSTALL_CMAKE_CONFIG_MODULE=OFF",
    // Forward slashes: CMake reads a backslash in a path as an escape.
    `-DCMAKE_PROJECT_INCLUDE=${versionScript.replaceAll("\\", "/")}`,
  ],
  undefined,
  buildEnv,
).catch((e: unknown) => {
  console.error("the build failed; is a tool missing?");
  throw e;
});
await run(["cmake", "--build", build], undefined, buildEnv);

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
// On Linux the file is libopus.so.0.<minor>.<patch> with links libopus.so.0 and libopus.so; the copy is named as its
// SONAME.
const built = windows
  ? join(build, "opus.dll")
  : (await Array.fromAsync(new Bun.Glob("libopus.so.0.*").scan({ cwd: build, absolute: true })))[0];
if (!built) {
  throw new Error("the build left no libopus.so.0.*");
}
await cp(built, opusLibraryPath(dest), { dereference: true });
await cp(join(source, "COPYING"), join(dest, "COPYING"));
await Bun.write(join(dest, "VERSION"), `${VERSION}\n`);
if (!keep) {
  await rm(work, { recursive: true, force: true });
  // Gone too, unless another build keeps its tree there.
  await rmdir(join(root, "vendor", ".build")).catch(() => {});
}

// Opens it, so a library that cannot load is found here.
const seconds = Math.round((performance.now() - started) / 1000);
console.log(`ok ${dest} (${opusVersion(dest)}, built in ${seconds} s)`);
