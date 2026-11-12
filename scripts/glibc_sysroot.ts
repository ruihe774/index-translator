// The glibc and libstdc++ that the minimal Bun is linked against on Linux, as Bun's own CI does
// (scripts/build/ci-images/spec.ts `glibcSysroot` in Bun's tree): ubuntu:20.04's root filesystem (glibc 2.31),
// focal's libc headers, and gcc-13's libstdc++ (the environment WebKit's prebuilt is built in). Linked against the
// host's glibc, the binary needs that glibc (2.38 from Ubuntu 24.04's C23 headers: `__isoc23_strtol` and the like);
// against this one, 2.31. (Bun's releases go on to 2.17 with a `--wrap` list in scripts/build/flags.ts, which
// bun-minimal.patch turns off.)
// The pins are Bun's, at the commit build_bun.ts builds; the base image is cdimage's tarball of the same release.

import { mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { $ } from "bun";

import { run } from "./build_tools";
import { downloadUnlessMatches, readStamp, writeStamp } from "./fetch_tools";

type Arch = "x64" | "arm64";
interface Pin {
  url: string;
  sha256: string;
}

const ARCHES = {
  x64: { deb: "amd64", triple: "x86_64-linux-gnu", mirror: "https://archive.ubuntu.com/ubuntu" },
  arm64: { deb: "arm64", triple: "aarch64-linux-gnu", mirror: "https://ports.ubuntu.com/ubuntu-ports" },
} as const;

/** ubuntu:20.04's root filesystem; the sums are cdimage's SHA256SUMS. */
const BASE: Record<Arch, Pin> = {
  x64: {
    url: "https://cdimage.ubuntu.com/ubuntu-base/releases/20.04/release/ubuntu-base-20.04.5-base-amd64.tar.gz",
    sha256: "60e216b60947653dc8989be3821380268315b99b2959c29882781541bfe5a426",
  },
  arm64: {
    url: "https://cdimage.ubuntu.com/ubuntu-base/releases/20.04/release/ubuntu-base-20.04.5-base-arm64.tar.gz",
    sha256: "f9b999afb4c4b10193087ea8c11be36d688f19e609b05179b571f29357954b52",
  },
};

/** libc's runtime and headers, at the newest versions of focal-updates and focal (Bun's pins). */
const DEBS: { directory: string; name: string; version: string; sha256: Record<Arch, string> }[] = [
  {
    directory: "g/glibc",
    name: "libc6",
    version: "2.31-0ubuntu9.18",
    sha256: {
      x64: "1b2281aac4935dfea1f89dfc19e445fdbb45303202af60679ccb8bf035f081a0",
      arm64: "4ff60d84ad78f3aa598297dc6966549fa6489f57599f197562ad91547f388da0",
    },
  },
  {
    directory: "g/glibc",
    name: "libc6-dev",
    version: "2.31-0ubuntu9.18",
    sha256: {
      x64: "11029900f2315b93ce487792ae1bf15f0927e5e50880c091e6a440b14d4e164a",
      arm64: "a690787a4ed5ad1bb9ce6aebe0bef3300e483e7ed97d11a6af3cdb107e642292",
    },
  },
  {
    directory: "l/linux",
    name: "linux-libc-dev",
    version: "5.4.0-216.236",
    sha256: {
      x64: "70c9addd36aabd2d031d5ea0fc444f8b193027aef79ff3d8275d25800aed8ede",
      arm64: "9f487e7f3a9fff7f42f67172e139fd23c11b30e9b70bf6ae5a2e90b099547990",
    },
  },
  {
    directory: "libx/libxcrypt",
    name: "libcrypt1",
    version: "4.4.10-10ubuntu4",
    sha256: {
      x64: "231b4dbbe5865775f118cfa61394f1e16fa7102b6953a327e672499a20876d73",
      arm64: "89907b6c1b613c430a53ef10909934b9ce5854a396cd173360495f6f8e5e7ea4",
    },
  },
  {
    directory: "libx/libxcrypt",
    name: "libcrypt-dev",
    version: "4.4.10-10ubuntu4",
    sha256: {
      x64: "f0a41d8e8cf379dbbdfc43169f34851ed452b3581e72c6654f2e290caf4e1b20",
      arm64: "3cbd65247c73ec78e15e9364d3f15643591fe25849382251c77a49204f083e68",
    },
  },
];

/** gcc-13's .debs for focal (Bun's mirror of the ubuntu-toolchain-r PPA); the sums are GitHub's. */
const GCC: Record<Arch, Pin> = {
  x64: {
    url: "https://github.com/oven-sh/WebKit/releases/download/gcc-13-focal-debs/gcc-13-focal-amd64.tar.gz",
    sha256: "a2b3b6e10b175bbaaefeb3e9e703ca26a97ed6c1f19ca842d3e0b0c8f941e65b",
  },
  arm64: {
    url: "https://github.com/oven-sh/WebKit/releases/download/gcc-13-focal-debs/gcc-13-focal-arm64.tar.gz",
    sha256: "be19db90d94c52c6061280bbadcaad9b09db1e9f2e77a12f8c18c5425d2eb056",
  },
};

/**
 * Makes `dir` the sysroot for this machine's architecture, downloading into `downloads`. A sysroot already made from
 * the same pins is reused. Needs tar and dpkg-deb.
 */
export async function glibcSysroot(dir: string, downloads: string): Promise<void> {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`no glibc sysroot for ${process.arch}`);
  }
  const arch: Arch = process.arch;
  const { deb, triple, mirror } = ARCHES[arch];
  const debs = DEBS.map((d) => ({
    url: `${mirror}/pool/main/${d.directory}/${d.name}_${d.version}_${deb}.deb`,
    sha256: d.sha256[arch],
  }));
  const stamp = [BASE[arch], ...debs, GCC[arch]].map((pin) => pin.sha256).join("\n");
  if ((await readStamp(dir)) === stamp) {
    console.log(`reusing the glibc sysroot in ${dir}`);
    return;
  }
  await rm(dir, { recursive: true, force: true });

  const base = join(downloads, "ubuntu-base.tar.gz");
  await downloadUnlessMatches(BASE[arch], base);
  await mkdir(dir, { recursive: true });
  await run(["tar", "-xzf", base, "-C", dir]);

  for (const [i, pin] of debs.entries()) {
    const file = join(downloads, `${DEBS[i]!.name}.deb`);
    await downloadUnlessMatches(pin, file);
    await run(["dpkg-deb", "-x", file, dir]);
  }

  const gcc = join(downloads, "gcc-13.tar.gz");
  const gccDebs = join(downloads, "gcc-13");
  await downloadUnlessMatches(GCC[arch], gcc);
  await rm(gccDebs, { recursive: true, force: true });
  await mkdir(gccDebs, { recursive: true });
  await run(["tar", "-xzf", gcc, "-C", gccDebs]);
  for (const name of (await readdir(gccDebs)).filter((n) => n.endsWith(".deb")).sort()) {
    await run(["dpkg-deb", "-x", join(gccDebs, name), dir]);
  }
  await rm(gccDebs, { recursive: true, force: true });
  // Unpacked by a user, the image's closed directories would stay closed to `rm`.
  await run(["chmod", "-R", "u+rwX", dir]);

  // Absolute symlinks point at the host; keep them inside the sysroot. `find` does not follow them (a recursive
  // `readdir` does, into the host's /run).
  for (const link of (await $`find ${dir} -type l -lname ${"/*"}`.text()).split("\n").filter(Boolean)) {
    const target = await readlink(link);
    await rm(link);
    await symlink(join(dir, target), link);
  }
  // libc.so is a linker script that names /lib/<triple>/ (libc6 unpacks there: the image's /lib -> usr/lib becomes a
  // directory) and the loader in /lib64.
  if (!(await Bun.file(join(dir, "lib", triple, "libc.so.6")).exists())) {
    throw new Error(`the sysroot in ${dir} has no lib/${triple}/libc.so.6`);
  }
  if (arch === "x64" && !(await Bun.file(join(dir, "lib64", "ld-linux-x86-64.so.2")).exists())) {
    throw new Error(`the sysroot in ${dir} has no lib64/ld-linux-x86-64.so.2`);
  }

  await writeStamp(dir, stamp);
}
