// Uploads kept in anonymous files: created in a temporary directory and unlinked at once, so only the
// open descriptor reaches the data, and the system frees it when the descriptor is closed or the process
// ends, a crash included (an engine can take the process down). A descriptor belongs to the process, so
// the speech worker reads what the server thread wrote. POSIX only: Windows does not unlink an open file
// the same way, and is not handled yet.

import { fstatSync, readSync } from "node:fs";
import { type FileHandle, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AnonymousFile {
  /** What `readAnonymousFile` reads, on any thread, until `close`. */
  readonly fd: number;
  close(): Promise<void>;
}

// eslint-disable-next-line bun/no-literal-temp-dir -- deliberately not os.tmpdir(), which is /tmp: the disk-backed one
const DISK_TEMP = "/var/tmp";

/**
 * Where the files go, in order of preference: `TMPDIR` when it is set, /var/tmp, which is on disk where
 * /tmp is often a tmpfs in RAM (Fedora, Arch) that a queue of large uploads would fill, and the system's
 * temporary directory. The files have no name, so that /var/tmp outlives a reboot does not matter.
 */
function directories(): string[] {
  return [...new Set([process.env.TMPDIR, DISK_TEMP, tmpdir()].filter((d): d is string => !!d))];
}

/** A new anonymous file in `dir` holding `bytes`; rejects when it cannot be made or written there. */
async function writeIn(dir: string, bytes: Uint8Array): Promise<FileHandle> {
  const path = join(dir, `index-translator-${crypto.randomUUID()}`);
  // The handle is kept referenced until `close`: a collected FileHandle would close the descriptor.
  const handle = await open(path, "wx+", 0o600);
  try {
    await unlink(path);
    await handle.writeFile(bytes);
  } catch (e) {
    await handle.close();
    throw e;
  }
  return handle;
}

/** Files written and not closed; tests count them. */
const live = new Set<FileHandle>();

/** How many anonymous files are open. */
export const openAnonymousFiles = (): number => live.size;

/**
 * Writes `bytes` to a new anonymous file, in the first of `directories()` where that works: one that
 * is missing, read-only, not ours to write or full is passed over. When none works, rejects with the
 * error of the first.
 */
export async function anonymousFile(bytes: Uint8Array): Promise<AnonymousFile> {
  let handle: FileHandle | undefined;
  let first: unknown;
  for (const dir of directories()) {
    try {
      handle = await writeIn(dir, bytes);
      break;
    } catch (e) {
      first ??= e;
    }
  }
  if (!handle) {
    throw first;
  }
  live.add(handle);
  let closed = false;
  return {
    fd: handle.fd,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      live.delete(handle);
      await handle.close();
    },
  };
}

/** The whole content of an anonymous file, read from its start whatever its position. Blocks. */
export function readAnonymousFile(fd: number): Uint8Array<ArrayBuffer> {
  const bytes = Bun.allocUnsafe(fstatSync(fd).size);
  for (let at = 0; at < bytes.length;) {
    const n = readSync(fd, bytes, at, bytes.length - at, at);
    if (n === 0) {
      throw new Error("the file ended before its size");
    }
    at += n;
  }
  return bytes;
}
