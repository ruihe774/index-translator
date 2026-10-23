// What is checked before the server starts, so that a machine the translator cannot run on gets one
// plain message and an exit code instead of a server that answers every request with an error:
// the engine's libraries open, a GPU with a Vulkan driver is there, the default model is downloaded.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "./config";
import type { Probe } from "./llama-probe";
import { findModel, type ModelSpec } from "./models";

type Env = Record<string, string | undefined>;

/** How the server was started, as `GET /health` says it: the page words the download advice from it. */
export function launchMode(env: Env = Bun.env): "source" | "appimage" | "windows_launcher" {
  return env.INDEX_TRANSLATOR_APPIMAGE ? "appimage" : env.INDEX_TRANSLATOR_LAUNCHER ? "windows_launcher" : "source";
}

/**
 * How to download the models `ids` (every missing one when empty), as a clause that starts in lower
 * case. From the Windows launcher (packaging/windows/launcher.c, which sets INDEX_TRANSLATOR_LAUNCHER)
 * it is its button, which cannot name models: the download skips what is installed. The AppImage's
 * start script (packaging/appimage/AppRun) names the AppImage in INDEX_TRANSLATOR_APPIMAGE; from a
 * checkout the command is the script.
 */
export function fetchAdvice(ids: readonly string[] = [], env: Env = Bun.env): string {
  const mode = launchMode(env);
  if (mode === "windows_launcher") {
    return "click Download models in the Index Translator launcher";
  }
  const command = mode === "appimage" ? `${env.INDEX_TRANSLATOR_APPIMAGE} fetch` : "bun scripts/fetch_models.ts";
  return `run ${[command, ...ids.map((id) => `--model ${id}`)].join(" ")}`;
}

/** `fetchAdvice` as a sentence. */
function fetchSentence(env: Env): string {
  const advice = fetchAdvice([], env);
  return `${advice[0]!.toUpperCase()}${advice.slice(1)}.`;
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

// Message builders: text only, no filesystem. `preflight` below decides what to say.

function noCpuBackendMessage(cfg: Config, log: string | undefined, windows: boolean): string {
  // What the libraries said about it, without their ordinary start-up lines.
  const said = (log ?? "").split("\n").filter((line) => /fail|error|cannot/i.test(line));
  const lines = said.length > 0 ? `\n${said.join("\n")}` : "";
  const runtime = windows
    ? "It needs the Microsoft Visual C++ runtime (the x64 Redistributable, https://aka.ms/vs/17/release/vc_redist.x64.exe)."
    : "It needs the OpenMP runtime, libgomp.so.1 (libgomp1 on Debian and Ubuntu, libgomp on Fedora, gcc-libs on Arch).";
  return `The translation engine's processor backend cannot be loaded from ${cfg.llamaDir}. ${runtime}${lines}`;
}

function noGpuMessage(cuda: boolean, vulkanLoader: boolean, windows: boolean): string {
  // The NVIDIA variant (scripts/build_llama.ts --cuda) has CUDA and no Vulkan.
  if (cuda) {
    return `No GPU with a CUDA driver was found. This build needs an NVIDIA GPU and its driver for CUDA 13 (version 580 or newer); "nvidia-smi" lists what is installed. ${CPU_HINT}`;
  }
  if (vulkanLoader) {
    return `No GPU with a Vulkan driver was found. Install the Vulkan driver for your graphics card (${windows ? "the current driver from AMD, Intel or NVIDIA includes it" : DRIVERS}); "vulkaninfo --summary" lists what Vulkan sees. ${CPU_HINT}`;
  }
  return windows
    ? `Vulkan is not installed: the system has no vulkan-1.dll. It comes with the graphics driver from AMD, Intel or NVIDIA; install or update it. ${CPU_HINT}`
    : `Vulkan is not installed: the system has no libvulkan.so.1. Install the Vulkan loader (libvulkan1 on Debian and Ubuntu, vulkan-loader on Fedora, vulkan-icd-loader on Arch) and the driver for your graphics card (${DRIVERS}). ${CPU_HINT}`;
}

function missingModelMessage(cfg: Config, model: ModelSpec, env: Env): string {
  return `The model ${model.id} is not in ${cfg.modelsDir} (${model.file}). ${fetchSentence(env)}`;
}

/** Why the server cannot work here, as text for the user, or `undefined` when it can. */
export function preflight(
  cfg: Config,
  probe: (llamaDir: string) => Probe = runProbe,
  env: Env = Bun.env,
  platform: string = process.platform,
): string | undefined {
  const windows = platform === "win32";
  const found = probe(cfg.llamaDir);
  if ("error" in found) {
    return `The translation engine cannot be loaded. ${found.error}`;
  }
  if (!found.cpu) {
    return noCpuBackendMessage(cfg, found.log, windows);
  }
  if (cfg.gpuLayers !== 0 && found.gpus.length === 0) {
    return noGpuMessage(existsSync(join(cfg.llamaDir, "libggml-cuda.so")), found.vulkanLoader, windows);
  }
  // loadConfig has made sure the default model is a known one.
  const model = findModel(cfg.defaultModel)!;
  return existsSync(join(cfg.modelsDir, model.file)) ? undefined : missingModelMessage(cfg, model, env);
}
