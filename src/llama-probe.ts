// Run as a process of its own by src/preflight.ts: bun src/llama-probe.ts <LLAMA_DIR>
// Opens the engine's libraries the way the engine thread will, and prints one JSON line (`Probe`):
// what they can compute on, or why they could not be opened. A library that is missing on the
// system, or a graphics driver that crashes while it is asked for its devices, ends this process
// and not the server.

import { dlopen } from "bun:ffi";
import { devices } from "./llama-ffi";

export type Probe =
  | {
      /** "name: description" of every GPU a model can be offloaded to. */
      gpus: string[];
      /** False when no CPU backend could be loaded; the engine needs one even with a GPU. */
      cpu: boolean;
      /** False when the system has no libvulkan.so.1, which every Vulkan program needs. */
      vulkanLoader: boolean;
      /** The last lines the libraries logged, which say why a backend was not loaded. */
      log?: string;
    }
  | { error: string };

function probe(dir: string): Probe {
  let vulkanLoader = true;
  try {
    // bun:ffi opens nothing without a symbol to look up; this one is in every version of the loader.
    dlopen("libvulkan.so.1", { vkCreateInstance: { args: ["ptr", "ptr", "ptr"], returns: "i32" } }).close();
  } catch {
    vulkanLoader = false;
  }
  try {
    const found = devices(dir);
    return {
      gpus: found.filter((d) => d.type === "gpu" || d.type === "igpu").map((d) => d.label),
      cpu: found.some((d) => d.type === "cpu"),
      vulkanLoader,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

if (import.meta.main) console.log(JSON.stringify(probe(Bun.argv[2] ?? "")));
