// Runs the ORT reference batches (tools/ref_cases.py) through the engine; prints the largest logit gap.
import { readdirSync } from "node:fs";
import { loadEngine } from "../src/engine";
import { MODEL, ROOT } from "./paths";

const threads = Number(process.argv[2] ?? 1);
let t0 = performance.now();
const engine = await loadEngine(MODEL, threads);
console.log(`load ${(performance.now() - t0).toFixed(0)} ms, threads ${threads}`);
let worst = 0;
for (const name of readdirSync(`${ROOT}/ref`).filter((f) => f.startsWith("case_")).sort()) {
  const buf = await Bun.file(`${ROOT}/ref/${name}`).arrayBuffer();
  const [rows, width] = new Int32Array(buf, 0, 2);
  const n = rows! * width!;
  const ids = new BigInt64Array(buf.slice(8, 8 + 8 * n));
  const mask = new Float32Array(buf.slice(8 + 8 * n, 8 + 12 * n));
  const want = new Float32Array(buf.slice(8 + 12 * n, 8 + 16 * n));
  t0 = performance.now();
  const got = engine.run(ids, mask, rows!, width!);
  const ms = performance.now() - t0;
  let gap = 0, flips = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i] === 0) continue;
    gap = Math.max(gap, Math.abs(got[i]! - want[i]!));
    if (got[i]! > 0 !== want[i]! > 0) flips++;
  }
  worst = Math.max(worst, gap);
  console.log(`${name}: ${rows}x${width} max |Δlogit| ${gap.toExponential(2)} sign flips ${flips} ${ms.toFixed(1)} ms`);
}
engine.close();
console.log("worst", worst.toExponential(2));
