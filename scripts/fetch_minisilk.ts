// Fetch minisilk into vendor/minisilk/: the Opus encoder of the speech stream, a Rust port of
// libopus's SILK-only encoder built for WebAssembly 3.0 (relaxed SIMD, which Bun runs). Bun cannot
// encode Opus, and the server does not link libopus. The build is the `minisilk` branch of this
// project's repository (the `prebuilt` branch of minisilk, which holds the .wasm), downloaded by
// commit and checksum together with its license. Without it speech is sent as QOA or WAV.
// Usage: bun scripts/fetch_minisilk.ts
//
// A directory that already holds the pinned version is left alone. Needs nothing besides Bun.

import { join, resolve } from "node:path";

import { fetchFileLibrary, type FileLibrary, isPresent } from "./fetch_web_libs";

const COMMIT = "11c084acfe2858bdbd28ed8d3806b9419e0e6ef7";
const RAW = `https://raw.githubusercontent.com/ruihe774/index-translator/${COMMIT}`;

export const MINISILK: FileLibrary = {
  dir: "minisilk",
  version: COMMIT,
  files: [
    {
      to: "minisilk-wasm3.wasm",
      url: `${RAW}/target/minisilk-wasm3.wasm`,
      sha256: "933e41df6bafb8250f4615d98569b230c23e5e06a0f85b3c2b9c74eb0a2f6822",
    },
    {
      to: "COPYING",
      url: `${RAW}/COPYING`,
      sha256: "01e1167d54a096d123cf6dfbbeb19587278845c6481d2d66d545669846079551",
    },
  ],
};

/** Throws, naming this script, unless `vendor` holds the pinned minisilk. */
export async function requireMinisilk(vendor: string): Promise<void> {
  if (!(await isPresent(MINISILK, vendor))) {
    throw new Error(`${join(vendor, MINISILK.dir)} is missing or not ${COMMIT}; run: bun scripts/fetch_minisilk.ts`);
  }
}

if (import.meta.main) {
  if (Bun.argv.length > 2) {
    throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
  }
  await fetchFileLibrary(MINISILK, resolve(import.meta.dir, "..", "vendor"));
}
