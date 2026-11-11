# ONNX Runtime (Python, CPU, pinned in requirements.txt) on the same batches as test/bench.ts, for a comparison that
# needs no index-translator checkout. Usage: .venv/bin/python tools/bench_ort.py <threads>
import sys, time
import numpy as np, onnxruntime as ort
from paths import MODEL

threads = int(sys.argv[1]) if len(sys.argv) > 1 else 1
so = ort.SessionOptions()
so.intra_op_num_threads = threads
t0 = time.perf_counter()
sess = ort.InferenceSession(MODEL, so, providers=["CPUExecutionProvider"])
print(f"threads {threads}; load: ort {(time.perf_counter() - t0) * 1000:.0f} ms (onnxruntime {ort.__version__})")
for rows, width in [(1, 32), (1, 128), (1, 512), (8, 512)]:
    i = np.arange(rows * width)
    ids = np.where(i % width == 0, 0, 5 + (i * 7919) % 200000).astype(np.int64).reshape(rows, width)
    feed = {"input_ids": ids, "attention_mask": np.ones((rows, width), np.float32)}
    reps = 3 if rows * width > 1000 else 10
    sess.run(["logits"], feed)
    t0 = time.perf_counter()
    for _ in range(reps):
        sess.run(["logits"], feed)
    print(f"{rows}x{width}: ort {(time.perf_counter() - t0) / reps * 1000:.1f} ms")
