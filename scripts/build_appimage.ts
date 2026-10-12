// Pack the app into one file that runs on other Linux machines: dist/Index_Translator-<arch>.AppImage (x86_64 or aarch64, as the machine),
// with Bun, the web app and both engines as they are in ./vendor (libllama with its backends and
// the prebuilt shim, libaudiocpp). The models and the voices are not packed; the AppImage's `fetch`
// subcommand (scripts/fetch_models.ts) downloads them into the user's data directory.
// Usage: bun scripts/build_appimage.ts
//
// Before it: bun scripts/build_llama.ts && bun scripts/build_audiocpp.ts, both without --native,
// since the engines are packed as built. The Bun that is packed is the one running this script.
// The AppImage needs what the engines were linked against, so it runs on systems at least as new
// as the one it was built on (their C and C++ libraries), with libgomp, a Vulkan driver, and curl
// for `fetch`. Layout and start script: packaging/appimage/.
//
// Needs nothing installed besides Bun and git: appimagetool and the AppImage runtime are
// downloaded, by version and checksum, into vendor/.build/appimage and kept there.

import { chmod, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { libraryPath as audioLibrary } from "../src/audiocpp-ffi";
import { libraryPath as llamaLibrary, shimPath } from "../src/llama-ffi";
import { download, output, run } from "./build_tools";

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
if (Bun.argv.length > 2) throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);

const root = resolve(import.meta.dir, "..");
const packaging = join(root, "packaging", "appimage");
const llama = join(root, "vendor", "llama.cpp");
const audio = join(root, "vendor", "audio.cpp");
const work = join(root, "vendor", ".build", "appimage");
const appDir = join(work, "AppDir");
const app = join(appDir, "usr", "share", "index-translator");
const out = join(root, "dist", NAME);

for (const [file, script] of [
  [llamaLibrary(llama), "build_llama.ts"],
  [shimPath(llama), "build_llama.ts"],
  [audioLibrary(audio), "build_audiocpp.ts"],
] as const) {
  if (!(await Bun.file(file).exists())) throw new Error(`${file} is missing; run: bun scripts/${script}`);
}

/** The file at `path` as pinned, downloaded unless a copy with the right checksum is already there. */
async function tool(pin: { url: string; sha256: string }, path: string): Promise<void> {
  const file = Bun.file(path);
  if (await file.exists()) {
    if (new Bun.CryptoHasher("sha256").update(await file.bytes()).digest("hex") === pin.sha256) return;
  }
  await Bun.write(path, await download(pin.url, pin.sha256));
}

/** Copies an engine's directory as it is, links included, without the headers. */
async function copyEngine(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (name !== "include") await cp(join(from, name), join(to, name), { verbatimSymlinks: true });
  }
}

await rm(appDir, { recursive: true, force: true });
await mkdir(join(appDir, "usr", "bin"), { recursive: true });
await mkdir(app, { recursive: true });

// The repository's own layout under usr/share/index-translator, so the code finds its files
// (public/, prompts/, docs/openapi.yaml, vendor/) the way it does in a checkout.
for (const name of await readdir(join(root, "src"))) {
  if (name.endsWith(".ts")) await cp(join(root, "src", name), join(app, "src", name));
}
await cp(join(root, "public"), join(app, "public"), { recursive: true });
await cp(join(root, "prompts"), join(app, "prompts"), { recursive: true });
await cp(join(root, "docs", "openapi.yaml"), join(app, "docs", "openapi.yaml"));
await cp(join(root, "THIRD_PARTY_NOTICES.md"), join(app, "THIRD_PARTY_NOTICES.md"));
await cp(join(root, "scripts", "fetch_models.ts"), join(app, "scripts", "fetch_models.ts"));
await Bun.write(join(app, "package.json"), `${JSON.stringify({ name: "index-translator", type: "module" })}\n`);
await copyEngine(llama, join(app, "vendor", "llama.cpp"));
await copyEngine(audio, join(app, "vendor", "audio.cpp"));

const commit = (await output(["git", "describe", "--tags", "--always", "--dirty"], root)) || "unknown";
const version = [
  `index-translator ${commit}`,
  `llama.cpp ${(await Bun.file(join(llama, "VERSION")).text()).trim()}`,
  `audio.cpp ${(await Bun.file(join(audio, "VERSION")).text()).trim()}`,
  `bun ${Bun.version}`,
];
await Bun.write(join(app, "VERSION"), `${version.join("\n")}\n`);

await cp(process.execPath, join(appDir, "usr", "bin", "bun"), { dereference: true });
await chmod(join(appDir, "usr", "bin", "bun"), 0o755);
await cp(join(packaging, "AppRun"), join(appDir, "AppRun"));
await chmod(join(appDir, "AppRun"), 0o755);
await cp(join(packaging, "index-translator.desktop"), join(appDir, "index-translator.desktop"));
await cp(join(packaging, "index-translator.svg"), join(appDir, "index-translator.svg"));

await mkdir(work, { recursive: true });
const appimagetool = join(work, `appimagetool-${ARCH}.AppImage`);
const runtime = join(work, `runtime-${ARCH}`);
await tool(APPIMAGETOOL, appimagetool);
await chmod(appimagetool, 0o755);
await tool(RUNTIME, runtime);

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
const megabytes = Math.round((await stat(out)).size / 1e6);
console.log(`ok ${out} (${megabytes} MB)`);
