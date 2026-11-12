// Build libsoxr (the SoX Resampler Library) with Zig from the pinned source into ./vendor/soxr.
// Usage: bun scripts/zigbuild_soxr.ts [--keep] [--target=<triple>]
//
//   --target  the Zig target to build for (scripts/zig/zig-toolchain-<triple>.cmake must exist); this machine's by
//             default, into vendor/soxr, else into vendor/soxr-<triple>, which is not opened here
//   --keep    keep the source and the build tree in vendor/.build/soxr-zig, and reuse them
//
// audio.cpp resamples with libsoxr when it can find one (it opens "libsoxr.so.0", or "soxr.dll", at
// run time) and with its own, different resamplers when it cannot, so what the voice sounds like
// would depend on what the machine happens to have installed. src/audiocpp-ffi.ts opens the library
// built here before libaudiocpp, so audio.cpp is always handed this one, never another that is
// installed.
//
// The CMake options are scripts/zig/soxr.flags (no OpenMP, which would make the library need libgomp: the resampler
// needs one thread; no libsamplerate-like interface, which nothing uses; CMake 3.5 as the policy minimum, since soxr
// says 3.1, which CMake 4 no longer accepts), the compiler is Zig, as for the engines. Needs git, cmake, ninja and
// zig; no host C compiler. Also builds on macOS (aarch64-macos), for the e2e mock server.

import { cp, mkdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { soxrVersion } from "../src/audiocpp-ffi";
import { checkout } from "./build_tools";
import {
  cmakeBuild,
  copyRuntimeLicenses,
  getHostTriple,
  parseOptions,
  requireZigBuildTools,
  targetDirectory,
  targetLibraryName,
  windowsTarget,
  zigToolsHint,
} from "./zigbuild_tools";

const VERSION = "0.1.3";
/**
 * The commit of the tag 0.1.3, fetched by this id so the source is what was reviewed. Its tree is the
 * release tarball's (soxr-0.1.3-Source.tar.xz) plus files the build does not use. A git fetch, not the
 * tarball: `tar` of a Windows runner hung on the .xz.
 */
const COMMIT = "945b592b70470e29f917f4de89b4281fbbd540c0";
const REPO = "https://git.code.sf.net/p/soxr/code";

const { flags, triple } = await parseOptions(["--keep"]);
const keep = flags.has("--keep");

const root = resolve(import.meta.dir, "..");
const directory = targetDirectory("soxr", triple);
const dest = join(root, "vendor", directory);
const work = join(root, "vendor", ".build", `${directory}-zig`);
const source = join(work, "src");
const build = join(work, "build");

await requireZigBuildTools(false);
if (!keep) {
  await rm(work, { recursive: true, force: true });
}
await checkout(REPO, COMMIT, source);

const started = performance.now();
try {
  await cmakeBuild("soxr", triple, source, build, ["soxr"]);
} catch (e) {
  console.error(`the build failed; if a tool is missing, ${zigToolsHint(false)}`);
  throw e;
}

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
// On Linux the file is named libsoxr.so.0.1.2 with links libsoxr.so.0 and libsoxr.so (on macOS libsoxr.0.1.2.dylib
// and libsoxr.0.dylib); the copy is the SONAME's link followed, which is what audio.cpp asks for. soxr's CMakeLists
// puts the DLL in bin, named libsoxr.dll by MinGW's CMake; audio.cpp asks for soxr.dll.
const file = targetLibraryName(triple, "soxr", 0);
const built = windowsTarget(triple) ? join(build, "bin", "libsoxr.dll") : join(build, "src", file);
await cp(built, join(dest, file), { dereference: true });
await cp(join(source, "LICENCE"), join(dest, "LICENCE"));
await cp(join(source, "COPYING.LGPL"), join(dest, "COPYING.LGPL"));
await copyRuntimeLicenses(triple, dest);
await Bun.write(join(dest, "VERSION"), `${VERSION}\n`);
if (!keep) {
  await rm(work, { recursive: true, force: true });
  // Gone too, unless another build keeps its tree there.
  await rmdir(join(root, "vendor", ".build")).catch(() => {});
}

// Opens it, so a library that cannot load is found here.
const seconds = Math.round((performance.now() - started) / 1000);
if (triple === getHostTriple()) {
  console.log(`ok ${dest} (libsoxr ${soxrVersion(dest)}, ${triple}, built in ${seconds} s)`);
} else {
  console.log(`ok ${dest} (libsoxr ${VERSION}, ${triple}, built in ${seconds} s; not opened here)`);
}
