#!/usr/bin/env bash
# Builds and runs the probes: which WASM proposals this Bun accepts, shared memory across Workers, and the
# micro-kernel throughput figures in REPORT.md. WAT2WASM overrides the path to wat2wasm.
set -euo pipefail
cd "$(dirname "$0")"
W=${WAT2WASM:-../wabt-1.0.42/bin/wat2wasm}
for f in simd relaxed threads mem64 multimem tail shared; do "$W" --enable-all "$f.wat" -o "$f.wasm"; done
echo "== proposals"; bun probe.ts
echo "== shared memory, wait/notify across Workers"; timeout 20 bun main.ts
python3 gen_mk.py > mk.variants && "$W" --enable-all mk.wat -o mk.wasm
echo "== f32 micro-kernels (GFLOPS)"; bun mk.ts "$(cat mk.variants)"
python3 gen_dot.py && "$W" --enable-all dot.wat -o dot.wasm
echo "== int8 micro-kernels"; bun dot.ts
