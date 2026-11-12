// Pack the app into one file that runs on other Linux machines: dist/Index_Translator-<arch>.AppImage (x86_64 or aarch64, as the machine),
// with Bun, the web app and both engines as they are in ./vendor (libllama with its backends and the shim in one
// library, libaudiocpp), libsoxr, libopus and sat.wasm. The models and the voices are not packed; the AppImage's `fetch`
// subcommand (scripts/fetch_models.ts) downloads them into the user's data directory.
// Usage: bun scripts/build_appimage.ts
//
// Before it: bun scripts/zigbuild_llamacpp.ts && bun scripts/zigbuild_audiocpp.ts (this machine's target, packed as
// built), bun scripts/zigbuild_soxr.ts, bun scripts/zigbuild_libopus.ts (the Opus encoder), and
// bun scripts/fetch_web_libs.ts (the web app's PDF and Word libraries, packed with public/), bun scripts/fetch_turndown.ts (web pages as Markdown) and
// bun scripts/fetch_sat_wasm.ts (sat.wasm, for sentence segmentation), and bun scripts/build_bun.ts (the Bun that is
// packed: a minimal build, not the one running this script).
// The AppImage needs what the engines were linked against, so it runs on systems at least as new
// as the one it was built on (their C and C++ libraries), with a Vulkan driver, and curl
// for `fetch`. Layout and start script: packaging/appimage/.
//
// Needs nothing installed besides Bun and git: appimagetool and the AppImage runtime are
// downloaded, by version and checksum, into vendor/.build/appimage and kept there.

import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { libraryPath as audioLibrary } from "../src/audiocpp-ffi";
import { soxrLibraryPath } from "../src/ffi-util";
import { libraryPath as llamaLibrary } from "../src/llama-ffi";
import { opusLibraryPath } from "../src/opus-ffi";
import { bunPath } from "./build_bun";
import { output, run } from "./build_tools";
import { downloadUnlessMatches } from "./fetch_tools";
import { copyEngine, requireAllVendored, root, stageApp } from "./stage_app";

/** The checksums of the two downloaded tools, per architecture (`process.arch` names the key). */
const ARCHES = {
  x64: {
    name: "x86_64",
    appimagetool: "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0",
    runtime: "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
  },
  arm64: {
    name: "aarch64",
    appimagetool: "f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158",
    runtime: "00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444",
  },
} as const;
const arch = ARCHES[process.arch as keyof typeof ARCHES];
if (process.platform !== "linux" || !arch) {
  throw new Error("the AppImage is built on, and for, x86-64 or aarch64 Linux");
}
const ARCH = arch.name;

if (Bun.argv.length > 2) {
  throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
}

const NAME = `Index_Translator-${ARCH}.AppImage`;

const APPIMAGETOOL = {
  url: `https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-${ARCH}.AppImage`,
  sha256: arch.appimagetool,
};
/** What every AppImage starts with: mounts the image and runs AppRun. Static, so it needs no libfuse on the user's system. */
const RUNTIME = {
  url: `https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-${ARCH}`,
  sha256: arch.runtime,
};

const packaging = join(root, "packaging", "appimage");
const llama = join(root, "vendor", "llama.cpp");
const audio = join(root, "vendor", "audio.cpp");
const soxr = join(root, "vendor", "soxr");
const opus = join(root, "vendor", "opus");
const bun = join(root, "vendor", "bun");
const work = join(root, "vendor", ".build", "appimage");
const appDir = join(work, "AppDir");
const app = join(appDir, "usr", "share", "index-translator");
const out = join(root, "dist", NAME);

for (const [file, script] of [
  [llamaLibrary(llama), "zigbuild_llamacpp.ts"],
  [audioLibrary(audio), "zigbuild_audiocpp.ts"],
  [soxrLibraryPath(soxr), "zigbuild_soxr.ts"],
  [opusLibraryPath(opus), "zigbuild_libopus.ts"],
  [bunPath(bun), "build_bun.ts"],
] as const) {
  if (!(await Bun.file(file).exists())) {
    throw new Error(`${file} is missing; run: bun scripts/${script}`);
  }
}
await requireAllVendored();

await rm(appDir, { recursive: true, force: true });
await mkdir(join(appDir, "usr", "bin"), { recursive: true });
await mkdir(app, { recursive: true });

// The repository's own layout under usr/share/index-translator, so the code finds its files the way it does in a checkout.
await stageApp(app);
await copyEngine(llama, join(app, "vendor", "llama.cpp"));
await copyEngine(audio, join(app, "vendor", "audio.cpp"));
await copyEngine(soxr, join(app, "vendor", "soxr"));
await copyEngine(opus, join(app, "vendor", "opus"));

const commit = (await output(["git", "describe", "--tags", "--always", "--dirty"], root)) || "unknown";
const version = [
  `index-translator ${commit}`,
  `llama.cpp ${(await Bun.file(join(llama, "VERSION")).text()).trim()}`,
  `audio.cpp ${(await Bun.file(join(audio, "VERSION")).text()).trim()}`,
  `libsoxr ${(await Bun.file(join(soxr, "VERSION")).text()).trim()}`,
  `libopus ${(await Bun.file(join(opus, "VERSION")).text()).trim()}`,
  `sat.wasm ${(await Bun.file(join(root, "vendor", "sat-wasm", "VERSION")).text()).slice(0, 7)}`,
  `bun ${(await Bun.file(join(bun, "VERSION")).text()).trim()}`,
];
await Bun.write(join(app, "VERSION"), `${version.join("\n")}\n`);

await cp(bunPath(bun), join(appDir, "usr", "bin", "bun"));
await chmod(join(appDir, "usr", "bin", "bun"), 0o755);
await cp(join(packaging, "AppRun"), join(appDir, "AppRun"));
await chmod(join(appDir, "AppRun"), 0o755);
await cp(join(packaging, "index-translator.desktop"), join(appDir, "index-translator.desktop"));
await cp(join(packaging, "index-translator.svg"), join(appDir, "index-translator.svg"));
// The icon file managers show for the .AppImage file itself (an AppImage has no embedded icon resource).
await cp(join(root, "public", "icons", "icon-512.png"), join(appDir, ".DirIcon"));

await mkdir(work, { recursive: true });
const appimagetool = join(work, `appimagetool-${ARCH}.AppImage`);
const runtime = join(work, `runtime-${ARCH}`);
await downloadUnlessMatches(APPIMAGETOOL, appimagetool);
await chmod(appimagetool, 0o755);
await downloadUnlessMatches(RUNTIME, runtime);

await mkdir(join(root, "dist"), { recursive: true });
await rm(out, { force: true });
// AppImages are run unpacked here (--appimage-extract-and-run), which works without FUSE, as on CI runners.
await run(
  [
    appimagetool,
    "--appimage-extract-and-run",
    "--no-appstream",
    "--runtime-file",
    runtime,
    "--comp",
    "zstd",
    appDir,
    out,
  ],
  undefined,
  { ARCH, VERSION: commit },
);

// The result starts: its own Bun runs from inside it and reads the packed files.
await run([out, "--appimage-extract-and-run", "--version"]);
const megabytes = Math.round(Bun.file(out).size / 1e6);
console.log(`ok ${out} (${megabytes} MB)`);
