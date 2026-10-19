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
// Needs cmake (3.5 or later), a C compiler, tar (with xz) and nothing else; ninja is used when it
// is installed. On Windows, Visual Studio 2022 (or its Build Tools) with the "Desktop development with
// C++" workload; the result is soxr.dll. Building needs no administrator rights.

import { cp, mkdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { soxrLibraryPath, soxrVersion } from "../src/audiocpp-ffi";
import { COMPILERS, download, msvc, requireTools, run, windows } from "./build_tools";

const VERSION = "0.1.3";
/** The release tarball is downloaded by this checksum, so the source is what was reviewed. */
const SOURCE = {
  url: `https://downloads.sourceforge.net/project/soxr/soxr-${VERSION}-Source.tar.xz`,
  sha256: "b111c15fdc8c029989330ff559184198c161100a59312f5dc19ddeb9b5a15889",
};
const ARCHIVE = "soxr.tar.xz";

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
const source = join(work, `soxr-${VERSION}-Source`);
const build = join(work, "build");

requireTools(
  ["cmake", "tar", ...COMPILERS],
  "on Debian and Ubuntu: sudo apt install build-essential cmake ninja-build xz-utils",
);
const visualStudio = windows ? await msvc() : undefined;

if (!keep) {
  await rm(work, { recursive: true, force: true });
}
if (!(await Bun.file(join(source, "CMakeLists.txt")).exists())) {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await Bun.write(join(work, ARCHIVE), await download(SOURCE.url, SOURCE.sha256));
  // A relative name: tar takes "C:" in an absolute path on Windows for a remote host.
  await run(["tar", "-xf", ARCHIVE], work);
}

const started = performance.now();
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
  "-DBUILD_TESTS=OFF",
  "-DBUILD_EXAMPLES=OFF",
  // The resampler needs one thread, and OpenMP would make the library need libgomp.
  "-DWITH_OPENMP=OFF",
  // Nothing uses the libsamplerate-like interface.
  "-DWITH_LSR_BINDINGS=OFF",
  // soxr's CMake says 3.1 as its minimum, which CMake 4 no longer accepts.
  "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
]).catch((e: unknown) => {
  console.error("the build failed; is a tool missing?");
  throw e;
});
await run(["cmake", "--build", build, "--config", "Release", "--parallel", String(navigator.hardwareConcurrency)]);

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
// On Linux the file is named libsoxr.so.0.1.2 with links libsoxr.so.0 and libsoxr.so; the copy is
// named as its SONAME, which is what audio.cpp asks for. The Visual Studio generator puts the DLL
// in a configuration directory of its own.
const [built] = await Array.fromAsync(
  new Bun.Glob(windows ? "**/soxr.dll" : "src/libsoxr.so.0.*").scan({ cwd: build, absolute: true }),
);
if (!built) {
  throw new Error(`the build left no ${windows ? "soxr.dll" : "libsoxr.so.0.*"}`);
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
