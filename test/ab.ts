// Interleaved A/B timing of engine builds: compiles each .wat, loads one engine per build in this process and
// alternates their runs, so that clock drift (turbo, other tenants of a VM) hits all of them alike.
// Usage: bun test/ab.ts <threads> <rows>x<width> <reps> a.wat b.wat [...]
import { loadEngine } from "../src/engine";
import { MODEL, ROOT } from "./paths";

const [threads, shape, reps, ...wats] = process.argv.slice(2);
if (!wats.length) throw new Error("usage: bun test/ab.ts <threads> <rows>x<width> <reps> a.wat b.wat [...]");
const [rows, width] = shape!.split("x").map(Number) as [number, number];
const wat2wasm = process.env.WAT2WASM ?? `${ROOT}/wabt-1.0.42/bin/wat2wasm`;
const engines = [];
for (const [i, wat] of wats.entries()) {
  const out = `${ROOT}/ref/ab_${i}.wasm`;
  const r = Bun.spawnSync([wat2wasm, "--enable-all", wat, "-o", out]);
  if (r.exitCode) throw new Error(r.stderr.toString());
  engines.push(await loadEngine(MODEL, Number(threads), out));
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
wats.forEach((w, i) => {
  const v = times[i]!.sort((a, b) => a - b);
  console.log(`${w.padEnd(32)} min ${v[0]!.toFixed(1).padStart(7)} ms, median ${v[v.length >> 1]!.toFixed(1).padStart(7)} ms`);
});
for (const e of engines) e.close();
