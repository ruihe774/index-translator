// What the fetch and packaging scripts share for pinned downloads: checksums, version stamps, archive unpacking
// and "download unless the copy here is right". No imports from the project: scripts/fetch_models.ts imports
// this file and is packed into the AppImage and the installer (stage_app.ts copies both).

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The SHA-256 of `bytes`, as lowercase hex. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** The SHA-256 of the file at `path`, read as a stream (a model is gigabytes). Throws when there is no such file. */
export async function fileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

/** Whether a file is at `path` and its SHA-256 is `sha256`. */
export async function fileMatches(path: string, sha256: string): Promise<boolean> {
  return (await Bun.file(path).exists()) && (await fileSha256(path)) === sha256;
}

/** Marks a directory as holding the whole of a pinned download; written last. */
export const STAMP = "VERSION";

/** What the stamp of `dir` says, or undefined when there is none. */
export async function readStamp(dir: string): Promise<string | undefined> {
  const file = Bun.file(join(dir, STAMP));
  return (await file.exists()) ? file.text() : undefined;
}

export async function writeStamp(dir: string, text: string): Promise<void> {
  await Bun.write(join(dir, STAMP), text);
}

/** Downloads `url` and throws unless its SHA-256 is `sha256`. */
export async function download(url: string, sha256: string): Promise<Uint8Array> {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  const bytes = await res.bytes();
  const got = sha256Hex(bytes);
  if (got !== sha256) {
    throw new Error(`checksum mismatch for ${url}: want ${sha256}, got ${got}`);
  }
  return bytes;
}

/** The file at `path` as pinned: left alone when a copy with the right checksum is there, downloaded otherwise. */
export async function downloadUnlessMatches(pin: { url: string; sha256: string }, path: string): Promise<void> {
  if (await fileMatches(path, pin.sha256)) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, await download(pin.url, pin.sha256));
}

/** The `tar` that unpacks `extractTar`'s archives: bsdtar of Windows 10 1803 and later, by full path (Git's GNU tar is often first on the PATH and misreads drive-letter paths). */
const tarProgram = () =>
  process.platform === "win32" ? join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "tar.exe") : "tar";

/**
 * Unpacks a tar archive, compressed with gzip or xz, or a zip archive (Windows' bsdtar reads zip), into `dir`
 * (made if missing), dropping the archive's one top-level directory. Runs the system's `tar` (`tar.exe` on
 * Windows); `xz` needs xz-utils on Debian and Ubuntu. The archive is checked by its SHA-256 before, and tar
 * itself refuses paths that leave `dir`.
 */
export async function extractTar(archive: Uint8Array, dir: string, compression: "gz" | "xz" | "zip"): Promise<void> {
  await mkdir(dir, { recursive: true });
  // A zip is read from a file: bsdtar cannot read one reliably from a pipe (it detects the format itself)
  const zipDir = compression === "zip" ? await mkdtemp(join(tmpdir(), "extract-zip-")) : undefined;
  let exit: number;
  try {
    let args = [compression === "gz" ? "-xz" : "-xJ"];
    if (zipDir !== undefined) {
      await Bun.write(join(zipDir, "archive.zip"), archive);
      args = ["-xf", join(zipDir, "archive.zip")];
    }
    const tar = Bun.spawn([tarProgram(), ...args, "--strip-components=1", "-C", dir], {
      stdin: zipDir === undefined ? archive : "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    exit = await tar.exited;
  } finally {
    if (zipDir !== undefined) {
      await rm(zipDir, { recursive: true, force: true });
    }
  }
  if (exit !== 0) {
    throw new Error(
      `tar failed to unpack the archive into ${dir}` +
        (compression === "xz" ? "; it needs xz (on Debian and Ubuntu: sudo apt install xz-utils)" : ""),
    );
  }
}
