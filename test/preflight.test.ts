import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Probe } from "../src/llama-probe";
import { MODELS } from "../src/models";
import { fetchAdvice, launchMode, preflight, runProbe } from "../src/preflight";
import { config } from "./helpers/mock-engine";

const GPU: Probe = { gpus: ["Vulkan0: Some GPU"], cpu: true, vulkanLoader: true };
const NO_GPU: Probe = { gpus: [], cpu: true, vulkanLoader: true };

let dir = "";
let withModel = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "preflight-"));
  withModel = join(dir, "models");
  mkdirSync(withModel);
  await Bun.write(join(withModel, MODELS[0]!.file), "");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("preflight", () => {
  test("a GPU, a CPU backend and the default model: nothing to report", () => {
    expect(preflight(config({ modelsDir: withModel }), () => GPU)).toBeUndefined();
  });

  test("the probe is asked about LLAMA_DIR", () => {
    const asked: string[] = [];
    preflight(config({ modelsDir: withModel, llamaDir: "/opt/llama" }), (llamaDir) => {
      asked.push(llamaDir);
      return GPU;
    });
    expect(asked).toStrictEqual(["/opt/llama"]);
  });

  test("no Vulkan device is a problem that names the driver and the way out", () => {
    const problem = preflight(config({ modelsDir: withModel }), () => NO_GPU, {}, "linux");
    expect(problem).toContain("No GPU with a Vulkan driver was found");
    expect(problem).toContain("mesa-vulkan-drivers");
    expect(problem).toContain("GPU_LAYERS=0");
  });

  test("an engine built for CUDA names the NVIDIA driver, not Vulkan", async () => {
    const cuda = join(dir, "llama-cuda");
    await Bun.write(join(cuda, "libggml-cuda.so"), "");
    const noLoader = { ...NO_GPU, vulkanLoader: false };
    const problem = preflight(config({ modelsDir: withModel, llamaDir: cuda }), () => noLoader, {}, "linux");
    expect(problem).toContain("No GPU with a CUDA driver was found");
    expect(problem).toContain("580");
    expect(problem).toContain("GPU_LAYERS=0");
    expect(problem).not.toContain("Vulkan");
  });

  test("a system without the Vulkan loader is told to install that", () => {
    const problem = preflight(
      config({ modelsDir: withModel }),
      () => ({ ...NO_GPU, vulkanLoader: false }),
      {},
      "linux",
    );
    expect(problem).toContain("libvulkan.so.1");
    expect(problem).toContain("libvulkan1");
    expect(problem).toContain("GPU_LAYERS=0");
  });

  test("on Windows the messages name the driver, vulkan-1.dll and the Visual C++ runtime", () => {
    const cfg = config({ modelsDir: withModel });
    expect(preflight(cfg, () => NO_GPU, {}, "win32")).toContain("AMD, Intel or NVIDIA");
    expect(preflight(cfg, () => ({ ...NO_GPU, vulkanLoader: false }), {}, "win32")).toContain("vulkan-1.dll");
    expect(preflight(cfg, () => ({ ...GPU, cpu: false }), {}, "win32")).toContain("Visual C++");
  });

  test("GPU_LAYERS=0 needs no GPU", () => {
    expect(preflight(config({ modelsDir: withModel, gpuLayers: 0 }), () => NO_GPU)).toBeUndefined();
    expect(
      preflight(config({ modelsDir: withModel, gpuLayers: 0 }), () => ({ ...NO_GPU, vulkanLoader: false })),
    ).toBeUndefined();
  });

  test("no CPU backend is a problem even with a GPU, with what the libraries said about it", () => {
    const log = "load_backend: loaded Vulkan backend\nload_backend: failed to load x.so: libgomp.so.1: cannot open";
    const problem = preflight(config({ modelsDir: withModel }), () => ({ ...GPU, cpu: false, log }), {}, "linux");
    expect(problem).toContain("processor backend cannot be loaded");
    expect(problem).toContain("libgomp1");
    expect(problem).toContain("failed to load x.so");
    expect(problem).not.toContain("loaded Vulkan backend");
  });

  test("libraries that cannot be opened are reported with the reason", () => {
    const problem = preflight(config({ modelsDir: withModel }), () => ({ error: "version `GLIBC_2.38' not found" }));
    expect(problem).toBe("The translation engine cannot be loaded. version `GLIBC_2.38' not found");
  });

  test("a missing default model points at the download command, of the AppImage when run from one", () => {
    const cfg = config({ modelsDir: join(dir, "empty") });
    const problem = preflight(cfg, () => GPU, {});
    expect(problem).toContain(`The model ${MODELS[0]!.id} is not in ${join(dir, "empty")}`);
    expect(problem).toEndWith("Run bun scripts/fetch_models.ts.");
    const packaged = preflight(cfg, () => GPU, { INDEX_TRANSLATOR_APPIMAGE: "/home/u/Index_Translator.AppImage" });
    expect(packaged).toEndWith("Run /home/u/Index_Translator.AppImage fetch.");
    const launcher = preflight(cfg, () => GPU, { INDEX_TRANSLATOR_LAUNCHER: "1" });
    expect(launcher).toEndWith("Click Download models in the Index Translator launcher.");
  });

  test("the hardware is checked before the model, so nobody downloads 17 GiB for a machine that cannot run it", () => {
    expect(preflight(config({ modelsDir: join(dir, "empty") }), () => NO_GPU)).toContain("No GPU");
  });
});

describe("launchMode and fetchAdvice", () => {
  test("the script from a checkout, the subcommand from the AppImage", () => {
    expect(fetchAdvice([], {})).toBe("run bun scripts/fetch_models.ts");
    expect(fetchAdvice([], { INDEX_TRANSLATOR_APPIMAGE: "/a/b.AppImage" })).toBe("run /a/b.AppImage fetch");
  });

  test("the AppImage and the Windows launcher mark their environment; anything else is a checkout", () => {
    expect(launchMode({})).toBe("source");
    expect(launchMode({ INDEX_TRANSLATOR_APPIMAGE: "/a/b.AppImage" })).toBe("appimage");
    expect(launchMode({ INDEX_TRANSLATOR_LAUNCHER: "1" })).toBe("windows_launcher");
    expect(fetchAdvice(["labse"], {})).toBe("run bun scripts/fetch_models.ts --model labse");
    expect(fetchAdvice(["labse"], { INDEX_TRANSLATOR_LAUNCHER: "1" })).toStartWith("click Download models");
  });
});

describe("runProbe", () => {
  test("a directory without the engine is an error with the build hint, from a process of its own", () => {
    const probe = runProbe(join(dir, "empty"));
    expect(probe).toStrictEqual({
      error: `libllama and its shim not found in ${join(dir, "empty")}; run: bun scripts/build_llama.ts`,
    });
  });
});
