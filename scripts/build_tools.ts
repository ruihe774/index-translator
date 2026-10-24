// What the build scripts share: running commands, and fetching a source tree by its commit id.

import { cp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { $ } from "bun";

/** Runs a command with its output on the terminal and throws when it fails. */
export async function run(command: string[], cwd?: string, env?: Record<string, string>): Promise<void> {
  console.log(`$ ${command.join(" ")}`);
  const merged = { ...Bun.env, ...env };
  // The shell looks a command up on the PATH of this process, not of `env` (`cl` is only on the latter).
  const pathKey = Object.keys(merged).find((key) => key.toUpperCase() === "PATH");
  const program = Bun.which(command[0] ?? "", { PATH: pathKey ? merged[pathKey] : undefined }) ?? command[0] ?? "";
  const result = await $`${[program, ...command.slice(1)]}`
    .cwd(cwd ?? process.cwd())
    .env(merged)
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit code ${result.exitCode}`);
  }
}

/** What a command prints, trimmed; empty when it fails. */
export async function output(command: string[], cwd?: string): Promise<string> {
  const result = await $`${command}`
    .cwd(cwd ?? process.cwd())
    .quiet()
    .nothrow();
  return result.exitCode === 0 ? result.text().trim() : "";
}

/** Makes `dir` a checkout of exactly `commit`, fetching nothing else of the repository's history. */
export async function checkout(repo: string, commit: string, dir: string): Promise<void> {
  if ((await output(["git", "rev-parse", "HEAD"], dir).catch(() => "")) === commit) {
    console.log(`reusing the source in ${dir}`);
    return;
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await run(["git", "init", "--quiet"], dir);
  await run(["git", "fetch", "--quiet", "--depth", "1", repo, commit], dir);
  await run(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"], dir);
}

/** Throws, with `hint`, unless every one of `tools` is on the PATH. */
export function requireTools(tools: string[], hint: string): void {
  const missing = tools.filter((tool) => !Bun.which(tool));
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} not found; ${hint}`);
  }
}

export const windows = process.platform === "win32";

/** What to install when a build tool is missing, for the message. */
export const TOOLS_HINT = windows
  ? "on Windows: install Git, CMake (https://cmake.org/download/, add it to the PATH), Ninja (winget install Ninja-build.Ninja), Visual Studio 2022 or later, or its Build Tools, with the 'Desktop development with C++' workload, and the Vulkan SDK (https://vulkan.lunarg.com/sdk/home, for glslc)"
  : "on Debian and Ubuntu: sudo apt install build-essential git cmake ninja-build glslc libvulkan-dev spirv-headers";

/** The build tools every engine needs on the PATH, on both systems. */
export const BUILD_TOOLS = ["git", "cmake", "ninja"];

/** The C and C++ compilers' names on the PATH. On Windows `cl` comes from `msvc()`, not from the PATH. */
export const COMPILERS = windows ? [] : ["cc", "c++"];

/** The CUDA runtime libraries a CUDA build needs beside it; the driver's `libcuda.so.1` is the system's. */
const CUDA_RUNTIME = ["libcudart.so.13", "libcublas.so.13", "libcublasLt.so.13"];

/** cuFFT, which audio.cpp needs and llama.cpp does not. */
export const CUDA_FFT = "libcufft.so.12";

/** What to install when the CUDA toolkit is missing, for the message. */
const CUDA_HINT =
  "install the CUDA 13 toolkit (on Debian and Ubuntu from NVIDIA's apt repository: cuda-nvcc-13-1 cuda-cudart-dev-13-1 libcublas-dev-13-1 libcufft-dev-13-1 cuda-driver-dev-13-1) and set CUDA_PATH if it is not in /usr/local/cuda-13";

interface Cuda {
  /** The toolkit's directory (the one with bin/nvcc). */
  root: string;
  nvcc: string;
  /** Full version, e.g. "13.1.115". */
  version: string;
  /** The directory holding its shared libraries. */
  libs: string;
}

/**
 * The GPU architectures of a CUDA build without `--cuda-arch=`: PTX for Turing (the floor of CUDA 13) and for
 * Ampere, which the driver compiles on the first run (cached after that) for newer GPUs. Measured on a Blackwell
 * GB10: the first run takes about 20 s longer, then prompt processing is 5% and generation 5% slower than a native
 * build (38% and 11% from Turing's PTX alone). llama.cpp's own list (seven architectures) takes four times as long
 * to build and makes the library three times as large.
 */
export const DEFAULT_CUDA_ARCH = "75-virtual;86-virtual";

/** The option that names the GPU architectures of a CUDA build (`--cuda-arch=native`); `DEFAULT_CUDA_ARCH` when absent. */
export const CUDA_ARCH_OPTION = "--cuda-arch=";

