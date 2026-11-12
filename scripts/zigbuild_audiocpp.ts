// Build the speech engine with Zig: audio.cpp's C API (libaudiocpp) from the pinned source, with the Vulkan
// backend and only the model families the server uses (IndexTTS-2 for speech, RoFormer for separating a voice from
// music and noise in a recording, MOSS and CED for transcription), into ./vendor/audio.cpp.
// Usage: bun scripts/zigbuild_audiocpp.ts [--keep] [--target=<triple>]
//
//   --target  the Zig target to build for (scripts/zig/zig-toolchain-<triple>.cmake must exist); this machine's by
//             default, into vendor/audio.cpp, else into vendor/audio.cpp-<triple>, which is not opened here
//   --keep    keep the source and the build tree in vendor/.build/audio.cpp-zig, and reuse them
//
// The CMake options are scripts/zig/audiocpp.flags, the compiler is Zig (the toolchain file says for which CPU and
// libc; x86_64-linux-gnu, aarch64-linux-gnu and, on Windows, x86_64-windows-gnu). Needs git, cmake, ninja, zig, glslc
// and the Vulkan headers and libvulkan (on Windows the Vulkan SDK, found through VULKAN_SDK); no host C or C++ compiler.
//
// ggml is linked in statically and only the audiocpp_* functions are exported:
// audio.cpp's ggml is a fork that shares its library name with llama.cpp's.

import { cp, mkdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { $ } from "bun";

import { libraryPath, libraryVersion, SILERO_WEIGHTS } from "../src/audiocpp-ffi";
import { checkout, run, windows } from "./build_tools";
import {
  cmakeBuild,
  copyRuntimeLicenses,
  getHostTriple,
  parseOptions,
  requireZigBuildTools,
  targetDirectory,
  ZIG_TOOLS_HINT,
} from "./zigbuild_tools";

/** Release v0.9.4 (it includes the Vulkan Flash Attention change for RoFormer). Written to VERSION and the build log. */
const TAG = "v0.9.4";
/** The commit of the tag. It is fetched by this id, so the source is what was reviewed even if the tag moves. */
const COMMIT = "f7ac446fb75e594a6913c846bea6c85b637f6ac0";
const REPO = "https://github.com/0xShug0/audio.cpp.git";
/**
 * Our changes to audio.cpp, applied in this order to the checkout before it is built (upstream has none of them):
 * `audiocpp_set_abort_flag`, a flag that stops a running IndexTTS-2 utterance; `audiocpp_result_custom_output`, which
 * reads a result's family-specific output (CED's scores); and the removal of `-Wl,--exclude-libs,ALL` from the link
 * of libaudiocpp, which Zig's linker does not know (the version script already hides everything but `audiocpp_*`).
 */
const PATCHES = ["audiocpp-abort.patch", "audiocpp-custom-output.patch", "audiocpp-zig-link.patch"].map((name) =>
  join(import.meta.dir, "patches", name),
);

const { flags, triple } = await parseOptions(["--keep"]);
const keep = flags.has("--keep");

const root = resolve(import.meta.dir, "..");
const directory = targetDirectory("audio.cpp", triple);
const dest = join(root, "vendor", directory);
// Not the old scripts' tree: CMake's configuration there is another one
const work = join(root, "vendor", ".build", `${directory}-zig`);
const source = join(work, "src");
const build = join(work, "build");

await requireZigBuildTools();
if (!keep) {
  await rm(work, { recursive: true, force: true });
}
await checkout(REPO, COMMIT, source);
// A tree kept by --keep has the patches already: taking the last one out again would then work.
const reverse = await $`git apply --reverse --check --ignore-whitespace ${PATCHES.at(-1)!}`
  .cwd(source)
  .quiet()
  .nothrow();
if (reverse.exitCode !== 0) {
  for (const patch of PATCHES) {
    await run(["git", "apply", "--ignore-whitespace", patch], source);
  }
}

const started = performance.now();
try {
  await cmakeBuild("audiocpp", triple, source, build, ["audiocpp"]);
} catch (e) {
  console.error(`the build failed; if a tool or a header is missing, ${ZIG_TOOLS_HINT}`);
  throw e;
}

// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await mkdir(join(dest, "include"), { recursive: true });
// build/bin/libaudiocpp.so is a link to the versioned file; the copy is the file. MinGW's CMake names the DLL
// libaudiocpp.dll; the bindings open audiocpp.dll.
const built = windows ? join(build, "bin", "libaudiocpp.dll") : libraryPath(join(build, "bin"));
await cp(built, libraryPath(dest), { dereference: true });
await cp(join(source, "include", "audiocpp.h"), join(dest, "include", "audiocpp.h"));
await cp(join(source, "LICENSE"), join(dest, "LICENSE"));
await cp(join(source, "external", "ggml", "LICENSE"), join(dest, "LICENSE.ggml"));
// libyaml (MIT) is linked in through audio.cpp's yaml_vendor, as cJSON and SentencePiece are.
await cp(join(source, "external", "libyaml", "License"), join(dest, "LICENSE.libyaml"));
await copyRuntimeLicenses(triple, dest);
// Silero VAD's weights ship with audio.cpp's source, not in a GGUF; the library is given their path. Their
// license (MIT) is not in audio.cpp's tree, so ours is a copy of the one in snakers4/silero-vad.
await cp(join(source, "assets", "framework", "models", "silero_vad", SILERO_WEIGHTS), join(dest, SILERO_WEIGHTS));
await cp(join(import.meta.dir, "licenses", "LICENSE.silero_vad"), join(dest, "LICENSE.silero_vad"));
await Bun.write(join(dest, "VERSION"), `${TAG}\n`);
if (!keep) {
  await rm(work, { recursive: true, force: true });
  // Gone too, unless another build keeps its tree there.
  await rmdir(join(root, "vendor", ".build")).catch(() => {});
}

// Opens the library with the declarations the server uses, so a function it needs cannot be missing.
const seconds = Math.round((performance.now() - started) / 1000);
if (triple === getHostTriple()) {
  const { abi } = libraryVersion(dest);
  console.log(`ok ${dest} (${TAG}, C API ${abi}, ${triple}, built in ${seconds} s)`);
} else {
  console.log(`ok ${dest} (${TAG}, ${triple}, built in ${seconds} s; not opened here)`);
}
