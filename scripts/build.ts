// Assemble src/qoa.wat with wabt and emit:
//   dist/qoa.wasm               relaxed-SIMD build
//   dist/qoa-simd.wasm          SIMD-only fallback (relaxed ops replaced)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import initWabt from "wabt";

const root = new URL("../", import.meta.url);
const wabt = await initWabt();
const features = { simd: true, relaxed_simd: true, bulk_memory: true, mutable_globals: true, sign_extension: true, sat_float_to_int: true, annotations: true, code_metadata: true };

function assemble(name: string, text: string): Uint8Array {
  const mod = wabt.parseWat(name, text, features);
  try {
    mod.resolveNames();
    mod.validate();
    const bin = mod.toBinary({ log: false, write_debug_names: false }).buffer;
    checkBranchHints(name, bin);
    return bin;
  } finally {
    mod.destroy();
  }
}

// wabt attaches a branch hint to the instruction that follows it. In folded
// form, `(@metadata.code.branch_hint ..) (if (cond) ..)`, that is the first
// instruction of `cond`, and engines silently ignore the misplaced hint.
// Check that every hint lands on an `if` (0x04) or `br_if` (0x0d).
function checkBranchHints(name: string, bin: Uint8Array) {
  let pos = 8;
  const u32 = () => {
    let x = 0, shift = 0, b;
    do x |= ((b = bin[pos++]!) & 0x7f) << shift, shift += 7; while (b & 0x80);
    return x >>> 0;
  };
  const bodies: number[] = [];
  let hints = 0;
  while (pos < bin.length) {
    const id = bin[pos++]!, size = u32(), end = pos + size;
    if (id === 0) {
      const len = u32(), sec = new TextDecoder().decode(bin.subarray(pos, pos + len));
      if (sec === "metadata.code.branch_hint") hints = pos + len;
    } else if (id === 10) {
      for (let n = u32(); n > 0; n--) {
        const len = u32();
        bodies.push(pos);
        pos += len;
      }
    }
    pos = end;
  }
  if (!hints) throw new Error(`${name}: no branch hints`);
  pos = hints;
  for (let funcs = u32(); funcs > 0; funcs--) {
    const body = bodies[u32()]!;
    for (let n = u32(); n > 0; n--) {
      const at = body + u32();
      if (u32() !== 1 || bin[pos++]! > 1 || (bin[at] !== 0x04 && bin[at] !== 0x0d))
        throw new Error(`${name}: branch hint at byte ${at} is not on an if / br_if; unfold the condition`);
    }
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
