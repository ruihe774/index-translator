// Build the Windows launcher (packaging/windows/launcher.c) with Zig into packaging/windows/launcher.exe.
// Usage: bun scripts/zigbuild_launcher.ts
//
// `zig cc` for x86_64-windows-gnu (MinGW-w64 with the Universal CRT, like the engines), the resource file
// launcher.rc (the icon and, as resource 1 of type RT_MANIFEST, launcher.manifest: Common Controls 6 and
// Per-Monitor DPI Awareness V2) compiled by Zig's own resource compiler. The exe imports only Windows' own DLLs and
// the Universal CRT, so it needs no Visual C++ runtime. Needs Zig only (no CMake, Ninja or Visual Studio); builds
// on any host.

import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { run } from "./build_tools";
import { requireZig } from "./zigbuild_tools";

const packaging = join(resolve(import.meta.dir, ".."), "packaging", "windows");
const out = join(packaging, "launcher.exe");

await requireZig([], "Zig: bun scripts/fetch_zig.ts");

await rm(out, { force: true });
await run(
  [
    "zig",
    "cc",
    "-target",
    "x86_64-windows-gnu",
    "-O2",
    "-Wall",
    "-municode",
    "-Wl,--subsystem,windows",
    "launcher.c",
    "launcher.rc",
    "-lcomctl32",
    "-luser32",
    "-lgdi32",
    "-o",
    out,
  ],
  packaging,
);
// The linker's debug file of the exe, which nothing needs
await rm(join(packaging, "launcher.pdb"), { force: true });
console.log(`ok ${out}`);
