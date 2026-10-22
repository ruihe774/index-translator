// Fetch ONNX Runtime into vendor/onnxruntime/: Microsoft's official release build (CPU execution
// provider only), the library the server runs the sentence segmentation model (SaT, see
// fetch_models.ts) with, through its C API with bun:ffi (src/onnxruntime-ffi.ts); without it
// `POST /segment` is unavailable. One archive per platform, downloaded by version and checksum; of it only the
// shared library, the licenses and the C API header are kept (the header is for rechecking the slot
// numbers when the version changes; the packages leave it out). Nothing is built or run.
// Usage: bun scripts/fetch_onnxruntime.ts
//
// A directory that already holds the pinned version is left alone. Needs nothing besides Bun.
//
// For whoever changes the version (VERSION, the checksums, the library names):
// - The C API is one struct of function pointers (`OrtApi`), reached with
//   `OrtGetApiBase()->GetApi(ORT_API_VERSION)`. It is append-only: a slot's index never changes
//   between versions, and a library answers a request for any version up to its own, so a binding
//   written for an older ORT_API_VERSION keeps working. Still, the bindings (`SLOT` in
//   src/onnxruntime-ffi.ts) count slots by hand, so after a bump recheck each index against
//   `include/onnxruntime_c_api.h` here, and `ORT_API_VERSION` there.
// - Execution providers other than the CPU's are not used: `libonnxruntime_providers_shared` (which the
//   library loads only for them) is not kept. The Windows archive's .lib and .pdb files are not
//   kept either (the .pdb is 400 MB).
// - On Windows `onnxruntime.dll` imports the Visual C++ runtime (VCRUNTIME140, VCRUNTIME140_1,
//   MSVCP140, MSVCP140_1: the x64 Redistributable that the engines need too, which the installer
//   installs on a machine without it, WINDOWS.md) and the Universal CRT. Recheck the imports after
//   a bump. Windows 10 and later have its own copy of onnxruntime.dll in System32 for Windows ML;
//   open ours by full path, never by name.
// - The Linux library needs glibc and libstdc++ (the same as the engines), and is also published for
//   aarch64, which the AppImage is built for.

