// What scripts/zigbuild_llamacpp.ts and scripts/zigbuild_audiocpp.ts share: the target, and CMake run with Zig as the
// toolchain (scripts/zig/zig-toolchain-<target>.cmake, so a target needs its file there).

import { cp } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

import { output, requireTools, run } from "./build_tools";
import { ZIG_VERSION, zigExecutable, zigHome } from "./fetch_zig";

/** The build targets we support, mapped from node `${process.platform}-${process.arch}`. */
const ZIG_TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-linux-gnu",
  "linux-arm64": "aarch64-linux-gnu",
  "win32-x64": "x86_64-windows-gnu",
};

/** What the builds need on the PATH besides Zig. */
const BUILD_TOOLS = ["git", "cmake", "ninja", "glslc"];

/** What to install when a build tool is missing, for the message. */
export const ZIG_TOOLS_HINT =
  process.platform === "win32"
    ? "on Windows: Git, CMake and Ninja on the PATH (a Developer Command Prompt of Visual Studio or its Build Tools has both, or: winget install Kitware.CMake Ninja-build.Ninja) and the Vulkan SDK (https://vulkan.lunarg.com/sdk/home: glslc, the headers, vulkan-1.lib, and VULKAN_SDK set); Zig: bun scripts/fetch_zig.ts"
    : "on Debian and Ubuntu: sudo apt install git cmake ninja-build glslc libvulkan-dev spirv-headers; Zig: bun scripts/fetch_zig.ts";

/**
 * Checks the tools the builds need. Zig is the one in vendor/zig (`bun scripts/fetch_zig.ts`) when there is one,
 * put first on the PATH for everything that is run here (the toolchain files and their ar and ranlib call `zig`),
 * else the system's; either must be the pinned version, so that a build does not depend on the machine's.
 */
export async function requireZigBuildTools(): Promise<void> {
  const home = zigHome(resolve(import.meta.dir, "..", "vendor"));
  if (await Bun.file(zigExecutable(home)).exists()) {
    process.env.PATH = `${home}${delimiter}${process.env.PATH ?? ""}`;
  }
  await requireTools(BUILD_TOOLS, ZIG_TOOLS_HINT);
  // (`requireTools` looks at the PATH this process started with.)
  if (!Bun.which("zig", { PATH: process.env.PATH })) {
    throw new Error(`zig not found; ${ZIG_TOOLS_HINT}`);
  }
  const version = await output(["zig", "version"]);
  if (version !== ZIG_VERSION) {
    throw new Error(`zig is ${version}, not ${ZIG_VERSION}; run: bun scripts/fetch_zig.ts`);
  }
}

const ZIG_DIR = join(import.meta.dir, "zig");

/** The target of this machine; throws when it is not one we build for. */
export function getHostTriple(): string {
  const host = `${process.platform}-${process.arch}`;
  const triple = ZIG_TARGETS[host];
  if (triple) {
    return triple;
  }
  throw new Error(`Unsupported host: ${host}`);
}

const TARGET_OPTION = "--target=";

/**
 * The command line: the options among `booleans` that are given, and the Zig target triple of `--target=<triple>`,
 * this machine's by default. Throws on anything else, and on a target without a toolchain file.
 */
export async function parseOptions(booleans: string[]): Promise<{ flags: Set<string>; triple: string }> {
  const flags = new Set<string>();
  let triple = getHostTriple();
  for (const arg of Bun.argv.slice(2)) {
    if (arg.startsWith(TARGET_OPTION)) {
      triple = arg.slice(TARGET_OPTION.length);
    } else if (booleans.includes(arg)) {
      flags.add(arg);
    } else {
      throw new Error(`unknown option ${arg}; see the head of this file`);
    }
  }
  if (!(await Bun.file(toolchainFile(triple)).exists())) {
    throw new Error(`no toolchain file for ${triple}: ${toolchainFile(triple)}`);
  }
  return { flags, triple };
}

/** Where a build for `triple` goes: the name itself for this machine's target, else with the target appended. */
export function targetDirectory(name: string, triple: string): string {
  return triple === getHostTriple() ? name : `${name}-${triple}`;
}

const toolchainFile = (triple: string) => join(ZIG_DIR, `zig-toolchain-${triple}.cmake`);

/** The CMake options saved in scripts/zig/<name>.flags, one per line. */
export async function cmakeFlags(name: string): Promise<string[]> {
  return (await Bun.file(join(ZIG_DIR, `${name}.flags`)).text()).split("\n").filter((line) => line !== "");
}

/** Configures `source` into `build` with the saved flags and the toolchain file, and builds `targets`. */
export async function cmakeBuild(
  name: string,
  triple: string,
  source: string,
  build: string,
  targets: string[] = [],
): Promise<void> {
  await run([
    "cmake",
    "-S",
    source,
    "-B",
    build,
    "-G",
    "Ninja",
    `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile(triple)}`,
    ...(await cmakeFlags(name)),
  ]);
  await run(["cmake", "--build", build, ...targets.flatMap((target) => ["--target", target])]);
}

/** A cache variable of the CMake build in `build`. */
export async function cacheValue(build: string, variable: string): Promise<string> {
  const cache = await Bun.file(join(build, "CMakeCache.txt")).text();
  const found = new RegExp(`^${variable}:[A-Z]+=(.*)$`, "m").exec(cache)?.[1];
  if (!found) {
    throw new Error(`${variable} is not set in ${build}/CMakeCache.txt`);
  }
  return found;
}

/** Zig's own library directory (`zig env`), which holds the sources of what it links into every library. */
async function zigLibDir(): Promise<string> {
  const env = await output(["zig", "env"]);
  // A ZON string: backslashes are escaped (`vendor\\zig\\lib` on Windows)
  const found = /\.lib_dir = "((?:[^"\\]|\\.)*)"/.exec(env)?.[1];
  if (!found) {
    throw new Error("zig env names no lib_dir");
  }
  return resolve(found.replaceAll(String.raw`\\`, "\\"));
}

/** The first comment of a C file: gdtoa ships its license only there. */
function leadingComment(source: string): string {
  const end = source.indexOf("*/");
  if (!source.startsWith("/*") || end === -1) {
    throw new Error("the file does not start with a comment");
  }
  return `${source.slice(0, end + 2)}\n`;
}

/**
 * Writes into `dest` the licenses of what Zig links statically into a library for `triple` and that no exception
 * covers: its compiler_rt (both systems) and libc (`zigc`, Windows), MIT, with code ported from musl (MIT); on
 * Windows the MinGW-w64 runtime (public domain in the main, and the Zope Public License 2.1 for the rest) and the
 * gdtoa conversions in it (Lucent's notice). libc++, libc++abi and libunwind are under the LLVM exception, and what
 * glibc links in under its own linking exception, so they need none. The names are THIRD_PARTY_NOTICES.md's.
 */
export async function copyRuntimeLicenses(triple: string, dest: string): Promise<void> {
  const lib = await zigLibDir();
  await cp(join(lib, "..", "LICENSE"), join(dest, "LICENSE.zig"));
  await cp(join(lib, "libc", "musl", "COPYRIGHT"), join(dest, "LICENSE.musl"));
  if (triple.includes("-windows-")) {
    const mingw = join(lib, "libc", "mingw");
    await cp(join(mingw, "COPYING"), join(dest, "LICENSE.mingw-w64"));
    await Bun.write(
      join(dest, "LICENSE.gdtoa"),
      leadingComment(await Bun.file(join(mingw, "gdtoa", "dmisc.c")).text()),
    );
  }
}
