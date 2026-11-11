// test/bench.ts for the native builds: the WASM engine and each libsat.so on the same batches, reps and warm-up as
// test/bench.ts (and so tools/bench_ort.py), engines one after the other.
// Usage: bun test/bench_native.ts <threads> [libsat.so ...]
import { DEFAULT_LIB, loadNative } from "../native/engine";
import { loadEngine, type SatEngine } from "../src/engine";
import { MODEL } from "./paths";

const threads = Number(process.argv[2] ?? 1);
const libs = process.argv.length > 3 ? process.argv.slice(3) : [DEFAULT_LIB];
// Keep in step with test/bench.ts and tools/bench_ort.py.
const shapes: [number, number][] = [[1, 32], [1, 128], [1, 512], [8, 512]];
const batch = (rows: number, width: number) => {
  const ids = new BigInt64Array(rows * width).map((_, i) => BigInt(i % width === 0 ? 0 : 5 + ((i * 7919) % 200000)));
  return { ids, mask: new Float32Array(rows * width).fill(1) };
};
const time = (f: () => void, reps: number) => {
  f();
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) f();
  return (performance.now() - t0) / reps;
};
const bench = (name: string, engine: SatEngine) => {
  const cells = shapes.map(([rows, width]) => {
    const { ids, mask } = batch(rows, width);
    return time(() => engine.run(ids, mask, rows, width), rows * width > 1000 ? 3 : 10).toFixed(1).padStart(8);
  });
  console.log(`${name.padEnd(12)}${cells.join("")}`);
};

console.log(`threads ${threads}`);
console.log(`${"".padEnd(12)}${shapes.map(([r, w]) => `${r}x${w}`.padStart(8)).join("")}   (ms per call)`);
let t0 = performance.now();
const wasm = await loadEngine(MODEL, threads);
const wasmLoad = performance.now() - t0;
bench("wasm", wasm);
wasm.close();
for (const lib of libs) {
  t0 = performance.now();
  const engine = loadNative(MODEL, threads, lib);
  const load = performance.now() - t0;
  bench(lib.replace(/.*out\/([^/]+)\/libsat\.so$/, "$1"), engine);
  engine.close();
  console.log(`${"".padEnd(12)}load ${load.toFixed(0)} ms (wasm ${wasmLoad.toFixed(0)} ms); ${engine.config}`);
}
