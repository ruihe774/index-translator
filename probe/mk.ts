// GFLOPS of each micro-kernel variant (probe/gen_mk.py): warm-up until optimized, then 9 interleaved rounds;
// prints the best and the median round (a VM's clock drifts between runs).
const { instance } = await WebAssembly.instantiate(await Bun.file("mk.wasm").arrayBuffer());
const sizes = process.argv[2]!.split(" ").map((s) => s.split(":")).map(([n, w]) => [n!, Number(w)] as const);
const rates: Record<string, number[]> = {};
for (const [name] of sizes) {
  const f = instance.exports[name] as (n: number) => void;
  f(50000); await Bun.sleep(50); f(50000);
  rates[name] = [];
}
for (let round = 0; round < 9; round++) {
  for (const [name, cols] of sizes) {
    const f = instance.exports[name] as (n: number) => void;
    const n = 40000, t0 = performance.now(); f(n); const s = (performance.now() - t0) / 1000;
    rates[name]!.push((n * 256 * cols * 2) / s / 1e9);
  }
}
for (const [name] of sizes) {
  const v = rates[name]!.sort((a, b) => b - a);
  console.log(name.padEnd(10), v[0]!.toFixed(1).padStart(5), "GFLOPS best,", v[4]!.toFixed(1).padStart(5), "median");
}
