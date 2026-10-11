// What is checked before the server starts, so that a machine the translator cannot run on gets one
// plain message and an exit code instead of a server that answers every request with an error:
// the engine's libraries open, a GPU with a Vulkan driver is there, the default model is downloaded.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import type { Probe } from "./llama-probe";
import { findModel } from "./models";

type Env = Record<string, string | undefined>;

/**
 * The command that downloads the models. The AppImage's start script (packaging/appimage/AppRun)
 * names the AppImage in INDEX_TRANSLATOR_APPIMAGE; from a checkout it is the script.
 */
export function fetchCommand(env: Env = Bun.env): string {
  return env.INDEX_TRANSLATOR_APPIMAGE ? `${env.INDEX_TRANSLATOR_APPIMAGE} fetch` : "bun scripts/fetch_models.ts";
}

const DRIVERS =
  "for AMD and Intel: mesa-vulkan-drivers on Debian, Ubuntu and Fedora, vulkan-radeon or vulkan-intel on Arch; for NVIDIA: its own driver";
const CPU_HINT = "To run on the processor instead, which is much slower, set GPU_LAYERS=0.";

const lastLines = (text: string, n: number) => text.trim().split("\n").slice(-n).join("\n");

/** Runs src/llama-probe.ts and returns what it printed; a probe that died is an `error`. */
export function runProbe(llamaDir: string): Probe {
  const child = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "llama-probe.ts"), llamaDir], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const log = lastLines(child.stderr.toString(), 8);
  if (child.exitCode === 0) {
    try {
      const probe = JSON.parse(child.stdout.toString()) as Probe;
      return "error" in probe ? probe : { ...probe, log };
    } catch {
      // Falls through: a probe that printed something else did not work.
    }
  }
  const how = child.signalCode ? `was ended by ${child.signalCode}` : `ended with exit code ${child.exitCode}`;
  return { error: `Its check ${how}, which points at the graphics driver.${log ? `\n${log}` : ""}` };
}

/** Why the server cannot work here, as text for the user, or `undefined` when it can. */
export function preflight(
  cfg: Config,
  probe: (llamaDir: string) => Probe = runProbe,
  env: Env = Bun.env,
): string | undefined {
  const found = probe(cfg.llamaDir);
  if ("error" in found) return `The translation engine cannot be loaded. ${found.error}`;

  if (!found.cpu) {
    // What the libraries said about it, without their ordinary start-up lines.
    const said = (found.log ?? "").split("\n").filter((line) => /fail|error|cannot/i.test(line));
    const log = said.length > 0 ? `\n${said.join("\n")}` : "";
    return `The translation engine's processor backend cannot be loaded from ${cfg.llamaDir}. It needs the OpenMP runtime, libgomp.so.1 (libgomp1 on Debian and Ubuntu, libgomp on Fedora, gcc-libs on Arch).${log}`;
  }
  if (cfg.gpuLayers !== 0 && found.gpus.length === 0) {
    return found.vulkanLoader
      ? `No GPU with a Vulkan driver was found. Install the Vulkan driver for your graphics card (${DRIVERS}); "vulkaninfo --summary" lists what Vulkan sees. ${CPU_HINT}`
      : `Vulkan is not installed: the system has no libvulkan.so.1. Install the Vulkan loader (libvulkan1 on Debian and Ubuntu, vulkan-loader on Fedora, vulkan-icd-loader on Arch) and the driver for your graphics card (${DRIVERS}). ${CPU_HINT}`;
  }

  // loadConfig has made sure the default model is a known one.
  const model = findModel(cfg.defaultModel)!;
  if (!existsSync(join(cfg.modelsDir, model.file))) {
    return `The model ${model.id} is not in ${cfg.modelsDir} (${model.file}). Download the models with: ${fetchCommand(env)}`;
  }
  return undefined;
}
