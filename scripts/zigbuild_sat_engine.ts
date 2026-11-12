// Build the SaT forward pass (src/sat-engine.zig) with Zig into ./vendor/sat.
// Usage: bun scripts/zigbuild_sat_engine.ts [--target=<triple>]
//
//   --target  the Zig target to build for (scripts/zig/zig-toolchain-<triple>.cmake must exist); this machine's by
//             default, into vendor/sat, else into vendor/sat-<triple>, which is not opened here
//
// One source file and one `zig build-lib` command line (zigBuildSatEngine), so there is no build.zig and no CMake. The library exports
// only the `sat_*` functions of the file (src/sat-ffi.ts binds them). Needs Zig only, on any host.

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { satEngineVersion } from "../src/sat-ffi";
import {
  getHostTriple,
  parseOptions,
  requireZig,
  targetDirectory,
  windowsTarget,
  zigBuildSatEngine,
} from "./zigbuild_tools";

const { triple } = await parseOptions([]);
const root = resolve(import.meta.dir, "..");
const source = join(root, "src", "sat-engine.zig");
const dest = join(root, "vendor", targetDirectory("sat", triple));

await requireZig([], "Zig: bun scripts/fetch_zig.ts");

const file = windowsTarget(triple) ? "sat.dll" : triple.includes("-macos") ? "libsat.dylib" : "libsat.so";
const started = performance.now();
// Built before the existing copy is replaced.
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await zigBuildSatEngine(triple, source, join(dest, file));
const hash = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(source).bytes())
  .digest("hex")
  .slice(0, 12);
await Bun.write(join(dest, "VERSION"), `${hash}\n`);

const seconds = ((performance.now() - started) / 1000).toFixed(1);
if (triple === getHostTriple()) {
  console.log(`ok ${dest} (${satEngineVersion(dest)}, ${triple}, built in ${seconds} s)`);
} else {
  console.log(`ok ${dest} (${hash}, ${triple}, built in ${seconds} s; not opened here)`);
}
