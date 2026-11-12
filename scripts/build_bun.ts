// Build the Bun that the AppImage and the installer pack, from the pinned commit plus
// scripts/patches/bun-minimal.patch, into ./vendor/bun (bun, or bun.exe on Windows).
// Usage: bun scripts/build_bun.ts [--keep]
//
//   --keep  keep the source and the build tree in vendor/.build/bun, and reuse them (an unchanged tree rebuilds in
//           seconds, a cold one takes an hour or more)
//
// The patch adds Bun's `release-minimal` build profile: a release build without what the server never runs, the
// type checker, linter and formatter (`bun check`, `bun lint`, `bun fmt` and `--check`; about 24 MB) and the bundled
// sqlite3 (bun:sqlite opens the system's library instead). Everything the server uses is kept: Bun.serve, bun:ffi,
// workers, Bun.WebView, Bun.Image, Bun.Transpiler, HTMLRewriter, WebCrypto, Intl. The development tools (`lint:ts`,
// `bun test`) still need Bun canary, not this build.
//
// Needs what Bun's own build needs (https://bun.com/docs/project/contributing): Bun to run the build scripts, git,
// cmake, ninja, LLVM 23.1 (clang, lld), Rust through rustup (it installs the pinned nightly), Perl, and on x86-64
// NASM. On Windows (https://bun.com/docs/project/building-windows) also Visual Studio 2022 or later with the "Desktop
// development with C++" workload, LLVM 23.1 in C:\Program Files\LLVM (`choco install llvm --version=23.1.3`) and
// NASM on the PATH; Strawberry Perl's MinGW tools (C:\Strawberry\c\bin) must not be on it. WebKit comes prebuilt; it and the build caches go to ~/.bun/build-cache
// (BUN_BUILD_CACHE_DIR). Building needs no administrator rights.
//
// On Linux it is linked, as Bun's releases are, against Ubuntu 20.04's glibc and gcc-13's libstdc++
// (glibc_sysroot.ts; also needs tar, dpkg-deb and objdump), so it runs on glibc 2.31 and later whatever the build
// machine's glibc; the build fails otherwise. The patch also turns off Bun's `--wrap` list, which pins what glibc 2.31
// has above 2.17 down to 2.17 (its own shims of exp, getrandom, statx, ...): 2.31 is old enough.

import { existsSync } from "node:fs";
import { cp, mkdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { $ } from "bun";

import { checkout, msvc, output, requireTools, run, windows } from "./build_tools";
import { glibcSysroot } from "./glibc_sysroot";

/** Bun 1.4.4 as it is on main at this commit; the patch is written against it. */
const VERSION = "1.4.4";
const COMMIT = "38afee6c84fcf48c0edb2466aa4b27d287a59c30";
const REPO = "https://github.com/oven-sh/bun.git";
const PATCH = join(import.meta.dir, "patches", "bun-minimal.patch");

const flags = new Set(Bun.argv.slice(2));
for (const flag of flags) {
  if (flag !== "--keep") {
    throw new Error(`unknown option ${flag}; see the head of this file`);
  }
}
const keep = flags.has("--keep");

const root = resolve(import.meta.dir, "..");
const dest = join(root, "vendor", "bun");
const work = join(root, "vendor", ".build", "bun");
const source = join(work, "src");
// Inside the checkout: Bun's build finds its repository by walking up from the build directory.
const build = join(source, "build", "release-minimal");
const exe = windows ? "bun.exe" : "bun";
const linux = process.platform === "linux";
const sysroot = join(work, "glibc-sysroot");
/** The newest glibc symbol version Bun may need: the sysroot's. build_appimage.ts holds every packed binary to it. */
export const MAX_GLIBC = "2.31";

/** The packed Bun in `dir` (vendor/bun): `bun`, or `bun.exe` on Windows. */
export function bunPath(dir: string): string {
  return join(dir, exe);
}

if (import.meta.main) {
  // Bun's own configure step checks the rest (LLVM's version, Rust, Perl, NASM, ...) and says what is missing.
  await requireTools(
    linux ? ["git", "tar", "dpkg-deb", "objdump"] : ["git"],
    "install git (and on Linux tar, dpkg and binutils)",
  );
  // On Windows the build runs in the environment of a Developer Command Prompt, as Bun's scripts/vs-shell.ps1 sets up.
  const buildEnv = windows ? (await msvc()).env : undefined;

  if (!keep) {
    await rm(work, { recursive: true, force: true });
  }
  await checkout(REPO, COMMIT, source);
  // A tree kept by --keep has the patch already.
  const reverse = await $`git apply --reverse --check --ignore-whitespace ${PATCH}`.cwd(source).quiet().nothrow();
  if (reverse.exitCode !== 0) {
    await run(["git", "apply", "--ignore-whitespace", PATCH], source);
  }

  if (linux) {
    await glibcSysroot(sysroot, join(work, "downloads"));
  }

  const started = performance.now();
  // Bun's build installs its own build tools' packages (esbuild and the like) with the running Bun.
  await run(
    [
      process.execPath,
      "scripts/build.ts",
      "--profile=release-minimal",
      `--build-dir=${build}`,
      ...(linux ? [`--linux-sysroot=${sysroot}`] : []),
    ],
    source,
    buildEnv,
  ).catch((e: unknown) => {
    console.error("the build failed; is a tool missing? See the head of this file");
    throw e;
  });
  const built = join(build, exe);
  if (!existsSync(built)) {
    throw new Error(`the build left no ${built}`);
  }

  if (linux) {
    await checkGlibc(built);
  }

  // Built before the existing copy is replaced.
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(built, bunPath(dest));
  await cp(join(source, "LICENSE.md"), join(dest, "LICENSE.md"));
  await Bun.write(join(dest, "VERSION"), `${VERSION} ${COMMIT.slice(0, 10)} minimal\n`);
  if (!keep) {
    await rm(work, { recursive: true, force: true });
    // Gone too, unless another build keeps its tree there.
    await rmdir(join(root, "vendor", ".build")).catch(() => {});
  }

  // Runs it, so a binary that does not start is found here.
  const revision = await output([bunPath(dest), "--revision"]);
  if (!revision.startsWith(VERSION)) {
    throw new Error(`${bunPath(dest)} --revision printed "${revision}", not ${VERSION}`);
  }
  // And has what the server uses.
  await run([bunPath(dest), join(import.meta.dir, "check_bun.ts")]);
  const seconds = Math.round((performance.now() - started) / 1000);
  const megabytes = Math.round(Bun.file(bunPath(dest)).size / 1e6);
  console.log(`ok ${dest} (bun ${revision}, ${megabytes} MB, built in ${seconds} s)`);
}

/**
 * Throws when `file` needs a glibc symbol newer than `MAX_GLIBC`: for Bun, that the sysroot was not used; for the
 * libraries, a Zig default target newer than it. Needs objdump.
 */
export async function checkGlibc(file: string): Promise<void> {
  const symbols = await $`objdump -T ${file}`.text();
  const newer = [...new Set(symbols.match(/GLIBC_\d+(\.\d+)+/g))].filter(
    (version) => Bun.semver.order(`${version.slice(6)}.0`.split(".").slice(0, 3).join("."), `${MAX_GLIBC}.0`) > 0,
  );
  if (newer.length > 0) {
    throw new Error(`${file} needs ${newer.sort().join(", ")}; at most GLIBC_${MAX_GLIBC} was expected`);
  }
}
