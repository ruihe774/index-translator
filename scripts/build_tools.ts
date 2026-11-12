// What the build scripts share: running commands, and fetching a source tree by its commit id.

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

/**
 * `command` with its program given by full path. The shell looks a command up on the PATH it started with, not of
 * `env` (`cl` is only on the latter) and not of a `process.env.PATH` changed since (Zig's directory).
 */
function resolveProgram(command: string[], env: Record<string, string | undefined> = process.env): string[] {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const program = Bun.which(command[0] ?? "", { PATH: pathKey ? env[pathKey] : undefined }) ?? command[0] ?? "";
  return [program, ...command.slice(1)];
}

/** Runs a command with its output on the terminal and throws when it fails. */
export async function run(command: string[], cwd?: string, env?: Record<string, string>): Promise<void> {
  console.log(`$ ${command.join(" ")}`);
  const merged = { ...Bun.env, ...env };
  const result = await $`${resolveProgram(command, merged)}`
    .cwd(cwd ?? process.cwd())
    .env(merged)
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit code ${result.exitCode}`);
  }
}

/** What a command prints, trimmed; empty when it fails. */
export async function output(command: string[], cwd?: string): Promise<string> {
  const result = await $`${resolveProgram(command)}`
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

/**
 * Throws, with `hint`, unless every one of `tools` is on the PATH. On Windows that is the PATH of a Developer
 * Command Prompt (`msvc()`), which has the CMake and Ninja that come with Visual Studio.
 */
export async function requireTools(tools: string[], hint: string): Promise<void> {
  const path =
    windows && tools.length > 0
      ? Object.entries((await msvc()).env).find(([key]) => key.toUpperCase() === "PATH")?.[1]
      : undefined;
  const missing = tools.filter((tool) => !Bun.which(tool, { PATH: path }));
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} not found; ${hint}`);
  }
}

export const windows = process.platform === "win32";

/** What to install when Visual Studio is missing (scripts/build_bun.ts, on Windows), for the message. */
const TOOLS_HINT =
  "on Windows: install Git, CMake (https://cmake.org/download/, add it to the PATH), Ninja (winget install Ninja-build.Ninja), and Visual Studio 2022 or later, or its Build Tools, with the 'Desktop development with C++' workload";

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
