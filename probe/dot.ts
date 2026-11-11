const { instance } = await WebAssembly.instantiate(await Bun.file("dot.wasm").arrayBuffer());
// per call: 64 k steps x rows x 4 instructions x MACs per instruction (16 for rdot, 8 for dot16); best of 9
for (const [name, rows, macs] of [["rdot", 4, 16], ["dot16", 4, 8], ["rdot_r2", 2, 16], ["dot16_r2", 2, 8]] as const) {
  const f = instance.exports[name] as (n: number) => void;
  f(200000); await Bun.sleep(30); f(200000);
  let best = 0;
  for (let i = 0; i < 9; i++) {
    const n = 200000, t0 = performance.now(); f(n);
    best = Math.max(best, (n * 64 * rows * 4 * macs * 2) / ((performance.now() - t0) / 1000) / 1e9);
  }
  console.log(name.padEnd(9), best.toFixed(1), "GOPS (int, 2 ops per MAC)");
}
