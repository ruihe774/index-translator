// Resident memory after loading and one 8 x 512 batch, one engine per process. Usage: bun test/rss.ts ort|wasm
import type * as Ort from "../../index-translator/src/onnxruntime-ffi";
import { loadEngine } from "../src/engine";
import { appDir, MODEL } from "./paths";
const mb = () => (process.memoryUsage().rss / 2 ** 20).toFixed(0);
const before = mb();
const ids = new BigInt64Array(8 * 512).map((_, i) => BigInt(i % 512 === 0 ? 0 : 5 + ((i * 7919) % 200000)));
const mask = new Float32Array(8 * 512).fill(1);
let run: () => void, close: () => void;
if (process.argv[2] === "ort") {
  const APP = appDir();
  const { loadRuntime } = (await import(`${APP}/src/onnxruntime-ffi.ts`)) as typeof Ort;
  const s = loadRuntime(`${APP}/vendor/onnxruntime`).open(MODEL, 4, { inputs: ["input_ids", "attention_mask"], output: "logits" });
  run = () => s.run([ids, mask], 8, 512, 1); close = () => s.close();
} else {
  const e = await loadEngine(MODEL, 4);
  run = () => e.run(ids, mask, 8, 512); close = () => e.close();
}
const loaded = mb();
run();
console.log(`${process.argv[2]}: rss before ${before} MB, loaded ${loaded} MB, after a run ${mb()} MB`);
close();
process.exit(0);
