// What the build scripts share: running commands, and fetching a source tree by its commit id.

import { mkdir, rm } from "node:fs/promises";

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
  if (code !== 0) throw new Error(`${command[0]} failed with exit code ${code}`);
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
  if (missing.length > 0) throw new Error(`${missing.join(", ")} not found; ${hint}`);
}

/** Downloads `url` and throws unless its SHA-256 is `sha256`. */
export async function download(url: string, sha256: string): Promise<Uint8Array> {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const bytes = await res.bytes();
  const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (got !== sha256) throw new Error(`checksum mismatch for ${url}: want ${sha256}, got ${got}`);
  return bytes;
}
