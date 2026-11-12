import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Probe } from "../src/llama-probe";
import { MODELS } from "../src/models";
import { fetchAdvice, launchMode, preflight, runProbe } from "../src/preflight";
import { config, tempDir } from "./helpers/mock-engine";

const GPU: Probe = { gpus: ["Vulkan0: Some GPU"], cpu: true, vulkanLoader: true };
const NO_GPU: Probe = { gpus: [], cpu: true, vulkanLoader: true };

let dir = "";
let withModel = "";

beforeAll(async () => {
  dir = tempDir("preflight-");
  withModel = join(dir, "models");
  mkdirSync(withModel);
  await Bun.write(join(withModel, MODELS[0]!.file), "");
});

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

  test("on Windows the messages name the driver and vulkan-1.dll", () => {
    const cfg = config({ modelsDir: withModel });
    expect(preflight(cfg, () => NO_GPU, {}, "win32")).toContain("AMD, Intel or NVIDIA");
    expect(preflight(cfg, () => ({ ...NO_GPU, vulkanLoader: false }), {}, "win32")).toContain("vulkan-1.dll");
  });

  test("GPU_LAYERS=0 needs no GPU", () => {
    expect(preflight(config({ modelsDir: withModel, gpuLayers: 0 }), () => NO_GPU)).toBeUndefined();
    expect(
      preflight(config({ modelsDir: withModel, gpuLayers: 0 }), () => ({ ...NO_GPU, vulkanLoader: false })),
    ).toBeUndefined();
  });

  test("no CPU backend is a problem even with a GPU, with what the libraries said about it", () => {
    const log = "load_backend: loaded Vulkan backend\nggml_backend_cpu: failed to initialize";
    const problem = preflight(config({ modelsDir: withModel }), () => ({ ...GPU, cpu: false, log }), {}, "linux");
    expect(problem).toBe(
      `The translation engine's processor backend cannot be loaded from ${config().llamaDir}.\nggml_backend_cpu: failed to initialize`,
    );
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
      error: `libllama not found in ${join(dir, "empty")}; run: bun scripts/zigbuild_llamacpp.ts`,
    });
  });
});
