// Fetch sat.wasm into vendor/sat-wasm/: the forward pass of the pinned sat-3l-sm export (the SaT sentence
// segmentation model of fetch_models.ts) written by hand in WebAssembly (SIMD128, threads on shared memory), which
// src/sat-wasm.ts runs on Workers of the segmentation thread. The binary is from the `sat-wasm` branch of this
// project's repository (src/sat.wat assembled; REPORT.md there has how it was measured against ONNX Runtime),
// downloaded by commit and checksum. Without it `POST /segment` is unavailable.
// Usage: bun scripts/fetch_sat_wasm.ts
//
// The module reads the model's weights at the offsets src/sat-tensors.ts lists and exports what src/sat-wasm.ts
// calls, so a new pin means checking both against the branch's src/tensors.ts and src/engine.ts.
//
// A directory that already holds the pinned version is left alone. Needs nothing besides Bun.

import { join, resolve } from "node:path";

import { fetchFileLibrary, type FileLibrary, isPresent } from "./fetch_web_libs";

const COMMIT = "40a9ac2975ca935c85dab8883d0fd9fa6c760174";
const RAW = `https://raw.githubusercontent.com/ruihe774/index-translator/${COMMIT}`;

export const SAT_WASM: FileLibrary = {
  dir: "sat-wasm",
  version: COMMIT,
  files: [
    {
      to: "sat.wasm",
      url: `${RAW}/src/sat.wasm`,
      sha256: "ce13001bfc81f3d3847e87d3235776e02676ade47b6479c134a5435a208e68b1",
    },
  ],
};

/** Throws, naming this script, unless `vendor` holds the pinned sat.wasm. */
export async function requireSatWasm(vendor: string): Promise<void> {
  if (!(await isPresent(SAT_WASM, vendor))) {
    throw new Error(`${join(vendor, SAT_WASM.dir)} is missing or not ${COMMIT}; run: bun scripts/fetch_sat_wasm.ts`);
  }
}

if (import.meta.main) {
  if (Bun.argv.length > 2) {
    throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
  }
  await fetchFileLibrary(SAT_WASM, resolve(import.meta.dir, "..", "vendor"));
}
