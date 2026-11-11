# Walks the protobuf by hand (ModelProto.graph=7, GraphProto.initializer=5, TensorProto: dims=1,
# data_type=2, name=8, raw_data=9) and prints where each initializer's raw bytes sit in model.onnx.
import json, mmap, sys
from paths import MODEL as PATH, ROOT
f = open(PATH, "rb"); buf = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
def varint(p):
    r = s = 0
    while True:
        b = buf[p]; p += 1; r |= (b & 0x7F) << s; s += 7
        if b < 0x80: return r, p
def fields(start, end):
    p = start
    while p < end:
        key, p = varint(p); fn, wt = key >> 3, key & 7
        if wt == 0: v, p = varint(p); yield fn, wt, v, None
        elif wt == 2: n, p = varint(p); yield fn, wt, p, p + n; p += n
        elif wt == 1: yield fn, wt, p, None; p += 8
        elif wt == 5: yield fn, wt, p, None; p += 4
        else: raise ValueError(wt)
out = {}
for fn, wt, a, b in fields(0, len(buf)):
    if fn != 7: continue
    for gfn, gwt, ga, gb in fields(a, b):
        if gfn != 5: continue
        t = {"dims": []}
        for tfn, twt, ta, tb in fields(ga, gb):
            if tfn == 1:
                if twt == 0: t["dims"].append(ta)
                else:
                    p = ta
                    while p < tb: v, p = varint(p); t["dims"].append(v)
            elif tfn == 2: t["type"] = ta
            elif tfn == 8: t["name"] = bytes(buf[ta:tb]).decode()
            elif tfn == 9: t["offset"] = ta; t["bytes"] = tb - ta
        out[t.pop("name")] = t
json.dump({"size": len(buf), "tensors": out}, open(f"{ROOT}/layout.json", "w"), indent=1)
print(len(out), "tensors; file size", len(buf))
for k, v in list(out.items())[:3] + list(out.items())[-2:]: print(k, v)
