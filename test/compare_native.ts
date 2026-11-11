// Runs the ORT reference batches (tools/ref_cases.py) through native builds; prints the largest logit gap to ORT,
// and to the WASM engine on the same batches (0 means bit-identical logits).
// Usage: bun test/compare_native.ts <threads> [libsat.so ...]
import { readdirSync } from "node:fs";
import { DEFAULT_LIB, loadNative } from "../native/engine";
import { loadEngine } from "../src/engine";
import { MODEL, ROOT } from "./paths";

const threads = Number(process.argv[2] ?? 1);
const libs = process.argv.length > 3 ? process.argv.slice(3) : [DEFAULT_LIB];
const cases = readdirSync(`${ROOT}/ref`).filter((f) => f.startsWith("case_")).sort().map(async (name) => {
  const buf = await Bun.file(`${ROOT}/ref/${name}`).arrayBuffer();
  const [rows, width] = new Int32Array(buf, 0, 2) as unknown as [number, number];
  const n = rows * width;
  return {
    name, rows, width,
    ids: new BigInt64Array(buf.slice(8, 8 + 8 * n)),
    mask: new Float32Array(buf.slice(8 + 8 * n, 8 + 12 * n)),
    want: new Float32Array(buf.slice(8 + 12 * n, 8 + 16 * n)),
  };
});
const data = await Promise.all(cases);
const wasm = await loadEngine(MODEL, threads);
const wasmOut = data.map((c) => wasm.run(c.ids, c.mask, c.rows, c.width));
wasm.close();

const gap = (a: Float32Array, b: Float32Array, mask: Float32Array) => {
  let g = 0, flips = 0;
  for (let i = 0; i < a.length; i++) {
    if (mask[i] === 0) continue;
    g = Math.max(g, Math.abs(a[i]! - b[i]!));
    if (a[i]! > 0 !== b[i]! > 0) flips++;
  }
  return { g, flips };
};
for (const lib of libs) {
  const engine = loadNative(MODEL, threads, lib);
  let worstOrt = 0, worstWasm = 0, flips = 0;
  data.forEach((c, i) => {
    const got = engine.run(c.ids, c.mask, c.rows, c.width);
    const o = gap(got, c.want, c.mask), w = gap(got, wasmOut[i]!, c.mask);
    worstOrt = Math.max(worstOrt, o.g);
    worstWasm = Math.max(worstWasm, w.g);
    flips += o.flips;
  });
  engine.close();
  console.log(`${engine.config}: max |Δlogit| vs ORT ${worstOrt.toExponential(2)} (sign flips ${flips}), vs WASM ${worstWasm.toExponential(2)}`);
}
