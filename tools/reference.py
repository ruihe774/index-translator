# Reference forward pass of sat-3l-sm from fixed offsets only, checked against ONNX Runtime.
import json, math, numpy as np, onnxruntime as ort
from paths import MODEL as PATH, ROOT
L = json.load(open(f"{ROOT}/layout.json"))["tensors"]
raw = np.memmap(PATH, dtype=np.uint8, mode="r")
def T(name):
    t = L[name]; dt = {1: np.float32, 2: np.uint8}[t["type"]]
    return np.frombuffer(raw[t["offset"]:t["offset"] + t["bytes"]].tobytes(), dt).reshape(t["dims"])
def deq(q, s, zp=128):  # q [N, K/32, 32] uint8, s [N, K/32] -> W [N, K]
    return ((q.astype(np.float32) - zp) * s[..., None]).reshape(q.shape[0], -1)
def ln(x, g, b, eps=1e-5):
    m = x.mean(-1, keepdims=True); v = ((x - m) ** 2).mean(-1, keepdims=True)
    return (x - m) / np.sqrt(v + eps) * g + b
erf = np.vectorize(math.erf, otypes=[np.float64])
MM = [[429, 430, 433, 439, 440, 441], [442, 443, 446, 452, 453, 454], [455, 456, 459, 465, 466, 467]]
def forward(ids, mask):
    B, S = ids.shape
    q = T("roberta.embeddings.word_embeddings.weight_Q8"); s = T("roberta.embeddings.word_embeddings.weight_scales")
    x = (q[ids].astype(np.float32).reshape(B, S, 24, 32) - 128) * s[ids][..., None]
    x = x.reshape(B, S, 768)
    ne = (ids != 1).astype(np.int64); pos = np.cumsum(ne, 1) * ne + 1
    x = x + T("roberta.embeddings.token_type_embeddings.weight")[0] + T("roberta.embeddings.position_embeddings.weight")[pos]
    p = "roberta.embeddings.LayerNorm."; x = ln(x, T(p + "weight"), T(p + "bias"))
    bias = ((1.0 - mask) * -65504.0)[:, None, None, :].astype(np.float32)
    for l in range(3):
        P = f"roberta.encoder.layer.{l}."
        W = [deq(T(f"onnx::MatMul_{i}_Q8"), T(f"onnx::MatMul_{i}_scales")) for i in MM[l]]
        qh = (x @ W[0].T + T(P + "attention.self.query.bias")).reshape(B, S, 12, 64).transpose(0, 2, 1, 3)
        kh = (x @ W[1].T + T(P + "attention.self.key.bias")).reshape(B, S, 12, 64).transpose(0, 2, 3, 1)
        vh = (x @ W[2].T + T(P + "attention.self.value.bias")).reshape(B, S, 12, 64).transpose(0, 2, 1, 3)
        a = qh @ kh / 8.0 + bias; a = np.exp(a - a.max(-1, keepdims=True)); a /= a.sum(-1, keepdims=True)
        c = (a @ vh).transpose(0, 2, 1, 3).reshape(B, S, 768)
        x = ln(c @ W[3].T + T(P + "attention.output.dense.bias") + x, T(P + "attention.output.LayerNorm.weight"), T(P + "attention.output.LayerNorm.bias"))
        h = x @ W[4].T + T(P + "intermediate.dense.bias"); h = (0.5 * h * (1 + erf(h / math.sqrt(2)))).astype(np.float32)
        x = ln(h @ W[5].T + T(P + "output.dense.bias") + x, T(P + "output.LayerNorm.weight"), T(P + "output.LayerNorm.bias"))
    Wc = deq(T("onnx::MatMul_468_Q8"), T("onnx::MatMul_468_scales"))
    return (x @ Wc.T + T("classifier.bias"))
if __name__ == "__main__":
    rng = np.random.default_rng(0)
    B, S = 3, 40
    ids = rng.integers(3, 250000, (B, S)).astype(np.int64); ids[:, 0] = 0
    mask = np.ones((B, S), np.float32)
    ids[1, 30] = 2; ids[1, 31:] = 0; mask[1, 31:] = 0   # padded as sat.ts pads (id 0, mask 0)
    ids[2, 20] = 1                                       # a <pad> id inside
    sess = ort.InferenceSession(PATH, providers=["CPUExecutionProvider"])
    want = sess.run(["logits"], {"input_ids": ids, "attention_mask": mask})[0]
    got = forward(ids, mask)
    print("shape", want.shape, got.shape)
    m = mask[..., None] > 0
    print("max abs diff (unmasked)", np.abs(want - got)[m].max(), "logit range", want[m].min(), want[m].max())
