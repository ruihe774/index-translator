// What the fetch and packaging scripts share for pinned downloads: checksums, version stamps
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
