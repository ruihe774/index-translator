# Spike: sat-3l-sm on a hand-written WASM kernel instead of ONNX Runtime

Verdict: **feasible and exact, but about 3× slower than ORT** on the first machine measured (Cortex-X925, aarch64, Bun
1.4.4). On x86-64 (Sapphire Rapids, Bun 1.4.4) it started at 3.3× slower end to end. After the x86-64 follow-up below it is
**2.1× slower**, against a floor of about 1.8–2× for this f32 design. Memory is the same. The slowdown comes from how JSC
compiles WASM SIMD (details below), not from the design.

## What the model is

`model.onnx` (sha256 `1132546a…be99f`) is a plain XLM-R encoder: embeddings, 3 layers (768 wide, 12 heads, FFN 3072, exact-erf
GELU) and a 768→1 classifier. Every linear layer is `MatMulNBits` with 8-bit weights, block 32, no zero points
(so the zero point is 128). The word embeddings use `GatherBlockQuantized` with the same scheme. Inputs are `input_ids` i64 and
`attention_mask` f32; the mask enters as `(1 - mask) * -65504`. Position ids follow RoBERTa:
`cumsum(id != 1) * (id != 1) + 1`. All of this was checked by `tools/reference.py`, a NumPy forward pass that reads only
fixed offsets; it matches ORT to 1.5e-5.

## What was built

| File | Contents |
|---|---|
| `src/sat.wat` (754 lines, 5.6 KB `.wasm`) | the forward pass: blocked f32 GEMM (2×16 SIMD micro-kernel, 4×16 before the x86-64 follow-up; K blocks of 256, int8→f32 dequant while packing), attention, LayerNorm, SIMD exp / erf-GELU, a thread pool on shared memory (`memory.atomic.wait32/notify`, tasks claimed with a generation-tagged CAS counter) |
| `src/engine.ts` | loads the 75 tensors from fixed file offsets straight into the shared WASM memory (`readSync`, no extra copy), checks file size and a hash of the graph bytes, starts the workers, and exposes `run(ids, mask, rows, width)` with exactly the shape of sat.ts's `RunModel` |
| `src/tensors.ts` | generated `[offset, bytes]` table for the pinned file (`tools/offsets.py` walks the protobuf, `tools/gen_tensors.py` writes the table) |
| `src/thread.ts` | the Worker that runs `worker(tid)` |

Features used: SIMD128, threads/atomics, bulk memory. Bun also accepts relaxed SIMD, multi-memory and tail calls. It
rejects Memory64, which isn't needed: the whole engine fits in about 280 MB of 32-bit memory.

Each window is run on its own and cut at its last unmasked token. This is exact, because masked keys come out of the
softmax as exactly 0, and it saves work on the padded rows of a batch.

## Results

**Accuracy**

- `test/compare.ts`, random batches with padding against ORT: max |Δlogit| 4.8e-5, with logits in about ±14.
- `test/e2e.ts`, the app's own `findBoundaries` (tokenizer, 510/256 windows, batches of 8) on 169 texts and
  125k tokens (the docs of index-translator at commit `c43083e`, multi-window documents, zh/ja/ko/ar/ru/de/fr/es):
  **identical boundaries**. No offset appears on only one side, no decision flips at 0.5, and max |Δp| is 0.001, which is
  the 3-significant-digit rounding.

