// Times the engine on fixed batches after a warm-up; with INDEX_TRANSLATOR set, also ONNX Runtime through the app's
// bun:ffi binding on the same batches. Without it, tools/bench_ort.py times ORT (Python) on the same inputs.
// Usage: bun test/bench.ts <threads>
import type * as Ort from "../../index-translator/src/onnxruntime-ffi";
import { loadEngine } from "../src/engine";
import { MODEL } from "./paths";

const APP = process.env.INDEX_TRANSLATOR;
const threads = Number(process.argv[2] ?? 1);
// Keep in step with tools/bench_ort.py.
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

let t0 = performance.now();
let session: Ort.Session | undefined;
if (APP) {
  const { loadRuntime } = (await import(`${APP}/src/onnxruntime-ffi.ts`)) as typeof Ort;
  session = loadRuntime(`${APP}/vendor/onnxruntime`).open(MODEL, threads, {
    inputs: ["input_ids", "attention_mask"],
    output: "logits",
  });
}
const ortLoad = performance.now() - t0;
t0 = performance.now();
const engine = await loadEngine(MODEL, threads);
const wasmLoad = performance.now() - t0;
console.log(`threads ${threads}; load: ${session ? `ort ${ortLoad.toFixed(0)} ms, ` : ""}wasm ${wasmLoad.toFixed(0)} ms`);
for (const [rows, width] of shapes) {
  const { ids, mask } = batch(rows, width);
  const reps = rows * width > 1000 ? 3 : 10;
  const b = time(() => engine.run(ids, mask, rows, width), reps);
  if (session) {
    const a = time(() => session.run([ids, mask], rows, width, 1), reps);
    console.log(`${rows}x${width}: ort ${a.toFixed(1)} ms, wasm ${b.toFixed(1)} ms (x${(b / a).toFixed(2)})`);
  } else {
    console.log(`${rows}x${width}: wasm ${b.toFixed(1)} ms`);
  }
}
session?.close();
engine.close();
