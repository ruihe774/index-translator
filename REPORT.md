# Spike: sat-3l-sm on a hand-written WASM kernel instead of ONNX Runtime

Verdict: **feasible and exact, but about 3× slower than ORT** on this machine (Cortex-X925, aarch64, Bun 1.4.4).
Memory is the same. The slowdown comes from how JSC compiles WASM SIMD here (details below), not from the design.

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
| `src/sat.wat` (707 lines, 5.2 KB `.wasm`) | the forward pass: blocked f32 GEMM (4×16 SIMD micro-kernel, K blocks of 256, int8→f32 dequant while packing), attention, LayerNorm, SIMD exp / erf-GELU, a thread pool on shared memory (`memory.atomic.wait32/notify`, tasks claimed with a generation-tagged CAS counter) |
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

**Speed** (`test/bench.ts`, ms per call, app's ORT 1.31 via bun:ffi)

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

- The GEMM micro-kernel runs at **45–49 GFLOPS** whatever the tile shape (`probe/gen_mk.py`). That is the FP-pipe
  ceiling for *unfused* `f32x4.mul` + `f32x4.add`. ORT's native kernels use FMA and reach about 110 GFLOPS single-threaded.
- `f32x4.relaxed_madd` should give FMA, but JSC on ARM64 lowers it to `VectorFusedMulAdd` through a scratch register,
  3 instructions per op. It is *slower* (33 GFLOPS) than mul+add, so the kernel uses mul+add. If JSC fixes this lowering,
  the f32 path roughly doubles. x86-64 was **not measured**: there JSC may lower `relaxed_madd` well, but there are only
  16 XMM registers, so the 4×16 tile would spill and need a 4×8 or 6×8 variant.
- `i32x4.relaxed_dot_i8x16_i7x16_add_s` *is* lowered well: about **300 GOPS**, 6× the f32 kernel. But it needs
  activations quantized to 7 bits. Simulated on 40 real windows (`tools/int8_sim.py`), 7-bit activations flip 7 of 276
  boundaries and 8-bit ones flip 7 too. 12-bit would flip none, but that doesn't fit the instruction. So this route is only
  possible with mixed precision for outlier blocks, and it no longer matches ORT bit for bit; it would be a project of
  its own.
- Smaller remaining overheads: the gap between the kernel ceiling and the end-to-end rate (35 vs 45 GFLOPS), mostly in
  attention (K=64 micro-kernel calls, a scalar K transpose per row block) and packing. Optimizing these could bring the gap
  to about 2.3×, not lower.

## Not done (out of scope or left open)

Wiring into index-translator; Windows/x64 measurement; aborting mid-batch (the TS loop could check between rows);
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
```

Python ORT 1.31.1 gave the same timings as the app's ORT 1.31.0 through bun:ffi (for example 55 vs 54 ms for 1×512 with 4
threads). To see the relaxed_madd lowering, run a kernel with `BUN_JSC_dumpWasmDisassembly=1 BUN_JSC_dumpOMGDisassembly=1`.
Bun's build has no disassembler, but the Air IR it prints shows `VectorFusedMulAdd` going through a scratch register.

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
