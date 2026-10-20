// Fetch minicelt into vendor/minicelt/: the Opus encoder of the speech stream, a Rust port of
// libopus's CELT-only encoder built for WebAssembly 3.0 (relaxed SIMD, which Bun runs). Bun cannot
// encode Opus, and the server does not link libopus. The binary is from the `miniopus` branch of
// this project's repository, downloaded by
// commit and checksum together with its license. Without it speech is sent as QOA or WAV.
// Usage: bun scripts/fetch_minicelt.ts
//
// A directory that already holds the pinned version is left alone. Needs nothing besides Bun.

import { join, resolve } from "node:path";

import { fetchFileLibrary, type FileLibrary, isPresent } from "./fetch_web_libs";

const COMMIT = "d944fd1cc001eba9e2d056ff4aa12908b152e7c5";
const RAW = `https://raw.githubusercontent.com/ruihe774/index-translator/${COMMIT}`;

export const MINICELT: FileLibrary = {
  dir: "minicelt",
  version: COMMIT,
  files: [
    {
      to: "minicelt-wasm3.wasm",
      url: `${RAW}/target/minicelt-wasm3.wasm`,
      sha256: "533ca47b62c4dd1c46d20190fad2ccf73c36b2971902e88e24a1f21ebf5636c6",
    },
    {
      to: "COPYING",
      url: `${RAW}/COPYING`,
      sha256: "01e1167d54a096d123cf6dfbbeb19587278845c6481d2d66d545669846079551",
    },
  ],
};

/** Throws, naming this script, unless `vendor` holds the pinned minicelt. */
export async function requireMinicelt(vendor: string): Promise<void> {
  if (!(await isPresent(MINICELT, vendor))) {
    throw new Error(`${join(vendor, MINICELT.dir)} is missing or not ${COMMIT}; run: bun scripts/fetch_minicelt.ts`);
  }
}

if (import.meta.main) {
  if (Bun.argv.length > 2) {
    throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
  }
  await fetchFileLibrary(MINICELT, resolve(import.meta.dir, "..", "vendor"));
}
