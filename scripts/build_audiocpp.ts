// Build the speech engine: audio.cpp's C API (libaudiocpp) from the pinned source, with the Vulkan
// backend and only the IndexTTS-2 model family, into ./vendor/audio.cpp.
// Usage: bun scripts/build_audiocpp.ts [--native] [--keep]
//
//   --native  build the CPU code for this machine's processor; the library may then die with
//             SIGILL on another one. By default it needs AVX2, like llama.cpp's "haswell" variant.
//   --keep    keep the source and the build tree in vendor/.build/audio.cpp, and reuse them
//
// Needs git, cmake (3.20 or later), a C++ compiler, glslc and the Vulkan headers; ninja is used
// when it is installed. On Debian and Ubuntu:
//   sudo apt install build-essential git cmake ninja-build glslc libvulkan-dev spirv-headers
//
// audio.cpp publishes no build of its C API, and the library has to be this particular one: ggml
// is linked in statically and only the audiocpp_* functions are exported. audio.cpp's ggml is a
// fork that shares its library name (libggml.so.0) with llama.cpp's, so a build with shared ggml
// libraries cannot be loaded into the process that has libllama.

import { cp, mkdir, rm, rmdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { libraryPath, libraryVersion } from "../src/audiocpp-ffi";
import { checkout, requireTools, run } from "./build_tools";

const TAG = "v0.9.1";
/** The commit of the tag. It is fetched by this id, so the source is what was reviewed even if the tag moves. */
const COMMIT = "cf124a67cc55d8f65a9a15eec69edbff0fb212c8";
const REPO = "https://github.com/0xShug0/audio.cpp.git";
/** audio.cpp's CMake names of the model families to compile in; all of them take about ten times as long. */
const MODELS = ["index_tts2"];

const TOOLS_HINT =
  "on Debian and Ubuntu: sudo apt install build-essential git cmake ninja-build glslc libvulkan-dev spirv-headers";

const flags = new Set(Bun.argv.slice(2));
for (const flag of flags) {
  if (flag !== "--native" && flag !== "--keep") throw new Error(`unknown option ${flag}; see the head of this file`);
}
const native = flags.has("--native");
const keep = flags.has("--keep");

const root = resolve(import.meta.dir, "..");
const dest = join(root, "vendor", "audio.cpp");
const work = join(root, "vendor", ".build", "audio.cpp");
const source = join(work, "src");
const build = join(work, "build");

requireTools(["git", "cmake", "c++", "glslc"], TOOLS_HINT);

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
    ...(Bun.which("ninja") ? ["-G", "Ninja"] : []),
    "-DCMAKE_BUILD_TYPE=Release",
    "-DAUDIOCPP_BUILD_C_API=ON",
    "-DENGINE_ENABLE_VULKAN=ON",
    `-DENGINE_ENABLE_NATIVE_CPU=${native ? "ON" : "OFF"}`,
    // Static ggml inside the library; the "all variants" mode would build shared ggml libraries.
    "-DENGINE_ENABLE_CPU_ALL_VARIANTS=OFF",
    "-DAUDIOCPP_MODEL_SET=custom",
    `-DAUDIOCPP_MODELS=${MODELS.join(";")}`,
  ]);
  await run(["cmake", "--build", build, "--target", "audiocpp", "--parallel", String(availableParallelism())]);
} catch (e) {
  console.error(`the build failed; if a tool or a header is missing, ${TOOLS_HINT}`);
  throw e;
}

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await mkdir(join(dest, "include"), { recursive: true });
// build/bin/libaudiocpp.so is a link to the versioned file; the copy is the file.
await cp(libraryPath(join(build, "bin")), libraryPath(dest), { dereference: true });
await cp(join(source, "include", "audiocpp.h"), join(dest, "include", "audiocpp.h"));
await cp(join(source, "LICENSE"), join(dest, "LICENSE"));
await cp(join(source, "external", "ggml", "LICENSE"), join(dest, "LICENSE.ggml"));
await Bun.write(join(dest, "VERSION"), `${TAG}\n`);
if (!keep) {
  await rm(work, { recursive: true, force: true });
  // Gone too, unless another build keeps its tree there.
  await rmdir(join(root, "vendor", ".build")).catch(() => {});
}

// Opens the library with the declarations the server uses, so a function it needs cannot be missing.
const version = libraryVersion(dest);
const seconds = Math.round((performance.now() - started) / 1000);
console.log(
  `ok ${dest} (${TAG}, C API ${version.abi}, ${native ? "this machine's CPU" : "AVX2"}, built in ${seconds} s)`,
);
