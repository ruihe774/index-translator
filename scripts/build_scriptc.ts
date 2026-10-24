// Compile the TypeScript modules that have a profile in scriptc/ to WebAssembly: scriptc builds each
// `scriptc/<name>.json` (a library profile, with the exports of its entry module) as a reactor for wasm32-wasi
// and Zig links it, into vendor/scriptc/modules/<name>.wasm. Beside it goes <name>.inputs.json, the SHA-256 of
// every source file the build read, which is how src/scriptc-plugin.ts knows the module is not stale.
// Usage: bun scripts/build_scriptc.ts [--force] [name...]
//
// Needs the toolchain of scripts/fetch_scriptc.ts (SCRIPTC and ZIG in the environment name others). A module
// whose inputs have not changed is left alone, unless --force.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  type Inputs,
  inputsPath,
  modulePath,
  profilePath,
  readProfile,
  ROOT,
  sha256File,
  SOURCES,
  staleInputs,
  trackedInputs,
  trackedPath,
} from "../src/scriptc-runtime";
import { output, run } from "./build_tools";
import { SCRIPTC_VERSION, scriptcBin, scriptcPack, ZIG_VERSION, zigDir } from "./fetch_scriptc";

const TARGET = "wasm32-wasi";
const COMPILER = `scriptc ${SCRIPTC_VERSION}`;

/** The files a module's sources import, relative ones only, followed from `file`; `file` too. */
function sourcesOf(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) {
    return seen;
  }
  seen.add(file);
  const code = readFileSync(file, "utf8");
  const specifiers = code.matchAll(
    /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g,
  );
  for (const [, from, bare] of specifiers) {
    const specifier = from ?? bare!;
    if (!specifier.startsWith(".")) {
      continue;
    }
    const base = resolve(dirname(file), specifier);
    const found = [base, `${base}.ts`, join(base, "index.ts")].find((c) => c.endsWith(".ts") && existsSync(c));
    if (!found) {
      throw new Error(`${trackedPath(file)} imports ${specifier}, which is not a TypeScript file here`);
    }
    sourcesOf(found, seen);
  }
  return seen;
}

/** What the build of `name` reads: its profile, its entry module and what that imports. */
export function inputsOf(name: string): Inputs {
  const entry = resolve(SOURCES, readProfile(name).entry);
  const files = [profilePath(name), ...sourcesOf(entry)].map((f) => [trackedPath(f), sha256File(f)] as const);
  return {
    compiler: COMPILER,
    target: TARGET,
    files: Object.fromEntries(files.toSorted(([a], [b]) => a.localeCompare(b))),
  };
}

/** Whether the module `name` is built from exactly the sources there are now. */
export function isUpToDate(name: string): boolean {
  const built = trackedInputs(name);
  const now = inputsOf(name);
  return (
    built?.compiler === now.compiler &&
    built.target === now.target &&
    JSON.stringify(Object.keys(built.files)) === JSON.stringify(Object.keys(now.files)) &&
    staleInputs(built).length === 0
  );
}

function tools(): { scriptc: string; zig: string; env: Record<string, string> } {
  const vendor = join(ROOT, "vendor", "scriptc");
  const scriptc = process.env.SCRIPTC ?? scriptcBin(vendor);
  const zig = process.env.ZIG ?? zigDir(vendor);
  for (const [what, path] of [
    ["scriptc", scriptc],
    ["zig", join(zig, "zig")],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`${path} is missing: no ${what}; run: bun scripts/fetch_scriptc.ts`);
    }
  }
  return {
    scriptc,
    zig: join(zig, "zig"),
    env: {
      SCRIPTC_TARGET: TARGET,
      SCRIPTC_RUNTIME_PACK: process.env.SCRIPTC_RUNTIME_PACK ?? scriptcPack(vendor),
      // scriptc links with whichever `zig` it finds first.
      PATH: `${zig}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    },
  };
}

export async function buildModule(name: string): Promise<void> {
  const { scriptc, zig, env } = tools();
  const version = await output([zig, "version"]);
  if (version !== ZIG_VERSION) {
    throw new Error(
      `zig ${version} would fail to link the module: scriptc ${SCRIPTC_VERSION} needs zig ${ZIG_VERSION}`,
    );
  }
  // The inputs are read before the build, so a file changed during it shows up as stale, not as built.
  const inputs = inputsOf(name);
  await rm(inputsPath(name), { force: true });
  await mkdir(dirname(modulePath(name)), { recursive: true });
  await run(
    [scriptc, "build", "--lib", "--profile", profilePath(name), "--no-keep-llvm", "-o", modulePath(name)],
    SOURCES,
    env,
  );
  await Bun.write(inputsPath(name), `${JSON.stringify(inputs, undefined, 2)}\n`);
  console.log(
    `ok ${name}.wasm (${(Bun.file(modulePath(name)).size / 1024).toFixed(0)} KiB, ${Object.keys(inputs.files).length} inputs)`,
  );
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const force = args.includes("--force");
  const unknown = args.find((a) => a.startsWith("-") && a !== "--force");
  if (unknown) {
    throw new Error(`unknown option ${unknown}; usage: bun scripts/build_scriptc.ts [--force] [name...]`);
  }
  const names = args.filter((a) => !a.startsWith("-"));
  const all = readdirSync(SOURCES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
  for (const name of names.length > 0 ? names : all) {
    if (!all.includes(name)) {
      throw new Error(`no profile scriptc/${name}.json`);
    }
    if (!force && isUpToDate(name)) {
      console.log(`ok ${name}.wasm (up to date)`);
    } else {
      await buildModule(name);
    }
  }
}
