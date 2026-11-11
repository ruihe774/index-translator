# Random batches (padded the way sat.ts pads: id 0, mask 0) run through ONNX Runtime; written to
# ref/case_<n>.bin as: rows, width (i32), ids (i64), mask (f32), logits (f32).
import numpy as np, onnxruntime as ort, os
from paths import MODEL as PATH, ROOT
os.makedirs(f"{ROOT}/ref", exist_ok=True)
so = ort.SessionOptions(); so.intra_op_num_threads = 4
sess = ort.InferenceSession(PATH, so, providers=["CPUExecutionProvider"])
rng = np.random.default_rng(1)
cases = [(1, 7), (3, 40), (2, 512), (8, 130), (4, 333)]
for n, (rows, width) in enumerate(cases):
    ids = rng.integers(3, 250002, (rows, width)).astype(np.int64)
    mask = np.ones((rows, width), np.float32)
    for r in range(rows):
        L = width if r == 0 else int(rng.integers(3, width + 1))
        ids[r, 0] = 0; ids[r, L - 1] = 2; ids[r, L:] = 0; mask[r, L:] = 0
        if L > 10: ids[r, 5] = 1  # a <pad> id among real tokens
    logits = sess.run(["logits"], {"input_ids": ids, "attention_mask": mask})[0].astype(np.float32)
    with open(f"{ROOT}/ref/case_{n}.bin", "wb") as f:
        f.write(np.array([rows, width], np.int32).tobytes()); f.write(ids.tobytes()); f.write(mask.tobytes()); f.write(logits.tobytes())
print("written", len(cases))
