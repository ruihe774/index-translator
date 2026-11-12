// Fetch the Zig compiler into vendor/zig/: the toolchain of scripts/zigbuild_llamacpp.ts and
// scripts/zigbuild_audiocpp.ts, which build with it instead of the system's C and C++ compilers, so the engines come out
// the same wherever they are built. The release is downloaded from ziglang.org by version and checksum.
// Usage: bun scripts/fetch_zig.ts
//
// The zigbuild scripts use vendor/zig/zig when it is there, else the zig on the PATH, and refuse any other version.
// A directory that already holds the pinned version is left alone. Needs Bun and tar with xz (Linux only so far).

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { download, readStamp, writeStamp } from "./fetch_tools";

export const ZIG_VERSION = "0.17.1";

/** The release archive's SHA-256 per host (`process.arch` names the key), from https://ziglang.org/download/index.json. */
const ARCHES = {
  x64: { name: "x86_64", sha256: "3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a" },
  arm64: { name: "aarch64", sha256: "a1546d5646eb184437918d6635ca6b762a0e889eac09cef720ee7a1ed3fe7795" },
} as const;

/** Where `vendor` keeps Zig; `zig` is in it. */
export const zigHome = (vendor: string) => join(vendor, "zig");

if (import.meta.main) {
  if (Bun.argv.length > 2) {
    throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
  }
  const arch = process.platform === "linux" ? ARCHES[process.arch as keyof typeof ARCHES] : undefined;
  if (!arch) {
    throw new Error(`no Zig is pinned for ${process.platform} on ${process.arch} yet`);
  }
  const home = zigHome(resolve(import.meta.dir, "..", "vendor"));
  if ((await readStamp(home))?.trim() === ZIG_VERSION) {
    console.log(`ok ${home} (${ZIG_VERSION}, already there)`);
    process.exit(0);
  }
  const archive = await download(
    `https://ziglang.org/download/${ZIG_VERSION}/zig-${arch.name}-linux-${ZIG_VERSION}.tar.xz`,
    arch.sha256,
  );
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  // The archive's one top-level directory (zig-<arch>-linux-<version>) is dropped
  const tar = Bun.spawn(["tar", "-xJ", "--strip-components=1", "-C", home], {
    stdin: archive,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await tar.exited) !== 0) {
    throw new Error(
      "tar failed to unpack the Zig archive; it needs xz (on Debian and Ubuntu: sudo apt install xz-utils)",
    );
  }
  await writeStamp(home, `${ZIG_VERSION}\n`);
  console.log(`ok ${home} (${ZIG_VERSION})`);
}
