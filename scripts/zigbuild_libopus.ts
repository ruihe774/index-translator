// Build libopus with Zig from the pinned source into ./vendor/opus: the encoder of the speech stream's Ogg Opus
// (src/opus-stream.ts) and its decoder, which the tests read that stream back with (Bun decodes no Opus).
// Usage: bun scripts/zigbuild_libopus.ts [--keep] [--target=<triple>]
//
//   --target  the Zig target to build for (scripts/zig/zig-toolchain-<triple>.cmake must exist); this machine's by
//             default, into vendor/opus, else into vendor/opus-<triple>, which is not opened here
//   --keep    keep the source and the build tree in vendor/.build/opus-zig, and reuse them
//
// None of the neural parts (deep PLC, DRED, OSCE) is built: they need model weights that are not in the repository,
// and the speech stream is not sent over a lossy link.
//
// The CMake options are scripts/zig/opus.flags, the compiler is Zig, as for the engines, so the library has the
// engines' processor baseline (x86-64-v3, Armv8.2-A). Needs git, cmake, ninja and zig; no host C compiler. Also builds
// on macOS (aarch64-macos), for the e2e mock server.

import { cp, mkdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { opusVersion } from "../src/opus-ffi";
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

const VERSION = "1.6.1";
/** The commit of the tag v1.6.1, fetched by this id so the source is what was reviewed. */
const COMMIT = "22244de5a79bd1d6d623c32e72bf1954b56235be";
const REPO = "https://github.com/xiph/opus.git";

const { flags, triple } = await parseOptions(["--keep"]);
const keep = flags.has("--keep");

const root = resolve(import.meta.dir, "..");
const directory = targetDirectory("opus", triple);
const dest = join(root, "vendor", directory);
const work = join(root, "vendor", ".build", `${directory}-zig`);
const source = join(work, "src");
const build = join(work, "build");

await requireZigBuildTools(false);
if (!keep) {
  await rm(work, { recursive: true, force: true });
}
await checkout(REPO, COMMIT, source);
// libopus's CMake build never defines the version that opus_get_version_string reports ("libopus unknown"); this
// file, run after its project(), does, quoted by CMake for whichever shell runs the compiler.
const versionScript = join(work, "version.cmake");
await Bun.write(versionScript, `add_compile_definitions(PACKAGE_VERSION="${VERSION}")\n`);

const started = performance.now();
try {
  // Forward slashes: CMake reads a backslash in a path as an escape.
  await cmakeBuild(
    "opus",
    triple,
    source,
    build,
    ["opus"],
    [`-DCMAKE_PROJECT_INCLUDE=${versionScript.replaceAll("\\", "/")}`],
  );
} catch (e) {
  console.error(`the build failed; if a tool is missing, ${zigToolsHint(false)}`);
  throw e;
}

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
// On Linux the file is libopus.so.0.<minor>.<patch> with links libopus.so.0 and libopus.so (on macOS
// libopus.0.<minor>.<patch>.dylib and libopus.0.dylib); the copy is the SONAME's link followed. MinGW's CMake names
// the DLL libopus.dll; the bindings open opus.dll.
const file = targetLibraryName(triple, "opus", 0);
const built = windowsTarget(triple) ? join(build, "libopus.dll") : join(build, file);
await cp(built, join(dest, file), { dereference: true });
await cp(join(source, "COPYING"), join(dest, "COPYING"));
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
  console.log(`ok ${dest} (${opusVersion(dest)}, ${triple}, built in ${seconds} s)`);
} else {
  console.log(`ok ${dest} (libopus ${VERSION}, ${triple}, built in ${seconds} s; not opened here)`);
}
