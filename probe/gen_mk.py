# Emits mk.wat (run by probe/run.sh): RxN micro-kernel variants with a driver loop. Name: <op><R>x<N>u<unroll>[<a><b>]
#   op: r = f32x4.relaxed_madd, m = f32x4.mul + f32x4.add
#   a:  o = A splats at a load offset from one pointer (the default), s = one pointer per A row
#   b:  r = B loaded into locals once per k step (the default), m = B loaded at each use
# On x86-64 (16 XMM registers) only tiles with accumulators + B + splat <= 16 stay in registers, and only "s"
# splats become vbroadcastss; on ARM64 (32 registers) neither matters.
import re
def kernel(name, rows, vecs, op, unroll, amode, bmode):
    acc = [[f"$x{r}_{v}" for v in range(vecs)] for r in range(rows)]
    L = [f"(func ${name} (param $a i32) (param $b i32) (param $c i32) (param $k i32)"]
    L += [f"(local {x} v128)" for row in acc for x in row]
    L += [f"(local $b{v} v128)" for v in range(vecs)] + ["(local $av v128)"] + [f"(local $a{r} i32)" for r in range(rows)]
    L += [f"(local.set $a{r} (i32.add (local.get $a) (i32.const {r*1024})))" for r in range(rows)]
    L += ["(loop $l"]
    for u in range(unroll):
        load = lambda v: f"(v128.load offset={u*vecs*16 + v*16} (local.get $b))"
        if bmode == "r":
            L += [f"(local.set $b{v} {load(v)})" for v in range(vecs)]
            bget = lambda v: f"(local.get $b{v})"
        else:
            bget = load
        for r in range(rows):
            src = f"offset={r*1024 + u*4} (local.get $a)" if amode == "o" else f"offset={u*4} (local.get $a{r})"
            L.append(f"(local.set $av (v128.load32_splat {src}))")
            for v in range(vecs):
                x = acc[r][v]
                if op == "r": L.append(f"(local.set {x} (f32x4.relaxed_madd (local.get $av) {bget(v)} (local.get {x})))")
                else: L.append(f"(local.set {x} (f32x4.add (f32x4.mul (local.get $av) {bget(v)}) (local.get {x})))")
    L += [f"(local.set $a (i32.add (local.get $a) (i32.const {4*unroll})))"]
    L += [f"(local.set $a{r} (i32.add (local.get $a{r}) (i32.const {4*unroll})))" for r in range(rows)]
    L += [f"(local.set $b (i32.add (local.get $b) (i32.const {vecs*16*unroll})))",
          f"(br_if $l (local.tee $k (i32.sub (local.get $k) (i32.const {unroll})))))"]
    for r in range(rows):
        for v in range(vecs): L.append(f"(v128.store offset={r*vecs*16 + v*16} (local.get $c) (local.get {acc[r][v]}))")
    L.append(")")
    return "\n".join(L)
names = [
    # relaxed_madd against mul + add (JSC lowers relaxed_madd to 3 instructions on ARM64, to vmulps + vaddps on
    # x86-64), and tile shapes
    "r4x16u1", "r4x16u2", "r6x16u1", "m4x16u1", "m4x16u2", "m6x16u1", "m6x16u2", "m8x12u1", "m5x20u1", "m4x24u1",
    "m6x12u1",
    # x86-64: register-sized tiles, A splats from their own pointers, B at each use (src/sat.wat uses m2x16u1sm)
    "m4x8u1", "m4x8u1sm", "m6x8u1sm", "m4x12u1sm", "m3x12u1sm", "m2x16u1sm", "m3x16u1sm", "m4x16u1sm", "r2x16u1sm",
]
variants = []
for n in names:
    op, rows, cols, unroll, amode, bmode = re.fullmatch(r"([mr])(\d+)x(\d+)u(\d+)([os]?)([rm]?)", n).groups()
    variants.append((n, int(rows), int(cols) // 4, op, int(unroll), amode or "o", bmode or "r"))
out = ["(module (memory (export \"m\") 64)"]
for v in variants: out.append(kernel(*v))
for name, rows, vecs, *_ in variants:
    out.append(f"""(func (export "{name}") (param $n i32) (loop $l (call ${name} (i32.const 0) (i32.const 65536) (i32.const 262144) (i32.const 256))
      (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1))))))""")
out.append(")")
open("mk.wat", "w").write("\n".join(out))
print(" ".join(f"{n}:{r*v*4}" for n, r, v, *_ in variants))
