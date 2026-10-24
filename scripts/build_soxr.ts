// Build libsoxr (the SoX Resampler Library) from the pinned source into ./vendor/soxr.
// Usage: bun scripts/build_soxr.ts [--keep]
//
//   --keep  keep the source and the build tree in vendor/.build/soxr, and reuse them
//
// audio.cpp resamples with libsoxr when it can find one (it opens "libsoxr.so.0", or "soxr.dll", at
// run time) and with its own, different resamplers when it cannot, so what the voice sounds like
// would depend on what the machine happens to have installed. src/audiocpp-ffi.ts opens the library
// built here before libaudiocpp, so audio.cpp is always handed this one, never another that is
// installed.
//
// Needs git, cmake (3.5 or later), ninja and a C compiler. On Windows, Visual Studio 2022 (or its Build Tools)
// with the "Desktop development with C++" workload; the result is soxr.dll. Building needs no administrator
// rights.

import { cp, mkdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { soxrLibraryPath, soxrVersion } from "../src/audiocpp-ffi";
import { BUILD_TOOLS, checkout, COMPILERS, msvc, requireTools, run, TOOLS_HINT, windows } from "./build_tools";

const VERSION = "0.1.3";
/**
 * The commit of the tag 0.1.3, fetched by this id so the source is what was reviewed. Its tree is the
 * release tarball's (soxr-0.1.3-Source.tar.xz) plus files the build does not use. A git fetch, not the
 * tarball: `tar` of a Windows runner hung on the .xz.
 */
const COMMIT = "945b592b70470e29f917f4de89b4281fbbd540c0";
const REPO = "https://git.code.sf.net/p/soxr/code";

const flags = new Set(Bun.argv.slice(2));
for (const flag of flags) {
  if (flag !== "--keep") {
    throw new Error(`unknown option ${flag}; see the head of this file`);
  }
}
const keep = flags.has("--keep");

const root = resolve(import.meta.dir, "..");
const dest = join(root, "vendor", "soxr");
const work = join(root, "vendor", ".build", "soxr");
const source = join(work, "src");
const build = join(work, "build");

requireTools([...BUILD_TOOLS, ...COMPILERS], TOOLS_HINT);
// On Windows Ninja finds `cl` through the environment of a Developer Command Prompt.
const buildEnv = windows ? (await msvc()).env : undefined;

if (!keep) {
  await rm(work, { recursive: true, force: true });
}
await checkout(REPO, COMMIT, source);

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
    "-DBUILD_SHARED_LIBS=ON",
    "-DBUILD_TESTS=OFF",
    "-DBUILD_EXAMPLES=OFF",
    // The resampler needs one thread, and OpenMP would make the library need libgomp.
    "-DWITH_OPENMP=OFF",
    // Nothing uses the libsamplerate-like interface.
    "-DWITH_LSR_BINDINGS=OFF",
    // soxr's CMake says 3.1 as its minimum, which CMake 4 no longer accepts.
    "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
  ],
  undefined,
  buildEnv,
).catch((e: unknown) => {
  console.error("the build failed; is a tool missing?");
  throw e;
});
await run(["cmake", "--build", build, "--parallel", String(navigator.hardwareConcurrency)], undefined, buildEnv);

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
// On Linux the file is named libsoxr.so.0.1.2 with links libsoxr.so.0 and libsoxr.so; the copy is
// named as its SONAME, which is what audio.cpp asks for. On Windows soxr's CMakeLists puts the DLL in bin.
const built = windows
  ? join(build, "bin", "soxr.dll")
  : (await Array.fromAsync(new Bun.Glob("src/libsoxr.so.0.*").scan({ cwd: build, absolute: true })))[0];
if (!built) {
  throw new Error("the build left no libsoxr.so.0.*");
}
await cp(built, soxrLibraryPath(dest), { dereference: true });
await cp(join(source, "LICENCE"), join(dest, "LICENCE"));
await cp(join(source, "COPYING.LGPL"), join(dest, "COPYING.LGPL"));
await Bun.write(join(dest, "VERSION"), `${VERSION}\n`);
if (!keep) {
  await rm(work, { recursive: true, force: true });
  // Gone too, unless another build keeps its tree there.
  await rmdir(join(root, "vendor", ".build")).catch(() => {});
}

// Opens it, so a library that cannot load is found here.
const seconds = Math.round((performance.now() - started) / 1000);
console.log(`ok ${dest} (libsoxr ${soxrVersion(dest)}, built in ${seconds} s)`);
