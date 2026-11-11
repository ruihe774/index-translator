# What the int8 route (relaxed_dot_i8x16_i7x16: activations quantized to 7 bits per block of 32,
# weights as they are) would do to the probabilities, against the f32 forward, on real windows.
import numpy as np, scipy.special as sp, sys
import reference as R
from paths import ROOT
R.erf = sp.erf
# Usage: int8_sim.py [bits]; 7 is what relaxed_dot_i8x16_i7x16 allows (zero point 64 on [0, 127]).
BITS = int(sys.argv[1]) if len(sys.argv) > 1 else 7
TOP = 2 ** (BITS - 1) - 1
def q7(x):  # per 32-block symmetric, scale max|x| / TOP
    s = x.reshape(*x.shape[:-1], -1, 32); m = np.abs(s).max(-1, keepdims=True) / TOP; m[m == 0] = 1
    return (np.clip(np.round(s / m), -TOP - 1, TOP) * m).reshape(x.shape).astype(np.float32)
buf = np.fromfile(f"{ROOT}/ref/windows.bin", np.int32); n = buf[0]; p = 1; wins = []
for _ in range(n): L = buf[p]; wins.append(buf[p + 1:p + 1 + L].astype(np.int64)); p += 1 + L
ids = np.stack(wins); mask = np.ones(ids.shape, np.float32)
base = R.forward(ids, mask)[..., 0]
orig_matmul = np.ndarray.__matmul__
# quantize the left operand of every weight GEMM (x @ W.T with W 2-D and K multiple of 32)
real_deq = R.deq
class QW(np.ndarray): pass
def deq(q, s, zp=128):
    w = real_deq(q, s, zp); return w.view(QW)
def qmatmul(a, b):
    if isinstance(b, QW) or (isinstance(b, np.ndarray) and isinstance(getattr(b, "base", None), QW)):
        return np.matmul(q7(np.asarray(a)), np.asarray(b))
    return np.matmul(np.asarray(a), np.asarray(b))
QW.__rmatmul__ = lambda self, a: qmatmul(a, self)
R.deq = deq
quant = R.forward(ids, mask)[..., 0]
pa, pb = sp.expit(base[:, 1:-1]), sp.expit(quant[:, 1:-1])
print(f"{BITS}-bit activations, {n} windows x 510 tokens; max |Δlogit| {np.abs(base - quant).max():.3f}; max |Δp| {np.abs(pa - pb).max():.4f}")
print(f"flips at p=0.5: {int(((pa > 0.5) != (pb > 0.5)).sum())} of {int((pa > 0.5).sum())} boundaries")
