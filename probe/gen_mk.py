# Emits mk.wat (run by probe/run.sh): 4xN micro-kernel variants (madd kind, width in vectors, k unroll) with a driver loop.
import sys
def kernel(name, rows, vecs, op, unroll):
    acc = [[f"$x{r}{v}" for v in range(vecs)] for r in range(rows)]
    L = [f"(func ${name} (param $a i32) (param $b i32) (param $c i32) (param $k i32)"]
    L += [f"(local {x} v128)" for row in acc for x in row]
    L += [f"(local $b{v} v128)" for v in range(vecs)] + ["(local $av v128)"]
    L += ["(loop $l"]
    for u in range(unroll):
        for v in range(vecs): L.append(f"(local.set $b{v} (v128.load offset={u*vecs*16 + v*16} (local.get $b)))")
        for r in range(rows):
            L.append(f"(local.set $av (v128.load32_splat offset={r*1024 + u*4} (local.get $a)))")
            for v in range(vecs):
                x = acc[r][v]
                if op == "relaxed": L.append(f"(local.set {x} (f32x4.relaxed_madd (local.get $av) (local.get $b{v}) (local.get {x})))")
                else: L.append(f"(local.set {x} (f32x4.add (f32x4.mul (local.get $av) (local.get $b{v})) (local.get {x})))")
    L += [f"(local.set $a (i32.add (local.get $a) (i32.const {4*unroll})))",
          f"(local.set $b (i32.add (local.get $b) (i32.const {vecs*16*unroll})))",
          f"(br_if $l (local.tee $k (i32.sub (local.get $k) (i32.const {unroll})))))"]
    for r in range(rows):
        for v in range(vecs): L.append(f"(v128.store offset={r*vecs*16 + v*16} (local.get $c) (local.get {acc[r][v]}))")
    L.append(")")
    return "\n".join(L)
variants = [
    # relaxed_madd (JSC/ARM64 lowers it to 3 instructions) against mul + add, and tile shapes
    ("r4x16u1", 4, 4, "relaxed", 1), ("r4x16u2", 4, 4, "relaxed", 2), ("r6x16u1", 6, 4, "relaxed", 1),
    ("m4x16u1", 4, 4, "m", 1), ("m4x16u2", 4, 4, "m", 2), ("m6x16u1", 6, 4, "m", 1), ("m6x16u2", 6, 4, "m", 2),
    ("m8x12u1", 8, 3, "m", 1), ("m5x20u1", 5, 5, "m", 1), ("m4x24u1", 4, 6, "m", 1), ("m6x12u1", 6, 3, "m", 1),
]
out = ["(module (memory (export \"m\") 64)"]
for v in variants: out.append(kernel(*v))
for name, rows, vecs, *_ in variants:
    out.append(f"""(func (export "{name}") (param $n i32) (loop $l (call ${name} (i32.const 0) (i32.const 65536) (i32.const 262144) (i32.const 256))
      (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1))))))""")
out.append(")")
open("mk.wat", "w").write("\n".join(out))
print(" ".join(f"{n}:{r*v*4}" for n, r, v, *_ in variants))
