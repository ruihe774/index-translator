// What build_appimage.ts and build_installer.ts pack alike: the repository's own layout, so the code finds its
// files the way it does in a checkout. A new top-level directory or file the server reads is added here, once.
// What differs (the engines of a variant, Bun, the start script or launcher) stays with the two scripts.

import { cp, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { requireMinicelt } from "./fetch_minicelt";
import { requireOnnxruntime } from "./fetch_onnxruntime";
import { requireTurndown } from "./fetch_turndown";
import { requireWebLibs } from "./fetch_web_libs";

export const root = resolve(import.meta.dir, "..");

/**
 * Throws, naming the script to run, unless the libraries that are fetched and not built are in place. The web
 * app's are packed with public/ (without them PDF and Word files would not open and speech would be sent as WAV),
 * then the Opus encoder of the speech stream, the Markdown converter of fetched web pages and ONNX Runtime
 * (without which there is no sentence segmentation).
 */
export async function requireAllVendored(): Promise<void> {
  await requireWebLibs(join(root, "public", "vendor"));
  await requireMinicelt(join(root, "vendor"));
  await requireTurndown(join(root, "vendor"));
  await requireOnnxruntime(join(root, "vendor"));
}

/** Copies an engine's directory as it is, links included: the libraries and licenses, not the headers or import libraries. */
export async function copyEngine(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (name !== "include" && !name.endsWith(".lib") && !name.endsWith(".exp")) {
      await cp(join(from, name), join(to, name), { verbatimSymlinks: true });
    }
  }
}

/** Lays out `destDir` with everything the server reads except the engines (llama.cpp, audio.cpp, libsoxr) and Bun. */
export async function stageApp(destDir: string): Promise<void> {
  for (const name of await readdir(join(root, "src"))) {
    if (name.endsWith(".ts")) {
      await cp(join(root, "src", name), join(destDir, "src", name));
    }
  }
  // What src/webpage.ts runs inside a fetched page.
  await cp(join(root, "src", "page", "extract.ts"), join(destDir, "src", "page", "extract.ts"));
  await cp(join(root, "public"), join(destDir, "public"), { recursive: true });
  await cp(join(root, "prompts"), join(destDir, "prompts"), { recursive: true });
  await cp(join(root, "docs", "openapi.yaml"), join(destDir, "docs", "openapi.yaml"));
  await cp(join(root, "THIRD_PARTY_NOTICES.md"), join(destDir, "THIRD_PARTY_NOTICES.md"));
  // `fetch` (AppRun, the launcher's "Download models"), with what it imports besides src/.
  for (const name of ["fetch_models.ts", "fetch_tools.ts"]) {
    await cp(join(root, "scripts", name), join(destDir, "scripts", name));
  }
  await cp(join(root, "packaging", "bunfig.toml"), join(destDir, "bunfig.toml"));
  await Bun.write(join(destDir, "package.json"), `${JSON.stringify({ name: "index-translator", type: "module" })}\n`);
  await copyEngine(join(root, "vendor", "onnxruntime"), join(destDir, "vendor", "onnxruntime"));
  await cp(join(root, "vendor", "minicelt"), join(destDir, "vendor", "minicelt"), { recursive: true });
  await cp(join(root, "vendor", "turndown"), join(destDir, "vendor", "turndown"), { recursive: true });
}
