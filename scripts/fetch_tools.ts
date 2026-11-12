// What the fetch and packaging scripts share for pinned downloads: checksums, version stamps, archive readers
// and "download unless the copy here is right". No imports from the project: scripts/fetch_models.ts imports
// this file and is packed into the AppImage and the installer (stage_app.ts copies both).

import { mkdir } from "node:fs/promises";
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
 * The files of a zip archive that `want` names, by their path below the archive's one top-level
 * directory. Stored and deflated entries only, no Zip64 (the archive is checked by its SHA-256
 * before, and what is not wanted is never inflated).
 */
export function unzip(zip: Uint8Array, want: (path: string) => boolean): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06_05_4b_50) {
    end--;
  }
  if (end < 0) {
    throw new Error("not a zip archive (no end of central directory)");
  }
  const text = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  let at = view.getUint32(end + 16, true);
  for (let i = view.getUint16(end + 10, true); i > 0; i--) {
    if (view.getUint32(at, true) !== 0x02_01_4b_50) {
      throw new Error("unreadable zip central directory");
    }
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = text.decode(zip.subarray(at + 46, at + 46 + nameLength));
    at = next;
    if (name.endsWith("/")) {
      continue;
    }
    const path = name.slice(name.indexOf("/") + 1);
    if (name.includes("\\") || path.split("/").some((part) => part === ".." || part === "") || !want(path)) {
      continue;
    }
    if (packed === 0xff_ff_ff_ff || size === 0xff_ff_ff_ff || view.getUint32(local, true) !== 0x04_03_4b_50) {
      throw new Error(`unreadable zip entry ${name}`);
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + packed);
    const content = method === 0 ? data : method === 8 ? Bun.inflateSync(data as Uint8Array<ArrayBuffer>) : undefined;
    if (content?.length !== size) {
      throw new Error(`zip entry ${name}: unsupported compression ${method} or wrong size`);
    }
    files.set(path, content);
  }
  return files;
}
