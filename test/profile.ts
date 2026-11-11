// Time per op of one encoder layer, at one sequence length. Builds a copy of the module with $run exported as
// "step", runs a few forwards (warm-up, and the state the ops read), then times each op on its own (best of 5).
// Usage: bun test/profile.ts <threads> <tokens> [sat.wat]
import { loadEngine } from "../src/engine";
import { MODEL, ROOT } from "./paths";

const threads = Number(process.argv[2] ?? 1), s = Number(process.argv[3] ?? 512);
const wat = process.argv[4] ?? `${ROOT}/src/sat.wat`;
const marker = "(func $run (param $op i32)";
const text = await Bun.file(wat).text();
if (!text.includes(marker)) throw new Error(`${wat}: no ${marker}`);
await Bun.write(`${ROOT}/ref/profile.wat`, text.replace(marker, '(func $run (export "step") (param $op i32)'));
const wat2wasm = process.env.WAT2WASM ?? `${ROOT}/wabt-1.0.42/bin/wat2wasm`;
const r = Bun.spawnSync([wat2wasm, "--enable-all", `${ROOT}/ref/profile.wat`, "-o", `${ROOT}/ref/profile.wasm`]);
if (r.exitCode) throw new Error(r.stderr.toString());

// loadEngine keeps its instance to itself: catch the one made on the big (non-probe) memory.
let step: ((op: number, nt: number) => void) | undefined;
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = (async (m: WebAssembly.Module, imports: { env: { memory: WebAssembly.Memory } }) => {
  const inst = (await instantiate(m, imports)) as unknown as WebAssembly.Instance;
  if (imports.env.memory.buffer.byteLength > 1 << 20) step = inst.exports.step as typeof step;
  return inst;
}) as typeof WebAssembly.instantiate;
const engine = await loadEngine(MODEL, threads, `${ROOT}/ref/profile.wasm`);
WebAssembly.instantiate = instantiate;

const ids = new BigInt64Array(s).map((_, i) => BigInt(i === 0 ? 0 : 5 + ((i * 7919) % 200000)));
const mask = new Float32Array(s).fill(1);
for (let i = 0; i < 3; i++) engine.run(ids, mask, 1, s);
let t0 = performance.now();
engine.run(ids, mask, 1, s);
const forward = performance.now() - t0;

const sp = (s + 15) & ~15, d = 768, ff = 3072;
// [name, op (sat.wat's OP_*), tasks (as in forward), flops]
const ops: [string, number, number, number][] = [
  ["QKV", 1, 144, 3 * 2 * sp * d * d],
  ["ATTN", 2, 12 * ((sp + 63) >> 6), 12 * 2 * 2 * sp * sp * 64],
  ["OPROJ", 3, 48, 2 * sp * d * d],
  ["LN1", 4, sp >> 4, 0],
  ["FF1", 5, 192, 2 * sp * d * ff],
  ["FF2", 6, 48, 2 * sp * d * ff],
  ["LN2", 7, sp >> 4, 0],
];
let layer = 0;
for (const [name, op, nt, flops] of ops) {
  step!(op, nt);
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    t0 = performance.now();
    step!(op, nt);
    best = Math.min(best, performance.now() - t0);
  }
  layer += best;
  console.log(`${name.padEnd(6)} ${best.toFixed(2).padStart(8)} ms${flops ? ` ${(flops / best / 1e6).toFixed(1).padStart(6)} GFLOPS` : ""}`);
}
console.log(`3 layers ${(3 * layer).toFixed(1)} ms; whole forward ${forward.toFixed(1)} ms (threads ${threads}, ${s} tokens)`);
engine.close();
