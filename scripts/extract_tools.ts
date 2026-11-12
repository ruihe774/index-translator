// Unpacking the archives the fetch scripts download: tar with the system's tar, zip with @stdx/zip, a
// development dependency. Not in fetch_tools.ts, which is packed without node_modules (stage_app.ts) for `fetch`.
// @stdx/zip is imported by `extractZip` alone, so the scripts that only unpack tar archives run before `bun install`.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The `tar` that unpacks `extractTar`'s archives: bsdtar of Windows 10 1803 and later, by full path (Git's GNU tar is often first on the PATH and misreads drive-letter paths). */
const tarProgram = () =>
  process.platform === "win32" ? join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "tar.exe") : "tar";

/**
 * Unpacks a tar archive, compressed with gzip or xz, into `dir` (made if missing), dropping the archive's
 * one top-level directory. Runs the system's `tar` (`tar.exe` on Windows); `xz` needs xz-utils on Debian
 * and Ubuntu. The archive is checked by its SHA-256 before, and tar itself refuses paths that leave `dir`.
 */
export async function extractTar(archive: Uint8Array, dir: string, compression: "gz" | "xz"): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tar = Bun.spawn([tarProgram(), compression === "gz" ? "-xz" : "-xJ", "--strip-components=1", "-C", dir], {
    stdin: archive,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await tar.exited) !== 0) {
    throw new Error(
      `tar failed to unpack the archive into ${dir}` +
        (compression === "xz" ? "; it needs xz (on Debian and Ubuntu: sudo apt install xz-utils)" : ""),
    );
  }
}

/**
 * Unpacks a zip archive into `dir` (made if missing), dropping the archive's one top-level directory.
 * Stored and deflated entries only, no Zip64; entries are checked against their CRC-32. Throws on a path
 * that leaves `dir` and on a symbolic link.
 */
export async function extractZip(archive: Uint8Array, dir: string): Promise<void> {
  const { unzip } = await import("@stdx/zip").catch((e: unknown) => {
    throw new Error("@stdx/zip is not installed; run: bun install", { cause: e });
  });
  const files = new Map<string, Uint8Array>();
  for (const entry of await unzip(archive)) {
    if (entry.isDirectory) {
      continue;
    }
    const path = entry.path.slice(entry.path.indexOf("/") + 1);
    if (entry.path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`refusing path ${entry.path}`);
    }
    if (entry.mode !== undefined && (entry.mode & 0o17_0000) === 0o12_0000) {
      throw new Error(`refusing symbolic link ${entry.path}`);
    }
    files.set(path, entry.data);
  }
  for (const [path, data] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await Bun.write(join(dir, path), data);
  }
}
