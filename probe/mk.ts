const { instance } = await WebAssembly.instantiate(await Bun.file("mk.wasm").arrayBuffer());
const sizes: Record<string, number> = Object.fromEntries(process.argv[2]!.split(" ").map((s) => s.split(":")).map(([n, w]) => [n, Number(w)]));
for (const [name, cols] of Object.entries(sizes)) {
  const f = instance.exports[name] as (n: number) => void;
  f(20000);
  const n = 200000, t0 = performance.now(); f(n); const s = (performance.now() - t0) / 1000;
  console.log(name, ((n * 256 * cols * 2) / s / 1e9).toFixed(1), "GFLOPS");
}