import { chmod, mkdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { download } from "./build_tools";
import { untar } from "./fetch_web_libs";

export const VERSION = "1.31.0";

interface Archive {
  url: string;
  sha256: string;
  /** The library's path in the archive's top-level directory, the name it is installed under, and its SHA-256. */
  library: { from: string; name: string; sha256: string };
  /** What else is kept, by path in the archive (the same name below `vendor/onnxruntime`). */
  keep: string[];
  /** A link to make beside the library: the SONAME, so a loader that asks for it finds this file. */
  link?: string;
}

const RELEASE = `https://github.com/microsoft/onnxruntime/releases/download/v${VERSION}`;
const NOTICES = ["LICENSE", "ThirdPartyNotices.txt", "include/onnxruntime_c_api.h"];

/** By `process.platform-process.arch`. */
const ARCHIVES: Record<string, Archive> = {
  "linux-x64": {
    url: `${RELEASE}/onnxruntime-linux-x64-${VERSION}.tgz`,
    sha256: "cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57",
    library: {
      from: `lib/libonnxruntime.so.${VERSION}`,
      name: `libonnxruntime.so.${VERSION}`,
      sha256: "469849977cb60744ea160927e1a3a0643fd4c55c0aff743251c6d293402e334e",
    },
    keep: NOTICES,
    link: "libonnxruntime.so.1",
  },
  "linux-arm64": {
    url: `${RELEASE}/onnxruntime-linux-aarch64-${VERSION}.tgz`,
    sha256: "c5b8b3cca31f3d643a3b313b8f42e2d0f16a4fcefd02cda343d97bd5306afaab",
    library: {
      from: `lib/libonnxruntime.so.${VERSION}`,
      name: `libonnxruntime.so.${VERSION}`,
      sha256: "595c7f7a6775f5c7b3d567c3ed94c04f722092575abcc092560f5208a54daf99",
    },
    keep: NOTICES,
    link: "libonnxruntime.so.1",
  },
  "win32-x64": {
    url: `${RELEASE}/onnxruntime-win-x64-${VERSION}.zip`,
    sha256: "3958d8a44984160692c1b4ffd0de3cb48f8c39f9d34bb31e433db06e30b82195",
    library: {
      from: "lib/onnxruntime.dll",
      name: "onnxruntime.dll",
      sha256: "0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c",
    },
    keep: NOTICES,
  },
};

const DIR = "onnxruntime";
/** Marks a directory as holding the whole of the pinned library; written last. */
const STAMP = "VERSION";

function archiveFor(platform: string, arch: string): Archive {
  const archive = ARCHIVES[`${platform}-${arch}`];
  if (!archive) {
    throw new Error(`there is no pinned ONNX Runtime for ${platform} ${arch}`);
  }
  return archive;
}

const sha256Of = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const stampOf = (archive: Archive) => `${VERSION} ${archive.sha256}\n`;

/** The shared library inside `dir` (`vendor/onnxruntime`) for the current platform. */
export function onnxruntimeLibraryPath(dir: string): string {
  return join(dir, archiveFor(process.platform, process.arch).library.name);
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

export async function isPresent(vendor: string, platform = process.platform, arch = process.arch): Promise<boolean> {
  const archive = archiveFor(platform, arch);
  const stamp = Bun.file(join(vendor, DIR, STAMP));
  return (
    (await stamp.exists()) &&
    (await stamp.text()) === stampOf(archive) &&
    (await Bun.file(join(vendor, DIR, archive.library.name)).exists())
  );
}

/** Downloads the archive, checks it and the library in it, and replaces `<vendor>/onnxruntime` with what is kept. */
export async function fetchOnnxruntime(vendor: string): Promise<void> {
  const archive = archiveFor(process.platform, process.arch);
  const dir = join(vendor, DIR);
  if (await isPresent(vendor)) {
    console.log(`ok ${DIR} ${VERSION} (already there)`);
    return;
  }
  const wanted = new Set([archive.library.from, ...archive.keep]);
  // Extracted in memory, so a hostile archive can only choose among the files named here.
  const bytes = await download(archive.url, archive.sha256);
  const files = archive.url.endsWith(".zip") ? unzip(bytes, (path) => wanted.has(path)) : untar(bytes, true);
  const missing = [...wanted].filter((path) => !files.has(path));
  if (missing.length > 0) {
    throw new Error(`${archive.url} has no ${missing.join(", ")}`);
  }
  const library = files.get(archive.library.from)!;
  const got = sha256Of(library);
  if (got !== archive.library.sha256) {
    throw new Error(`${archive.library.from} in ${archive.url}: SHA-256 ${got}, not ${archive.library.sha256}`);
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "include"), { recursive: true });
  let size = 0;
  for (const path of wanted) {
    const to = path === archive.library.from ? archive.library.name : path;
    await Bun.write(join(dir, to), files.get(path)!);
    size += files.get(path)!.length;
  }
  await chmod(join(dir, archive.library.name), 0o755);
  if (archive.link) {
    await symlink(archive.library.name, join(dir, archive.link));
  }
  await Bun.write(join(dir, STAMP), stampOf(archive));
  console.log(`ok ${DIR} ${VERSION} (${wanted.size} files, ${(size / 2 ** 20).toFixed(1)} MiB)`);
}

/** Throws, naming this script, unless `vendor` holds the pinned ONNX Runtime for this platform. */
export async function requireOnnxruntime(vendor: string): Promise<void> {
  if (!(await isPresent(vendor))) {
    throw new Error(`${join(vendor, DIR)} is missing or not ${VERSION}; run: bun scripts/fetch_onnxruntime.ts`);
  }
}

if (import.meta.main) {
  if (Bun.argv.length > 2) {
    throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
  }
  await fetchOnnxruntime(resolve(import.meta.dir, "..", "vendor"));
}
