// Pack the app into a Windows installer: dist/Index_Translator-Setup-x86_64.exe (Inno Setup).
// It holds Bun, the web app, both engines as they are in ./vendor (llama.dll with its backends and
// llama-shim.dll, audiocpp.dll), soxr.dll, opus.dll and launcher.exe (packaging/windows/launcher.c), laid out as in a
// checkout, since the launcher finds the program by walking up to src\server.ts and takes `bun`
// from the directory it runs in. Installs per user, no administrator rights. The models and the
// voices are not packed; the launcher's "Download models" runs scripts\fetch_models.ts (needs curl,
// part of Windows 10 and later).
// Usage: bun scripts/build_installer.ts
//
// Before it: bun scripts/build_llama.ts && bun scripts/build_audiocpp.ts && bun scripts/build_soxr.ts &&
// bun scripts/build_libopus.ts (the Opus encoder), and bun scripts/fetch_web_libs.ts (the web app's PDF and Word
// libraries), bun scripts/fetch_turndown.ts (web pages as Markdown) and
// bun scripts/fetch_onnxruntime.ts (onnxruntime.dll, for sentence segmentation). The Bun that is packed is
// the one running this script. Needs Visual Studio's C++ tools (for the launcher) and Inno Setup;
// without Inno Setup the script downloads the pinned installer and installs it for the current user.

import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { libraryPath as audioLibrary } from "../src/audiocpp-ffi";
import { soxrLibraryPath } from "../src/ffi-util";
import { libraryPath as llamaLibrary, shimPath } from "../src/llama-ffi";
import { opusLibraryPath } from "../src/opus-ffi";
import { output, run } from "./build_tools";
import { downloadUnlessMatches } from "./fetch_tools";
import { copyEngine, requireAllVendored, root, stageApp } from "./stage_app";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("the installer is built on, and for, x86-64 Windows");
}
if (Bun.argv.length > 2) {
  throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
}

const INNO = {
  url: "https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe",
  sha256: "9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732",
};

const packaging = join(root, "packaging", "windows");
const llama = join(root, "vendor", "llama.cpp");
const audio = join(root, "vendor", "audio.cpp");
const soxr = join(root, "vendor", "soxr");
const opus = join(root, "vendor", "opus");
const work = join(root, "vendor", ".build", "installer");
const stage = join(work, "stage");
const dist = join(root, "dist");

for (const [file, script] of [
  [llamaLibrary(llama), "build_llama.ts"],
  [shimPath(llama), "build_llama.ts"],
  [audioLibrary(audio), "build_audiocpp.ts"],
  [soxrLibraryPath(soxr), "build_soxr.ts"],
  [opusLibraryPath(opus), "build_libopus.ts"],
] as const) {
  if (!(await Bun.file(file).exists())) {
    throw new Error(`${file} is missing; run: bun scripts/${script}`);
  }
}
await requireAllVendored();

/** ISCC.exe: on the PATH, in the usual places, or from the pinned installer. */
async function iscc(): Promise<string> {
  const places = [
    Bun.which("ISCC"),
    join(Bun.env["ProgramFiles(x86)"] ?? "", "Inno Setup 6", "ISCC.exe"),
    join(Bun.env.ProgramFiles ?? "", "Inno Setup 6", "ISCC.exe"),
    join(Bun.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
  ];
  for (const place of places) {
    if (place && (await Bun.file(place).exists())) {
      return place;
    }
  }
  const setup = join(work, "innosetup.exe");
  await downloadUnlessMatches(INNO, setup);
  await run([setup, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER"]);
  const installed = places[3]!;
  if (!(await Bun.file(installed).exists())) {
    throw new Error("Inno Setup was installed but ISCC.exe was not found");
  }
  return installed;
}

// The launcher, rebuilt when its source or manifest is newer.
const launcher = join(packaging, "launcher.exe");
const built = (await Bun.file(launcher).exists()) ? Bun.file(launcher).lastModified : 0;
if (
  Math.max(
    Bun.file(join(packaging, "launcher.c")).lastModified,
    Bun.file(join(packaging, "launcher.manifest")).lastModified,
    Bun.file(join(packaging, "launcher.rc")).lastModified,
    Bun.file(join(packaging, "launcher.ico")).lastModified,
  ) > built
) {
  await run(["cmd.exe", "/c", join(packaging, "build.bat")]);
}

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await stageApp(stage);
await copyEngine(llama, join(stage, "vendor", "llama.cpp"));
await copyEngine(audio, join(stage, "vendor", "audio.cpp"));
await copyEngine(soxr, join(stage, "vendor", "soxr"));
await copyEngine(opus, join(stage, "vendor", "opus"));
await cp(launcher, join(stage, "launcher.exe"));
await cp(process.execPath, join(stage, "bun.exe"));

const commit = (await output(["git", "describe", "--tags", "--always", "--dirty"], root)) || "unknown";
const version = [
  `index-translator ${commit}`,
  `llama.cpp ${(await Bun.file(join(llama, "VERSION")).text()).trim()}`,
  `audio.cpp ${(await Bun.file(join(audio, "VERSION")).text()).trim()}`,
  `libsoxr ${(await Bun.file(join(soxr, "VERSION")).text()).trim()}`,
  `libopus ${(await Bun.file(join(opus, "VERSION")).text()).trim()}`,
  `onnxruntime ${(await Bun.file(join(root, "vendor", "onnxruntime", "VERSION")).text()).split(" ")[0]}`,
  `bun ${Bun.version}`,
];
await Bun.write(join(stage, "VERSION"), `${version.join("\n")}\n`);

await mkdir(dist, { recursive: true });
const out = join(dist, "Index_Translator-Setup-x86_64.exe");
await rm(out, { force: true });
await run([
  await iscc(),
  "/Qp",
  `/DStage=${stage}`,
  `/DVersion=${commit}`,
  `/DOutDir=${dist}`,
  join(packaging, "installer.iss"),
]);

// The packed Bun starts and reads the packed files.
await run([
  join(stage, "bun.exe"),
  `--config=${join(stage, "bunfig.toml")}`,
  "--disallow-code-generation-from-strings=strict",
  join(stage, "src", "server.ts"),
  "--help",
]);
const megabytes = Math.round(Bun.file(out).size / 1e6);
console.log(`ok ${out} (${megabytes} MB)`);