**Speed** (`test/bench.ts`, ms per call, app's ORT 1.31 via bun:ffi; aarch64, the 4×16 kernel; for x86-64 see below)

| batch | 1 thread ORT / WASM | 4 threads ORT / WASM | 8 threads ORT / WASM |
|---|---|---|---|
| 1×32 | 28 / 40 | 12 / 18 | 8.3 / 8.9 |
| 1×128 | 62 / 158 | 17 / 40 | 9.3 / 26 |
| 1×512 | 219 / 691 | 57 / 175 | 31 / 90 |
| 8×512 | 1817 / 5578 | 475 / 1403 | 244 / 760 |

End to end on the 125k-token corpus with 4 threads, ORT takes 26.8 s and WASM 73.9 s. Threads scale the same for both.

**Memory and load**: about 300 MB resident for either engine; load is 65–90 ms for either. The 25 MB `libonnxruntime.so`
is replaced by a 5 KB `.wasm` plus about 150 lines of TS.

## Why it's 3× slower, and what could change that

This section is about aarch64, before the x86-64 follow-up.

- The GEMM micro-kernel runs at **45–49 GFLOPS** whatever the tile shape (`probe/gen_mk.py`). That is the FP-pipe
  ceiling for *unfused* `f32x4.mul` + `f32x4.add`. ORT's native kernels use FMA and reach about 110 GFLOPS single-threaded.
- `f32x4.relaxed_madd` should give FMA, but JSC on ARM64 lowers it to `VectorFusedMulAdd` through a scratch register,
  3 instructions per op. It is *slower* (33 GFLOPS) than mul+add, so the kernel uses mul+add. If JSC fixes this lowering,
  the f32 path roughly doubles. (On x86-64 it doesn't fuse either, see below.)
- `i32x4.relaxed_dot_i8x16_i7x16_add_s` *is* lowered well: about **300 GOPS**, 6× the f32 kernel. But it needs
  activations quantized to 7 bits. Simulated on 40 real windows (`tools/int8_sim.py`), 7-bit activations flip 7 of 276
  boundaries and 8-bit ones flip 7 too. 12-bit would flip none, but that doesn't fit the instruction. So this route is only
  possible with mixed precision for outlier blocks, and it no longer matches ORT bit for bit; it would be a project of
  its own.
- Smaller remaining overheads: the gap between the kernel ceiling and the end-to-end rate (35 vs 45 GFLOPS), mostly in
  attention (K=64 micro-kernel calls, a scalar K transpose per row block) and packing. Optimizing these could bring the gap
  to about 2.3×, not lower.

## x86-64 follow-up: what JSC does there, what was changed, and what is left

Measured on a 4-core KVM guest of an Intel Xeon (Sapphire Rapids, family 6 model 207, AVX-512 and FMA on the host CPU),
Linux, Bun 1.4.4, with the app's ORT 1.31.0 via bun:ffi. The VM's clock drifts by ±10–15% between runs, so before/after
comparisons were made with `test/ab.ts`: both builds in one process, runs interleaved. Generated code was read from
`BUN_JSC_dumpOMGDisassembly=1` (Air IR, with code addresses), and the actual instructions with `gdb -p <pid> -batch -ex
"x/60i <address>"` on the running process.

**What JSC does on x86-64**

- `f32x4.relaxed_madd` is **`vmulps` + `vaddps`**, so no FMA even though the CPU has it. It also takes a scratch register.
  The f32 ceiling is therefore unfused mul+add on 128-bit vectors. mul runs on ports 0/1 and add on 1/5, so 16 FP ops per
  64 flops give at most **12 flop/cycle, ~45–47 GFLOPS** single-threaded at turbo. The register-sized probe kernels
  reach it: `m2x16u1sm`, `m3x12u1sm`, `m4x12u1sm` and `m6x8u1sm` all reach 44–47 at best. ORT's native kernels use
  AVX-512 FMA (64 flop/cycle peak) and reach ~80–90 GFLOPS here.
- JSC uses only the 16 XMM registers. The 4×16 tile (16 accumulators + 4 B + splat) **spills**.
- `v128.load32_splat` at a load offset from a shared pointer (`offset=1024`, `2048`, …) becomes a GPR load + `vmovq` +
  `vshufps`, 2 more uops on the shuffle port, which the adds also use. With one pointer per row and no offset it is one
  `vbroadcastss`.
- **A call anywhere in a function made JSC keep all accumulators on the stack, inside the hot loop too.** `$mk` ended
  with the GELU epilogue's `call $gelu4`. Every vector register is caller-saved, and Air's allocator spilled all 16
  (and, after a first fix, all 8) accumulators for the whole function. This cost more than everything else together.
  It probably happens on aarch64 too (vector registers are caller-saved there as well), but that was **not re-measured**.
- `f32x4.max` is 8 instructions (NaN and -0 rules); `f32x4.pmax` is one `maxps`. `i32x4.trunc_sat_f32x4_s` is also
  several.
- `i32x4.relaxed_dot_i8x16_i7x16_add_s` is not a fast path here: ~60 GOPS, slower than the standard `i32x4.dot_i16x8_s`
  (`vpmaddwd`; 72–83 GOPS in the spill-free 2-row kernel, 1.6–2× the f32 kernel's MAC rate measured in the same run).

**What was changed** (`src/sat.wat`; max |Δlogit| still 5.0e-5, e2e boundaries still identical)

1. Micro-kernel 4×16 → **2×16**, call-free: 8 accumulators + splat + 4 B vectors fit in 16 registers. Each A row has its
   own pointer, and B is read at each use (JSC CSEs the loads into registers). The hot loop is now 8 `vmulps`, 8 `vaddps`,
   2 `vbroadcastss`, 4 `vmovups` and no stack traffic. GELU is a separate pass over the finished 16-column strip.
2. Attention:
   - K is transposed once, in the QKV task that wrote each 16-column strip, instead of once per (head, 64-row block),
     which was 8× over.
   - K and V are stored as contiguous 16-column panels (KT in TMP, VP in H, both free until OPROJ). Read with their 2–3 KB
     row strides, 64–512 rows map to 2–4 L1 sets and thrash.
   - Both products loop over the column strip outermost, so the B panel stays in L1.
   - The 1/8 scale is folded into Q's weight scales and bias at `prepare`, which is exact as a power of 2. Scores start
     from the mask bias (the micro-kernel's bias row), so the first softmax pass only finds the max.
   - exp is inlined into the softmax loop (a call there spills the loop state).
   - The 1/sum is applied to the 64-wide output row instead of a third pass over the S-wide scores.
3. exp: the rounding uses the 1.5·2²³ trick, which gives the same `n` as `f32x4.nearest`, and 2ⁿ comes from the same bits,
   so there is no `trunc_sat`. The clamp and the max use `pmax`.

**Results on x86-64** (ms; ORT is the app's binding in the same run, and its own timings vary by ±15%)

| | before: ORT / WASM | after: ORT / WASM |
|---|---|---|
| 1×32, 1 thread | 56 / 65 | 54 / 46 |
| 1×128, 1 thread | 90 / 262 | 81 / 161 |
| 1×512, 1 thread | 269 / 1182 (×4.4) | 300 / 782 (×2.6) |
| 8×512, 1 thread | 2957 / 9068 (×3.1) | 2821 / 6108 (×2.2) |
| 1×512, 4 threads | 83 / 315 (×3.8) | 108 / 214 (×2.0) |
| 8×512, 4 threads | 968 / 2797 (×2.9) | 891 / 1894 (×2.1) |
| e2e, 125k tokens, 4 threads (`test/e2e.ts`) | 45.2 s / 150.7 s (×3.3) | 45.6 s / 96.1 s (**×2.1**) |

Interleaved (`test/ab.ts`, medians): 1×512 on 1 thread 1243 → 754 ms, of which the call-free 2×16 kernel alone gives
1243 → 806; 8×512 on 4 threads 2727 → 1783 ms. Per op at 1×512 on 1 thread (`test/profile.ts`, per layer): QKV 46–53 ms
(34–40 GFLOPS), attention 25–35 ms (was 73), OPROJ 15–17, FF1 69–78, FF2 68–80 (30–35 GFLOPS), LayerNorms 0.3.

**Is there headroom left?** In this design, not much:

- The micro-kernel is at the hardware limit for what JSC emits (unfused 128-bit mul+add, ~12 flop/cycle). Nothing in
  WASM SIMD reaches beyond it on x86-64 today. There are no wider vectors, `relaxed_madd` doesn't fuse, and no tile shape
  does better.
- End to end the engine now runs at 32–38 GFLOPS single-threaded (24.2 GFLOP per 512-token window), **~80% of the kernel
  ceiling**. The rest is the GEMM's A stream from L2, packing, and the C reload per K block (GEMMs at 75–88% of the
  kernel), plus attention (~30 GFLOPS) and the GELU pass. Blocking the GEMM for A reuse might get another ~10%. At 100%
  of the kernel ceiling, 1×512 would take ~540 ms, which is **~1.8–2× ORT. That is the floor of the f32 design** on this
  CPU. The engine is at 2.1–2.6×.
- Getting past it means leaving f32. The standard-SIMD `i32x4.dot_i16x8_s` is deterministic and 1.6–2× the f32 kernel. It
  would need int16 activations (dynamic per-row scale) and a float rescale per 32-wide weight block, which eats part of the
  gain, and results would no longer match ORT bit for bit (12-bit activations flipped no boundary in `tools/int8_sim.py`,
  so 16-bit very likely doesn't either). Estimated gain: ~1.3–1.5× on the GEMMs, so roughly 1.5–1.7× ORT. It is a project of its own.
- The 2×16 kernel was chosen for x86-64. On aarch64 (32 registers, and no splat or spill issue), 4×16 might still be
  the better tile, so aarch64 should be re-measured, and the shape could be picked per architecture. The other
  changes (call-free kernel, attention, exp) are not x86-specific.

## Not done (out of scope or left open)

Wiring into index-translator; Windows measurement; aarch64 re-measurement after the x86-64 changes; aborting mid-batch (the TS loop could check between rows);
fixing `run` at width ≤ 512 (already enforced). Worker threads spin briefly (20k atomic loads) before sleeping.

## Reproduce

Everything below runs from this directory. Steps 1–4 need nothing from index-translator; step 5 does.

**Requirements:** Bun 1.4.4 (the version measured; JSC's WASM compiler decides the speed figures). WABT 1.0.42, unpacked into
`wabt-1.0.42/` here (<https://github.com/WebAssembly/wabt/releases/tag/1.0.42>). `uv`, `curl`, `sha256sum`, and Python 3.13
(what uv picked here).

**1. Model.** This downloads the pinned files from Hugging Face (`jiangzhuo9357/sat-3l-sm-onnx` at revision
`7698b9e41fef7a1e24638b9aaff2108ce1020657`, an 8-bit export of `segment-any-text/sat-3l-sm`, MIT) into `models/sat-3l-sm/`
and checks their SHA-256:

```
tools/fetch_model.sh
#   model.onnx      1132546a16fa1aa9da218602049c6e7aeba0ec5b76409131446f40ebda2be99f  (241945842 bytes)
#   tokenizer.json  a898ea75433890f6610f4e470b8ebeb0c21dce5c8dd61f892eb09eb5919d2e2c  (xlm-roberta-base's)
```

`HF_ENDPOINT` selects a mirror. `SAT_MODEL_DIR` puts the files elsewhere, and every script below reads the same variable.

**2. Python environment, offsets, build.**

```
uv venv .venv && uv pip install --python .venv -r requirements.txt
.venv/bin/python tools/dump_graph.py        # initializers (names, types, shapes); dump_nodes.py: the op graph
.venv/bin/python tools/offsets.py           # layout.json: file offset of every tensor's raw data
.venv/bin/python tools/gen_tensors.py       # src/tensors.ts from layout.json (the committed one must come out identical)
bun tools/fingerprint.ts                    # must print HEADER_HASH of src/engine.ts: 0xce62e25de97aa9bn
wabt-1.0.42/bin/wat2wasm --enable-all src/sat.wat -o src/sat.wasm
```

**3. Accuracy against ONNX Runtime** (onnxruntime 1.31.1 from `requirements.txt`):

```
.venv/bin/python tools/reference.py         # NumPy forward pass from fixed offsets vs ORT: max diff ~1.5e-5
.venv/bin/python tools/ref_cases.py         # ref/case_*.bin: random padded batches with ORT's logits
bun test/compare.ts 4                       # engine vs those logits (argument: threads): max |Δlogit| ~5e-5
```

**4. Speed and the JSC findings.**

```
bun test/bench.ts 4                         # engine timings (argument: threads)
.venv/bin/python tools/bench_ort.py 4       # ORT on the same batches
probe/run.sh                                # accepted proposals, shared memory across Workers, micro-kernel GFLOPS/GOPS
bun test/profile.ts 1 512                   # time and GFLOPS per op of one layer (threads, tokens)
bun test/ab.ts 1 1x512 12 old.wat src/sat.wat   # interleaved timing of two builds (threads, batch, reps)
```

Python ORT 1.31.1 gave the same timings as the app's ORT 1.31.0 through bun:ffi (for example 55 vs 54 ms for 1×512 with 4
threads). To see the relaxed_madd lowering, run a kernel with `BUN_JSC_dumpWasmDisassembly=1 BUN_JSC_dumpOMGDisassembly=1`.
Bun's build has no disassembler, but the Air IR it prints shows `VectorFusedMulAdd` going through a scratch register.
For the machine code, keep such a kernel running and disassemble the address range that the dump prints next to each Air
instruction: `gdb -p <pid> -batch -ex "x/60i 0x…"`.

**5. In-app checks (optional).** These need a checkout of index-translator, because they use its ONNX Runtime binding
(`src/onnxruntime-ffi.ts`), its SaT pipeline (`src/sat.ts`) and its docs as the text corpus. The figures above are from
commit `c43083ebc91814c6934571d5f3b64ab8a4d601d9`; another commit has other docs and so slightly different counts. In that
checkout, run `bun scripts/fetch_onnxruntime.ts` (fills `vendor/onnxruntime`), then from here:

```
export INDEX_TRANSLATOR=/path/to/index-translator
bun test/e2e.ts 4                           # boundaries through findBoundaries, ORT vs engine
bun test/bench.ts 4                         # now with an ORT column (the app's binding)
bun test/rss.ts ort; bun test/rss.ts wasm   # resident memory, one engine per process
bun tools/dump_windows.ts                   # ref/windows.bin: 40 real 512-token windows
.venv/bin/python tools/int8_sim.py 7        # boundary flips with 7-bit activations (also try 8, 12)
```

The machine measured was a Cortex-X925 / A725 (20 cores, aarch64 Linux). Absolute timings will differ elsewhere; the ratios
are the finding.
