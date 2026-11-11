# Emits dot.wat (run by probe/run.sh): a 4x16 int8 micro-kernel with i32x4.relaxed_dot_i8x16_i7x16_add_s (one
# instruction per 16 MACs if lowered to sdot) and with i32x4.dot_i16x8_s (standard SIMD, 8 MACs).
def k(name, instr):
    L=[f"(func ${name} (param $a i32) (param $b i32) (param $c i32) (param $k i32)"]
    L+=[f"(local $x{r}{v} v128)" for r in range(4) for v in range(4)]+[f"(local $b{v} v128)" for v in range(4)]+["(local $av v128)","(loop $l"]
    for v in range(4): L.append(f"(local.set $b{v} (v128.load offset={v*16} (local.get $b)))")
    for r in range(4):
        L.append(f"(local.set $av (v128.load32_splat offset={r*1024} (local.get $a)))")
        for v in range(4):
            x=f"$x{r}{v}"
            if instr=="relaxed": L.append(f"(local.set {x} (i32x4.relaxed_dot_i8x16_i7x16_add_s (local.get $b{v}) (local.get $av) (local.get {x})))")
            else: L.append(f"(local.set {x} (i32x4.add (i32x4.dot_i16x8_s (local.get $b{v}) (local.get $av)) (local.get {x})))")
    L+=["(local.set $a (i32.add (local.get $a) (i32.const 4)))","(local.set $b (i32.add (local.get $b) (i32.const 64)))",
        "(br_if $l (local.tee $k (i32.sub (local.get $k) (i32.const 1)))))"]
    L+=[f"(v128.store offset={(r*4+v)*16} (local.get $c) (local.get $x{r}{v}))" for r in range(4) for v in range(4)]
    return "\n".join(L+[")"])
out=['(module (memory 64)',k("rdot","relaxed"),k("dot16","dot16")]
for n in ["rdot","dot16"]:
    out.append(f'(func (export "{n}") (param $n i32) (loop $l (call ${n} (i32.const 0) (i32.const 65536) (i32.const 262144) (i32.const 64)) (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1))))))')
open("dot.wat","w").write("\n".join(out+[")"]))
