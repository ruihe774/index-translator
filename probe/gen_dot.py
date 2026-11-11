# Emits dot.wat (run by probe/run.sh): Rx16 int micro-kernels with i32x4.relaxed_dot_i8x16_i7x16_add_s (16 MACs per
# instruction if lowered to one; sdot on ARM64) and with i32x4.dot_i16x8_s + i32x4.add (standard SIMD, 8 MACs;
# pmaddwd on x86-64). R = 4 is the ARM64 shape (spills on x86-64), R = 2 fits x86-64's 16 XMM registers.
def k(name, R, instr):
    L=[f"(func ${name} (param $a i32) (param $b i32) (param $c i32) (param $k i32)"]
    L+=[f"(local $x{r}{v} v128)" for r in range(R) for v in range(4)]+["(local $av v128)"]+[f"(local $a{r} i32)" for r in range(R)]
    L+=[f"(local.set $a{r} (i32.add (local.get $a) (i32.const {r*1024})))" for r in range(R)]+["(loop $l"]
    for r in range(R):
        L.append(f"(local.set $av (v128.load32_splat (local.get $a{r})))")
        for v in range(4):
            x=f"$x{r}{v}"; b=f"(v128.load offset={v*16} (local.get $b))"
            if instr=="relaxed": L.append(f"(local.set {x} (i32x4.relaxed_dot_i8x16_i7x16_add_s {b} (local.get $av) (local.get {x})))")
            else: L.append(f"(local.set {x} (i32x4.add (i32x4.dot_i16x8_s {b} (local.get $av)) (local.get {x})))")
    L+=[f"(local.set $a{r} (i32.add (local.get $a{r}) (i32.const 4)))" for r in range(R)]
    L+=["(local.set $b (i32.add (local.get $b) (i32.const 64)))","(br_if $l (local.tee $k (i32.sub (local.get $k) (i32.const 1)))))"]
    L+=[f"(v128.store offset={(r*4+v)*16} (local.get $c) (local.get $x{r}{v}))" for r in range(R) for v in range(4)]
    return "\n".join(L+[")"])
variants=[("rdot",4,"relaxed"),("dot16",4,"dot16"),("rdot_r2",2,"relaxed"),("dot16_r2",2,"dot16")]
out=['(module (memory 64)']+[k(n,R,i) for n,R,i in variants]
for n,*_ in variants:
    out.append(f'(func (export "{n}") (param $n i32) (loop $l (call ${n} (i32.const 0) (i32.const 65536) (i32.const 262144) (i32.const 64)) (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1))))))')
open("dot.wat","w").write("\n".join(out+[")"]))
