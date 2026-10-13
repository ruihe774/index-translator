// Throughput benchmark: node bench/bench.ts | bun bench/bench.ts
import { Qoa } from "../src/qoa.ts";

const seconds = 60, rate = 44100, ch = 2;
const n = seconds * rate;
const pcm = new Int16Array(n * ch);
let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 16) / 65536 - 0.5;
for (let i = 0; i < n; i++)
  for (let c = 0; c < ch; c++)
    pcm[i * ch + c] = Math.round(
      9000 * Math.sin(i * 0.031 * (c + 1)) * Math.sin(i * 0.00007) + 5000 * Math.sin(i * 0.0071 + c) + 2000 * rnd(),
    );

const qoa = await Qoa.create();
function bench(name: string, fn: () => unknown, reps = 5) {
  fn();
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  const msps = (n * ch) / best / 1000;
  console.log(`${name.padEnd(8)} ${best.toFixed(1).padStart(8)} ms  ${msps.toFixed(1).padStart(7)} Msamples/s  ${(seconds * 1000 / best).toFixed(0)}x realtime`);
}
console.log(`backend: ${qoa.backend}, ${seconds}s of ${ch}ch ${rate} Hz`);
let enc!: Uint8Array;
bench("encode", () => (enc = qoa.encode(pcm, ch, rate)));
bench("decode", () => qoa.decode(enc), 20);
