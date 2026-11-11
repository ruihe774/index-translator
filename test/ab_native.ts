// Interleaved A/B timing of native builds (test/ab.ts for libsat.so): loads one engine per build in this process
// and alternates their runs, so that clock drift hits all of them alike. "wasm" in place of a path is the WASM
// engine (src/sat.wasm). Prints min and median per build, and the median relative to the first.
// Usage: bun test/ab_native.ts <threads> <rows>x<width> <reps> a.so|wasm b.so [...]
import { loadNative } from "../native/engine";
import { loadEngine, type SatEngine } from "../src/engine";
import { MODEL } from "./paths";

const [threads, shape, reps, ...libs] = process.argv.slice(2);
if (!libs.length) throw new Error("usage: bun test/ab_native.ts <threads> <rows>x<width> <reps> a.so|wasm b.so [...]");
const [rows, width] = shape!.split("x").map(Number) as [number, number];
const engines: SatEngine[] = [];
for (const lib of libs) {
  engines.push(lib === "wasm" ? await loadEngine(MODEL, Number(threads)) : loadNative(MODEL, Number(threads), lib));
}
const ids = new BigInt64Array(rows * width).map((_, i) => BigInt(i % width === 0 ? 0 : 5 + ((i * 7919) % 200000)));
const mask = new Float32Array(rows * width).fill(1);
for (const e of engines) for (let i = 0; i < 2; i++) e.run(ids, mask, rows, width);
const times: number[][] = engines.map(() => []);
for (let r = 0; r < Number(reps); r++) {
  engines.forEach((e, i) => {
    const t0 = performance.now();
    e.run(ids, mask, rows, width);
    times[i]!.push(performance.now() - t0);
  });
}
const medians = times.map((t) => t.sort((a, b) => a - b)[t.length >> 1]!);
libs.forEach((lib, i) => {
  const name = lib.replace(/.*out\/([^/]+)\/libsat\.so$/, "$1");
  const v = times[i]!;
  console.log(`${name.padEnd(24)} min ${v[0]!.toFixed(1).padStart(7)} ms, median ${medians[i]!.toFixed(1).padStart(7)} ms  x${(medians[i]! / medians[0]!).toFixed(3)}`);
});
for (const e of engines) e.close();
