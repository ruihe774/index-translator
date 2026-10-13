// Assemble src/qoa.wat with wabt and emit:
//   dist/qoa.wasm               relaxed-SIMD build
//   dist/qoa-simd.wasm          SIMD-only fallback (relaxed ops replaced)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import initWabt from "wabt";

const root = new URL("../", import.meta.url);
const wabt = await initWabt();
const features = { simd: true, relaxed_simd: true, bulk_memory: true, mutable_globals: true };

function assemble(name: string, text: string): Uint8Array {
  const mod = wabt.parseWat(name, text, features);
  try {
    mod.resolveNames();
    mod.validate();
    return mod.toBinary({ log: false, write_debug_names: false }).buffer;
  } finally {
    mod.destroy();
  }
}

const wat = readFileSync(new URL("src/qoa.wat", root), "utf8");
// The only relaxed op is relaxed_swizzle, used with in-range indices only,
// so it is semantically identical to the deterministic swizzle.
const watSimd = wat.replaceAll("i8x16.relaxed_swizzle", "i8x16.swizzle");
if (/relaxed_/.test(watSimd.replace(/;;.*$/gm, ""))) throw new Error("unhandled relaxed op in fallback");

const relaxed = assemble("qoa.wat", wat);
const simd = assemble("qoa-simd.wat", watSimd);

mkdirSync(new URL("dist/", root), { recursive: true });
writeFileSync(new URL("dist/qoa.wasm", root), relaxed);
writeFileSync(new URL("dist/qoa-simd.wasm", root), simd);

console.log(`qoa.wasm ${relaxed.length} bytes, qoa-simd.wasm ${simd.length} bytes`);
