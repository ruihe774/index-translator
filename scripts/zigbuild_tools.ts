// What scripts/zigbuild_llamacpp.ts and scripts/zigbuild_audiocpp.ts share: the target, and CMake run with Zig as the
// toolchain (scripts/zig/zig-toolchain-<target>.cmake, so a target needs its file there).

import { join } from "node:path";

import { run } from "./build_tools";

/** The build targets we support, mapped from node `${process.platform}-${process.arch}`. */
const ZIG_TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-linux-gnu",
  "linux-arm64": "aarch64-linux-gnu",
};

/** What the builds need on the PATH. */
export const ZIG_BUILD_TOOLS = ["git", "cmake", "ninja", "zig", "glslc"];

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