/** The value of `--cuda-arch=` among `flags`, if given. */
export function cudaArch(flags: Iterable<string>): string | undefined {
  for (const flag of flags) {
    if (flag.startsWith(CUDA_ARCH_OPTION)) {
      return flag.slice(CUDA_ARCH_OPTION.length) || undefined;
    }
  }
  return undefined;
}

/** Finds the CUDA 13 toolkit: `CUDA_PATH`, `CUDA_HOME`, `/usr/local/cuda-13`, `/usr/local/cuda`; throws when none is. */
export async function findCuda(): Promise<Cuda> {
  if (process.platform !== "linux") {
    throw new Error("CUDA builds are made for Linux only");
  }
  const candidates = [Bun.env.CUDA_PATH, Bun.env.CUDA_HOME, "/usr/local/cuda-13", "/usr/local/cuda"].filter(Boolean);
  const triples: Record<string, string> = { x64: "x86_64-linux", arm64: "sbsa-linux" };
  const triple = triples[process.arch];
  for (const root of candidates as string[]) {
    const nvcc = join(root, "bin", "nvcc");
    if (!(await Bun.file(nvcc).exists())) {
      continue;
    }
    const text = await output([nvcc, "--version"]);
    const found = /release 13\.\d+, V(13\.\d+\.\d+)/.exec(text);
    if (!found) {
      console.log(`skipping ${root}: not CUDA 13 (${text.split("\n").at(-1) ?? "no version"})`);
      continue;
    }
    for (const libs of [join(root, "lib64"), ...(triple ? [join(root, "targets", triple, "lib")] : [])]) {
      if (await Bun.file(join(libs, CUDA_RUNTIME[0]!)).exists()) {
        return { root, nvcc, version: found[1]!, libs };
      }
    }
  }
  throw new Error(`the CUDA 13 toolkit was not found; ${CUDA_HINT}`);
}

/** The CMake options that make a build use `cuda` and nothing else of CUDA's defaults, for the architectures `arch` (`DEFAULT_CUDA_ARCH` when undefined). */
export function cudaCMakeOptions(cuda: Cuda, arch: string | undefined): string[] {
  return [
    `-DCMAKE_CUDA_COMPILER=${cuda.nvcc}`,
    `-DCUDAToolkit_ROOT=${cuda.root}`,
    `-DCMAKE_CUDA_ARCHITECTURES=${arch ?? DEFAULT_CUDA_ARCH}`,
  ];
}

/**
 * Copies the CUDA runtime libraries (cudart, cuBLAS, and `extra` such as cuFFT) into `dir`, where the engine's libraries find them
 * through their `$ORIGIN` run path, with the toolkit's license, and checks that nothing but the driver
 * is missing for `libraries`.
 */
export async function bundleCuda(cuda: Cuda, dir: string, libraries: string[], extra: string[] = []): Promise<void> {
  for (const soname of [...CUDA_RUNTIME, ...extra]) {
    const real = await realpath(join(cuda.libs, soname));
    await cp(real, join(dir, basename(real)));
    if (basename(real) !== soname) {
      await symlink(basename(real), join(dir, soname));
    }
  }
  await cp(join(cuda.root, "EULA.txt"), join(dir, "LICENSE.cuda"));
  for (const library of libraries) {
    // A clean environment: the check is what a user's system would find.
    const listing = await output(["env", "-u", "LD_LIBRARY_PATH", "ldd", join(dir, library)]);
    const missing = listing.split("\n").filter((line) => line.includes("not found") && !line.includes("libcuda.so.1"));
    if (missing.length > 0) {
      throw new Error(`${library} needs libraries that are not bundled:\n${missing.join("\n")}`);
    }
  }
}

interface Msvc {
  /** The environment of a Developer Command Prompt for x64: `cl`, `link`, the Windows SDK's headers and libraries. */
  env: Record<string, string>;
}

let msvcCache: Promise<Msvc> | undefined;

/** Finds Visual Studio with its C++ tools (vswhere) and reads the environment its vcvars64.bat sets up. */
export function msvc(): Promise<Msvc> {
  msvcCache ??= (async () => {
    const programs = Bun.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
    const vswhere = join(programs, "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const query = (property: string) =>
      output([
        vswhere,
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        property,
      ]);
    const path = await query("installationPath");
    if (!path) {
      throw new Error(`Visual Studio with the C++ tools (x64) not found; ${TOOLS_HINT}`);
    }
    const bat = join(path, "VC", "Auxiliary", "Build", "vcvars64.bat");
    // A batch file, because the quotes around the path would not survive being a command-line argument.
    const script = join(tmpdir(), `msvc-env-${process.pid}.bat`);
    await Bun.write(
      script,
      `@call "${bat}" >nul
@set
`,
    );
    const text = await output(["cmd", "/d", "/c", script]).finally(() => void rm(script, { force: true }));
    if (!text) {
      throw new Error(`${bat} did not set up the build environment`);
    }
    const env: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        env[line.slice(0, eq)] = line.slice(eq + 1);
      }
    }
    return { env };
  })();
  return msvcCache;
}
