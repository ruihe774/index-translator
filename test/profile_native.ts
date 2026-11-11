// test/profile.ts for native builds: time and GFLOPS per op of one encoder layer, at one sequence length (best of 5,
// after a few forwards for warm-up and for the state the ops read).
// Usage: bun test/profile_native.ts <threads> <tokens> [libsat.so]
import { DEFAULT_LIB, loadNative } from "../native/engine";
import { MODEL } from "./paths";

const threads = Number(process.argv[2] ?? 1), s = Number(process.argv[3] ?? 512);
const engine = loadNative(MODEL, threads, process.argv[4] ?? DEFAULT_LIB);
const ids = new BigInt64Array(s).map((_, i) => BigInt(i === 0 ? 0 : 5 + ((i * 7919) % 200000)));
const mask = new Float32Array(s).fill(1);
for (let i = 0; i < 3; i++) engine.run(ids, mask, 1, s);
let t0 = performance.now();
engine.run(ids, mask, 1, s);
const forward = performance.now() - t0;

const sp = (s + 15) & ~15, d = 768, ff = 3072;
// [name, op (sat.zig's OP_*), flops]
const ops: [string, number, number][] = [
  ["QKV", 1, 3 * 2 * sp * d * d],
  ["ATTN", 2, 12 * 2 * 2 * sp * sp * 64],
  ["OPROJ", 3, 2 * sp * d * d],
  ["LN1", 4, 0],
  ["FF1", 5, 2 * sp * d * ff],
  ["FF2", 6, 2 * sp * d * ff],
  ["LN2", 7, 0],
];
console.log(engine.config);
let layer = 0;
for (const [name, op, flops] of ops) {
  engine.step(op);
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    t0 = performance.now();
    engine.step(op);
    best = Math.min(best, performance.now() - t0);
  }
  layer += best;
  console.log(`${name.padEnd(6)} ${best.toFixed(2).padStart(8)} ms${flops ? ` ${(flops / best / 1e6).toFixed(1).padStart(6)} GFLOPS` : ""}`);
}
console.log(`3 layers ${(3 * layer).toFixed(1)} ms; whole forward ${forward.toFixed(1)} ms (threads ${threads}, ${s} tokens)`);
engine.close();
