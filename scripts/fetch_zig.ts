// Fetch the Zig compiler into vendor/zig/: the toolchain of scripts/zigbuild_llamacpp.ts and
// scripts/zigbuild_audiocpp.ts, which build with it instead of the system's C and C++ compilers, so the engines come out
// the same wherever they are built. The release is downloaded from ziglang.org by version and checksum.
// Usage: bun scripts/fetch_zig.ts
//
// The zigbuild scripts use vendor/zig/zig when it is there, else the zig on the PATH, and refuse any other version.
// A directory that already holds the pinned version is left alone. Linux (x86-64, aarch64) needs tar with xz; Windows
// (x64) needs nothing (the zip is read here).

import { chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { extractTar, extractZip } from "./extract_tools";
import { download, readStamp, writeStamp } from "./fetch_tools";

export const ZIG_VERSION = "0.17.1";

/**
 * The release archive's name and SHA-256 per host (`${process.platform}-${process.arch}`), from
 * https://ziglang.org/download/index.json.
 */
const RELEASES: Record<string, { name: string; sha256: string }> = {
  "linux-x64": {
    name: `zig-x86_64-linux-${ZIG_VERSION}.tar.xz`,
    sha256: "3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a",
  },
  "linux-arm64": {
    name: `zig-aarch64-linux-${ZIG_VERSION}.tar.xz`,
    sha256: "a1546d5646eb184437918d6635ca6b762a0e889eac09cef720ee7a1ed3fe7795",
  },
  "win32-x64": {
    name: `zig-x86_64-windows-${ZIG_VERSION}.zip`,
    sha256: "b03f477a1943673e02aca0f570e8030dffd536ce1f45cbc4d3326ec31159562e",
  },
};

/** Where `vendor` keeps Zig; `zig` is in it. */
export const zigHome = (vendor: string) => join(vendor, "zig");

/** The Zig executable in `home`. */
export const zigExecutable = (home: string) => join(home, process.platform === "win32" ? "zig.exe" : "zig");

if (import.meta.main) {
  if (Bun.argv.length > 2) {
    throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
  }
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) {
    throw new Error(`no Zig is pinned for ${process.platform} on ${process.arch} yet`);
  }
  const home = zigHome(resolve(import.meta.dir, "..", "vendor"));
  if ((await readStamp(home))?.trim() === ZIG_VERSION) {
    console.log(`ok ${home} (${ZIG_VERSION}, already there)`);
    process.exit(0);
  }
  const archive = await download(`https://ziglang.org/download/${ZIG_VERSION}/${release.name}`, release.sha256);
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  if (release.name.endsWith(".zip")) {
    // The archive's one top-level directory (zig-<arch>-windows-<version>) is dropped
    await extractZip(archive, home);
    await chmod(zigExecutable(home), 0o755);
  } else {
    // The archive's one top-level directory (zig-<arch>-linux-<version>) is dropped
    await extractTar(archive, home, "xz");
  }
  await writeStamp(home, `${ZIG_VERSION}\n`);
  console.log(`ok ${home} (${ZIG_VERSION})`);
}
