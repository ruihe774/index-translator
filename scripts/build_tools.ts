// What the build scripts share: running commands, and fetching a source tree by its commit id.

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs a command with its output on the terminal and throws when it fails. */
export async function run(command: string[], cwd?: string, env?: Record<string, string>): Promise<void> {
  console.log(`$ ${command.join(" ")}`);
  const child = Bun.spawn(command, {
    cwd,
    env: { ...Bun.env, ...env },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${command[0]} failed with exit code ${code}`);
  }
}

/** What a command prints, trimmed; empty when it fails. */
export async function output(command: string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  return (await child.exited) === 0 ? text.trim() : "";
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

/** Downloads `url` and throws unless its SHA-256 is `sha256`. */
export async function download(url: string, sha256: string): Promise<Uint8Array> {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  const bytes = await res.bytes();
  const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (got !== sha256) {
    throw new Error(`checksum mismatch for ${url}: want ${sha256}, got ${got}`);
  }
  return bytes;
}

export const windows = process.platform === "win32";

/** What to install when a build tool is missing, for the message. */
export const TOOLS_HINT = windows
  ? "on Windows: install Git, CMake (https://cmake.org/download/, add it to the PATH), Visual Studio 2022 or its Build Tools with the 'Desktop development with C++' workload, and the Vulkan SDK (https://vulkan.lunarg.com/sdk/home, for glslc)"
  : "on Debian and Ubuntu: sudo apt install build-essential git cmake ninja-build glslc libvulkan-dev spirv-headers";

/** The C and C++ compilers' names on the PATH. On Windows `cl` comes from `msvc()`, not from the PATH. */
export const COMPILERS = windows ? [] : ["cc", "c++"];

export interface Msvc {
  /** The environment of a Developer Command Prompt for x64: `cl`, `link`, the Windows SDK's headers and libraries. */
  env: Record<string, string>;
  /** CMake's generator name for this Visual Studio. */
  generator: string;
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
    const major = Number.parseInt(await query("installationVersion"), 10);
    const years: Record<number, string> = { 16: "2019", 17: "2022", 18: "2026" };
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
    return { env, generator: `Visual Studio ${major} ${years[major] ?? ""}`.trim() };
  })();
  return msvcCache;
}
