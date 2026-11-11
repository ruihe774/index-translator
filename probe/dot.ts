const { instance } = await WebAssembly.instantiate(await Bun.file("dot.wasm").arrayBuffer());
// per k-step: 16 instrs; rdot = 16 i8 MACs per lane-group (4 lanes x 4) -> 64 MAC/instr*... count MACs per call: 64 steps * 16 instr * 16 MACs (rdot) or 8 MACs (dot16)
for (const [name, macs] of [["rdot", 16], ["dot16", 8]] as const) {
  const f = instance.exports[name] as (n: number) => void;
  f(50000);
  const n = 1000000, t0 = performance.now(); f(n); const s = (performance.now() - t0) / 1000;
  console.log(name, ((n * 64 * 16 * macs * 2) / s / 1e9).toFixed(1), "GOPS (int, 2 ops per MAC)");
}
