// Measures variants of src/sat-engine.zig's tunables (its `cfg` struct) on this machine.
// Usage: bun scripts/sat_tune.ts [--threads 1,4,8] [--shapes 1x128,1x512,8x512] [--rounds 9] [--out DIR] [variant ...]
//
// A variant is `name:key=value,key=value` (`name` alone is the source as it is): the source is copied with those
// `pub const key = ...;` lines of `cfg` replaced, built like scripts/zigbuild_sat_engine.ts does into DIR/<name>
// (vendor/.build/sat-tune by default) and loaded with the model of the server's settings. Every shape runs once per
// variant in each round, round after round, so clock and thermal drift lands on all variants alike; the table has the
// median ms per call, the median over the first variant's in brackets and the largest difference of any logit from the
// first variant's. Pin the cores for a clean measurement: `taskset -c 5-9,15-19 bun scripts/sat_tune.ts ...`.

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadConfig } from "../src/config";
import { loadSatEngineAt, type SatEngine } from "../src/sat-ffi";
import { getHostTriple, requireZig, zigBuildSatEngine } from "./zigbuild_tools";

const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args.splice(at, 2)[1]!;
};
const threadCounts = option("--threads", "1,4,8").split(",").map(Number);
const shapes = option("--shapes", "1x128,1x512,8x512")
  .split(",")
  .map((s) => s.split("x").map(Number) as [number, number]);
const rounds = Number(option("--rounds", "9"));
const out = resolve(option("--out", join(root, "vendor", ".build", "sat-tune")));
const variants = (args.length > 0 ? args : ["base"]).map((spec) => {
  const [name, rest = ""] = spec.split(":") as [string, string?];
  const overrides = rest === "" ? [] : rest.split(",").map((kv) => kv.split("=") as [string, string]);
  return { name, overrides };
});

await requireZig([], "Zig: bun scripts/fetch_zig.ts");
const original = await Bun.file(join(root, "src", "sat-engine.zig")).text();
const cfg = loadConfig(Bun.env);
const model = join(cfg.segmentModelDir, "model.onnx");

await rm(out, { recursive: true, force: true });
for (const { name, overrides } of variants) {
  let text = original;
  for (const [key, value] of overrides) {
    const line = new RegExp(`^(    pub const ${key} = ).*;$`, "m");
    if (!line.test(text)) {
      throw new Error(`${name}: no tunable ${key}`);
    }
    text = text.replace(line, `$1${value};`);
  }
  await mkdir(join(out, name), { recursive: true });
  const source = join(out, name, "sat-engine.zig");
  await Bun.write(source, text);
  await zigBuildSatEngine(getHostTriple(), source, join(out, name, "libsat.so"));
}

const batch = (rows: number, width: number) => ({
  ids: new BigInt64Array(rows * width).map((_, i) => BigInt(i % width === 0 ? 0 : 5 + ((i * 7919) % 200_000))),
  mask: new Float32Array(rows * width).fill(1),
});
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const table: string[] = [];
for (const threads of threadCounts) {
  const engines: SatEngine[] = variants.map(({ name }) =>
    loadSatEngineAt(join(out, name, "libsat.so"), model, threads),
  );
  table.push(`threads ${threads}`.padEnd(14) + shapes.map(([r, w]) => `${r}x${w}`.padStart(18)).join(""));
  const samples = variants.map(() => shapes.map(() => [] as number[]));
  const logits: Float32Array[][] = variants.map(() => shapes.map(() => new Float32Array()));
  for (let round = -1; round < rounds; round++) {
    // The order of the variants rotates, so none is always the one that runs just after the others.
    for (let k = 0; k < variants.length; k++) {
      const v = (k + Math.max(round, 0)) % variants.length;
      shapes.forEach(([rows, width], s) => {
        const { ids, mask } = batch(rows, width);
        const t0 = performance.now();
        const result = engines[v]!.run(ids, mask, rows, width);
        const ms = performance.now() - t0;
        if (round >= 0) {
          samples[v]![s]!.push(ms);
        }
        logits[v]![s] = result;
      });
    }
  }
  variants.forEach(({ name }, v) => {
    const cells = shapes.map((_, s) => {
      const ms = median(samples[v]![s]!);
      const base = median(samples[0]![s]!);
      let delta = 0;
      for (const [i, x] of logits[v]![s]!.entries()) {
        delta = Math.max(delta, Math.abs(x - logits[0]![s]![i]!));
      }
      const ratio = v === 0 ? "" : ` x${(ms / base).toFixed(3)}`;
      return `${ms.toFixed(1)}${ratio}${delta > 0 ? ` d${delta.toExponential(0)}` : ""}`.padStart(18);
    });
    table.push(name.padEnd(14) + cells.join(""));
  });
  engines.forEach((e) => e.close());
  table.push("");
}
console.log(
  `ms per call, median of ${rounds} interleaved rounds; xN: against ${variants[0]!.name}, dN: largest logit difference`,
);
console.log(table.join("\n"));
