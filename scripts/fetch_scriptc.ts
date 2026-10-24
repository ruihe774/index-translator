// Fetch the toolchain that compiles TypeScript modules to WebAssembly (scripts/build_scriptc.ts) into
// vendor/scriptc/: scriptc, Vercel's TypeScript compiler (https://github.com/vercel-labs/scriptc), its
// runtime for wasm32-wasi, and the Zig that links the module; each is downloaded by version and checksum.
// Usage: bun scripts/fetch_scriptc.ts
//
// Linux on x86-64 only: the compiled modules are an optional speed-up (src/scriptc-plugin.ts loads
// the TypeScript when there is none), so other platforms do without. A directory that already
// holds the pinned version is left alone. Needs `tar` and `xz` besides Bun.
//
// For whoever changes a version: scriptc and its runtime pack must be the same version, and Zig must
// be the one scriptc's release was built against (0.14 fails to link: "-half-precision"). The runtime
// pack is the npm package @scriptc/runtime-wasm32-wasi; scriptc finds it by SCRIPTC_RUNTIME_PACK.

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { download } from "./fetch_tools";

export const SCRIPTC_VERSION = "0.4.4";
export const ZIG_VERSION = "0.16.0";

interface Archive {
  dir: string;
  url: string;
  sha256: string;
  /** Leading path components `tar` drops: the archive's top-level directory, if it has one. */
  strip: number;
  /** A file that the extracted directory must have. */
  has: string;
}

export const ARCHIVES: Archive[] = [
  {
    dir: "scriptc",
    url: `https://github.com/vercel-labs/scriptc/releases/download/v${SCRIPTC_VERSION}/scriptc-${SCRIPTC_VERSION}-linux-x64-gnu.tar.gz`,
    sha256: "c66a87eab129aab6268c1a2ea72b407b47afb4c52de42fc4b77c26aa24cf5f04",
    strip: 0,
    has: "bin/scriptc",
  },
  {
    dir: "runtime-wasm32-wasi",
    url: `https://registry.npmjs.org/@scriptc/runtime-wasm32-wasi/-/runtime-wasm32-wasi-${SCRIPTC_VERSION}.tgz`,
    sha256: "6b68583d68397386cab73655da335a78801dc727d7c9c927973640a3ca230477",
    strip: 1,
    has: "runtime-pack.json",
  },
  {
    dir: "zig",
    url: `https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz`,
    sha256: "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
    strip: 1,
    has: "zig",
  },
];

/** The tools by path, below `vendor/scriptc`. */
export const scriptcBin = (root: string) => join(root, "scriptc", "bin", "scriptc");
export const scriptcPack = (root: string) => join(root, "runtime-wasm32-wasi");
export const zigDir = (root: string) => join(root, "zig");

const stampOf = (archive: Archive) => `${archive.url} ${archive.sha256}\n`;

/** Beside the directory, not in it: Zig's own archive has a VERSION file. Written last. */
const stampFile = (archive: Archive, root: string) => Bun.file(join(root, `${archive.dir}.stamp`));

async function isPresent(archive: Archive, root: string): Promise<boolean> {
  const stamp = stampFile(archive, root);
  return (
    (await stamp.exists()) &&
    (await stamp.text()) === stampOf(archive) &&
    (await Bun.file(join(root, archive.dir, archive.has)).exists())
  );
}

export function supported(platform = process.platform, arch = process.arch): boolean {
  return platform === "linux" && arch === "x64";
}

/** Downloads each archive and replaces `<vendor>/scriptc/<dir>` with what it holds. */
export async function fetchScriptc(vendor: string): Promise<void> {
  if (!supported()) {
    throw new Error(
      `the scriptc toolchain is pinned for Linux on x86-64 only, not ${process.platform} ${process.arch}`,
    );
  }
  const root = join(vendor, "scriptc");
  for (const archive of ARCHIVES) {
    const dir = join(root, archive.dir);
    if (await isPresent(archive, root)) {
      console.log(`ok ${archive.dir} (already there)`);
      continue;
    }
    await rm(stampFile(archive, root).name!, { force: true });
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const file = join(root, `${archive.dir}.download`);
    await Bun.write(file, await download(archive.url, archive.sha256));
    const tar = Bun.spawn(["tar", "-xf", file, "-C", dir, `--strip-components=${archive.strip}`], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await tar.exited;
    await rm(file, { force: true });
    if (code !== 0) {
      throw new Error(`tar failed (exit code ${code}) on ${archive.url}`);
    }
    if (!(await Bun.file(join(dir, archive.has)).exists())) {
      throw new Error(`${archive.url} has no ${archive.has}`);
    }
    await Bun.write(stampFile(archive, root), stampOf(archive));
    console.log(`ok ${archive.dir}`);
  }
}

if (import.meta.main) {
  if (Bun.argv.length > 2) {
    throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
  }
  await fetchScriptc(resolve(import.meta.dir, "..", "vendor"));
}
