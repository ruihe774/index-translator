;; A specialized forward pass of sat-3l-sm (XLM-RoBERTa embeddings, 3 encoder layers, 1-logit token
;; classifier), as exported to ONNX by onnxruntime.transformers with 8-bit block quantization
;; (MatMulNBits / GatherBlockQuantized, block 32, no zero points, so zero point 128).
;;
;; One sequence per `forward(S)`: ids and mask at $IDS / $MASK, logits out at $LOGITS. The weights are
;; copied into memory by the host, which also writes the address of each tensor into the slot table at
;; $SLOTS (slot order: see tensors.ts). Work is cut into tasks; with more than one thread the tasks of a
;; step are shared, through the control block, with workers running `worker(tid)` on the same memory.
;;
;; Memory map (bytes):
;;   0       control block (i32): 0 GEN, 4 NEXT, 8 OP, 12 NT, 16 DONE, 20 QUIT, 24 NTHREADS, 28 S, 32 SP, 36 LAYER
;;   1024    slot table, 75 x i32 tensor addresses
;;   4096    ids    i32[512]
;;   6144    mask   f32[512]
;;   8192    attention bias f32[512]: (1 - mask) * -65504
;;   10240   position ids i32[512]
;;   12288   logits f32[512]
;;   14336   zeros f32[16]
;;   14400   classifier weights, dequantized, f32[768]
;;   0x10000 X, Q, K, V, CTX, TMP: f32[512][768] each (0x180000 bytes)
;;   0x910000 H: f32[512][3072]
;;   0xF10000 per-thread scratch, 16 x 0x50000 (packed panel / K transposed, then attention scores)
;;   0x1410000 weights
(module
  (import "env" "memory" (memory 1 65536 shared))

  (global $tid (mut i32) (i32.const 0))

  (global (export "IDS") i32 (i32.const 4096))
  (global (export "MASK") i32 (i32.const 6144))
  (global (export "LOGITS") i32 (i32.const 12288))
  (global (export "SLOTS") i32 (i32.const 1024))
  (global (export "CTRL") i32 (i32.const 0))
  (global (export "WEIGHTS") i32 (i32.const 0x1410000))
  (global (export "MAX_THREADS") i32 (i32.const 16))
  (global (export "MAX_SEQ") i32 (i32.const 512))

  ;; control block
  (global $GEN i32 (i32.const 0))
  (global $NEXT i32 (i32.const 4))
  (global $OP i32 (i32.const 8))
  (global $NT i32 (i32.const 12))
  (global $DONE i32 (i32.const 16))
  (global $QUIT i32 (i32.const 20))
  (global $NTH i32 (i32.const 24))
  (global $S i32 (i32.const 28))
  (global $SP i32 (i32.const 32))
  (global $LAYER i32 (i32.const 36))

  (global $SLOTS i32 (i32.const 1024))
  (global $IDS i32 (i32.const 4096))
  (global $MASK i32 (i32.const 6144))
  (global $BIAS i32 (i32.const 8192))
  (global $POS i32 (i32.const 10240))
  (global $LOGITS i32 (i32.const 12288))
  (global $ZERO i32 (i32.const 14336))
  (global $WC i32 (i32.const 14400))
  (global $X i32 (i32.const 0x10000))
  (global $Q i32 (i32.const 0x190000))
  (global $K i32 (i32.const 0x310000))
  (global $V i32 (i32.const 0x490000))
  (global $CTX i32 (i32.const 0x610000))
  (global $TMP i32 (i32.const 0x790000))
  (global $H i32 (i32.const 0x910000))
  (global $SCR i32 (i32.const 0xF10000))
  (global $SCR_STRIDE i32 (i32.const 0x50000))
  (global $SCORES_AT i32 (i32.const 0x30000)) ;; within a thread's scratch
  (global $BUF i32 (i32.const 0x180000))       ;; size of X, Q, ...

  ;; GEMM K block
  (global $KC i32 (i32.const 256))

  ;; ops
  (global $OP_EMBED i32 (i32.const 0))
  (global $OP_QKV i32 (i32.const 1))
  (global $OP_ATTN i32 (i32.const 2))
  (global $OP_OPROJ i32 (i32.const 3))
  (global $OP_LN1 i32 (i32.const 4))
  (global $OP_FF1 i32 (i32.const 5))
  (global $OP_FF2 i32 (i32.const 6))
  (global $OP_LN2 i32 (i32.const 7))

  (func $slot (param $i i32) (result i32)
    (i32.load (i32.add (global.get $SLOTS) (i32.shl (local.get $i) (i32.const 2)))))

  ;; ---------------------------------------------------------------- math

  ;; e^x for x <= 0 (0 below -87.3), Cephes-style range reduction, degree-6 polynomial.
  (func $exp4 (param $x v128) (result v128)
    (local $n v128) (local $r v128) (local $p v128) (local $under v128)
    (local.set $under (f32x4.lt (local.get $x) (v128.const f32x4 -87.3 -87.3 -87.3 -87.3)))
    (local.set $x (f32x4.max (local.get $x) (v128.const f32x4 -87.3 -87.3 -87.3 -87.3)))
    (local.set $n (f32x4.nearest (f32x4.mul (local.get $x)
      (v128.const f32x4 1.44269504 1.44269504 1.44269504 1.44269504))))
    (local.set $r (f32x4.sub (local.get $x) (f32x4.mul (local.get $n)
      (v128.const f32x4 0.693359375 0.693359375 0.693359375 0.693359375))))
    (local.set $r (f32x4.sub (local.get $r) (f32x4.mul (local.get $n)
      (v128.const f32x4 -2.12194440e-4 -2.12194440e-4 -2.12194440e-4 -2.12194440e-4))))
    (local.set $p (v128.const f32x4 1.3888889e-3 1.3888889e-3 1.3888889e-3 1.3888889e-3))
    (local.set $p (f32x4.add (f32x4.mul (local.get $p) (local.get $r))
      (v128.const f32x4 8.3333333e-3 8.3333333e-3 8.3333333e-3 8.3333333e-3)))
    (local.set $p (f32x4.add (f32x4.mul (local.get $p) (local.get $r))
      (v128.const f32x4 4.1666667e-2 4.1666667e-2 4.1666667e-2 4.1666667e-2)))
    (local.set $p (f32x4.add (f32x4.mul (local.get $p) (local.get $r))
      (v128.const f32x4 0.16666667 0.16666667 0.16666667 0.16666667)))
    (local.set $p (f32x4.add (f32x4.mul (local.get $p) (local.get $r))
      (v128.const f32x4 0.5 0.5 0.5 0.5)))
    (local.set $p (f32x4.add (f32x4.mul (local.get $p) (local.get $r))
      (v128.const f32x4 1 1 1 1)))
    (local.set $p (f32x4.add (f32x4.mul (local.get $p) (local.get $r))
      (v128.const f32x4 1 1 1 1)))
    (v128.andnot
      (f32x4.mul (local.get $p)
        (i32x4.shl (i32x4.add (i32x4.trunc_sat_f32x4_s (local.get $n)) (v128.const i32x4 127 127 127 127))
          (i32.const 23)))
      (local.get $under)))

  ;; x * Phi(x) with erf from Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7), no cancellation for x < 0.
  (func $gelu4 (param $x v128) (result v128)
    (local $z v128) (local $t v128) (local $p v128) (local $e v128)
    (local.set $z (f32x4.mul (f32x4.abs (local.get $x))
      (v128.const f32x4 0.70710678 0.70710678 0.70710678 0.70710678)))
    (local.set $t (f32x4.div (v128.const f32x4 1 1 1 1)
      (f32x4.add (v128.const f32x4 1 1 1 1)
        (f32x4.mul (local.get $z) (v128.const f32x4 0.3275911 0.3275911 0.3275911 0.3275911)))))
    (local.set $p (v128.const f32x4 1.061405429 1.061405429 1.061405429 1.061405429))
    (local.set $p (f32x4.add (f32x4.mul (local.get $p) (local.get $t))
      (v128.const f32x4 -1.453152027 -1.453152027 -1.453152027 -1.453152027)))
    (local.set $p (f32x4.add (f32x4.mul (local.get $p) (local.get $t))
      (v128.const f32x4 1.421413741 1.421413741 1.421413741 1.421413741)))
    (local.set $p (f32x4.add (f32x4.mul (local.get $p) (local.get $t))
      (v128.const f32x4 -0.284496736 -0.284496736 -0.284496736 -0.284496736)))
    (local.set $p (f32x4.add (f32x4.mul (local.get $p) (local.get $t))
      (v128.const f32x4 0.254829592 0.254829592 0.254829592 0.254829592)))
    (local.set $p (f32x4.mul (local.get $p) (local.get $t)))
    ;; e = erfc(|x| / sqrt 2)
    (local.set $e (f32x4.mul (local.get $p)
      (call $exp4 (f32x4.neg (f32x4.mul (local.get $z) (local.get $z))))))
    ;; 1 + erf(x / sqrt 2) = x < 0 ? e : 2 - e
    (f32x4.mul (f32x4.mul (local.get $x) (v128.const f32x4 0.5 0.5 0.5 0.5))
      (v128.bitselect (local.get $e)
        (f32x4.sub (v128.const f32x4 2 2 2 2) (local.get $e))
        (f32x4.lt (local.get $x) (v128.const f32x4 0 0 0 0)))))

  (func $hsum (param $v v128) (result f32)
    (f32.add
      (f32.add (f32x4.extract_lane 0 (local.get $v)) (f32x4.extract_lane 1 (local.get $v)))
      (f32.add (f32x4.extract_lane 2 (local.get $v)) (f32x4.extract_lane 3 (local.get $v)))))

  (func $hmax (param $v v128) (result f32)
    (f32.max
      (f32.max (f32x4.extract_lane 0 (local.get $v)) (f32x4.extract_lane 1 (local.get $v)))
      (f32.max (f32x4.extract_lane 2 (local.get $v)) (f32x4.extract_lane 3 (local.get $v)))))

  ;; In-place LayerNorm of one 768-wide row, epsilon 1e-5.
  (func $ln (param $p i32) (param $g i32) (param $b i32)
    (local $i i32) (local $acc v128) (local $mean v128) (local $inv v128) (local $d v128)
    (local.set $acc (v128.const f32x4 0 0 0 0))
    (local.set $i (i32.const 0))
    (loop $sum
      (local.set $acc (f32x4.add (local.get $acc) (v128.load (i32.add (local.get $p) (local.get $i)))))
      (br_if $sum (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 16))) (i32.const 3072))))
    (local.set $mean (f32x4.splat (f32.div (call $hsum (local.get $acc)) (f32.const 768))))
    (local.set $acc (v128.const f32x4 0 0 0 0))
    (local.set $i (i32.const 0))
    (loop $var
      (local.set $d (f32x4.sub (v128.load (i32.add (local.get $p) (local.get $i))) (local.get $mean)))
      (local.set $acc (f32x4.add (local.get $acc) (f32x4.mul (local.get $d) (local.get $d))))
      (br_if $var (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 16))) (i32.const 3072))))
    (local.set $inv (f32x4.splat (f32.div (f32.const 1)
      (f32.sqrt (f32.add (f32.div (call $hsum (local.get $acc)) (f32.const 768)) (f32.const 1e-5))))))
    (local.set $i (i32.const 0))
    (loop $norm
      (v128.store (i32.add (local.get $p) (local.get $i))
        (f32x4.add
          (f32x4.mul
            (f32x4.mul (f32x4.sub (v128.load (i32.add (local.get $p) (local.get $i))) (local.get $mean))
              (local.get $inv))
            (v128.load (i32.add (local.get $g) (local.get $i))))
          (v128.load (i32.add (local.get $b) (local.get $i)))))
      (br_if $norm (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 16))) (i32.const 3072)))))

  ;; ---------------------------------------------------------------- GEMM

  ;; C[4][16] (=|+=) A[4][k] . B[k][16]. Strides in bytes. Rows start from `bias` (16 floats, every row)
  ;; unless `acc`, then from C. With `gelu`, GELU is applied before the store.
  (func $mk (param $a i32) (param $lda i32) (param $b i32) (param $ldb i32)
            (param $c i32) (param $ldc i32) (param $k i32) (param $acc i32) (param $bias i32) (param $gelu i32)
    (local $a1 i32) (local $a2 i32) (local $a3 i32) (local $c1 i32) (local $c2 i32) (local $c3 i32)
    (local $x00 v128) (local $x01 v128) (local $x02 v128) (local $x03 v128)
    (local $x10 v128) (local $x11 v128) (local $x12 v128) (local $x13 v128)
    (local $x20 v128) (local $x21 v128) (local $x22 v128) (local $x23 v128)
    (local $x30 v128) (local $x31 v128) (local $x32 v128) (local $x33 v128)
    (local $b0 v128) (local $b1 v128) (local $b2 v128) (local $b3 v128) (local $av v128)
    (local.set $a1 (i32.add (local.get $a) (local.get $lda)))
    (local.set $a2 (i32.add (local.get $a1) (local.get $lda)))
    (local.set $a3 (i32.add (local.get $a2) (local.get $lda)))
    (local.set $c1 (i32.add (local.get $c) (local.get $ldc)))
    (local.set $c2 (i32.add (local.get $c1) (local.get $ldc)))
    (local.set $c3 (i32.add (local.get $c2) (local.get $ldc)))
    (if (local.get $acc)
      (then
        (local.set $x00 (v128.load offset=0 (local.get $c)))
        (local.set $x01 (v128.load offset=16 (local.get $c)))
        (local.set $x02 (v128.load offset=32 (local.get $c)))
        (local.set $x03 (v128.load offset=48 (local.get $c)))
        (local.set $x10 (v128.load offset=0 (local.get $c1)))
        (local.set $x11 (v128.load offset=16 (local.get $c1)))
        (local.set $x12 (v128.load offset=32 (local.get $c1)))
        (local.set $x13 (v128.load offset=48 (local.get $c1)))
        (local.set $x20 (v128.load offset=0 (local.get $c2)))
        (local.set $x21 (v128.load offset=16 (local.get $c2)))
        (local.set $x22 (v128.load offset=32 (local.get $c2)))
        (local.set $x23 (v128.load offset=48 (local.get $c2)))
        (local.set $x30 (v128.load offset=0 (local.get $c3)))
        (local.set $x31 (v128.load offset=16 (local.get $c3)))
        (local.set $x32 (v128.load offset=32 (local.get $c3)))
        (local.set $x33 (v128.load offset=48 (local.get $c3))))
      (else
        (local.set $x00 (v128.load offset=0 (local.get $bias)))
        (local.set $x01 (v128.load offset=16 (local.get $bias)))
        (local.set $x02 (v128.load offset=32 (local.get $bias)))
        (local.set $x03 (v128.load offset=48 (local.get $bias)))
        (local.set $x10 (local.get $x00)) (local.set $x11 (local.get $x01))
        (local.set $x12 (local.get $x02)) (local.set $x13 (local.get $x03))
        (local.set $x20 (local.get $x00)) (local.set $x21 (local.get $x01))
        (local.set $x22 (local.get $x02)) (local.set $x23 (local.get $x03))
        (local.set $x30 (local.get $x00)) (local.set $x31 (local.get $x01))
        (local.set $x32 (local.get $x02)) (local.set $x33 (local.get $x03))))
    (block $done
      (br_if $done (i32.eqz (local.get $k)))
      (loop $l
        (local.set $b0 (v128.load offset=0 (local.get $b)))
        (local.set $b1 (v128.load offset=16 (local.get $b)))
        (local.set $b2 (v128.load offset=32 (local.get $b)))
        (local.set $b3 (v128.load offset=48 (local.get $b)))
        (local.set $av (v128.load32_splat (local.get $a)))
        (local.set $x00 (f32x4.add (f32x4.mul (local.get $av) (local.get $b0)) (local.get $x00)))
        (local.set $x01 (f32x4.add (f32x4.mul (local.get $av) (local.get $b1)) (local.get $x01)))
        (local.set $x02 (f32x4.add (f32x4.mul (local.get $av) (local.get $b2)) (local.get $x02)))
        (local.set $x03 (f32x4.add (f32x4.mul (local.get $av) (local.get $b3)) (local.get $x03)))
        (local.set $av (v128.load32_splat (local.get $a1)))
        (local.set $x10 (f32x4.add (f32x4.mul (local.get $av) (local.get $b0)) (local.get $x10)))
        (local.set $x11 (f32x4.add (f32x4.mul (local.get $av) (local.get $b1)) (local.get $x11)))
        (local.set $x12 (f32x4.add (f32x4.mul (local.get $av) (local.get $b2)) (local.get $x12)))
        (local.set $x13 (f32x4.add (f32x4.mul (local.get $av) (local.get $b3)) (local.get $x13)))
        (local.set $av (v128.load32_splat (local.get $a2)))
        (local.set $x20 (f32x4.add (f32x4.mul (local.get $av) (local.get $b0)) (local.get $x20)))
        (local.set $x21 (f32x4.add (f32x4.mul (local.get $av) (local.get $b1)) (local.get $x21)))
        (local.set $x22 (f32x4.add (f32x4.mul (local.get $av) (local.get $b2)) (local.get $x22)))
        (local.set $x23 (f32x4.add (f32x4.mul (local.get $av) (local.get $b3)) (local.get $x23)))
        (local.set $av (v128.load32_splat (local.get $a3)))
        (local.set $x30 (f32x4.add (f32x4.mul (local.get $av) (local.get $b0)) (local.get $x30)))
        (local.set $x31 (f32x4.add (f32x4.mul (local.get $av) (local.get $b1)) (local.get $x31)))
        (local.set $x32 (f32x4.add (f32x4.mul (local.get $av) (local.get $b2)) (local.get $x32)))
        (local.set $x33 (f32x4.add (f32x4.mul (local.get $av) (local.get $b3)) (local.get $x33)))
        (local.set $a (i32.add (local.get $a) (i32.const 4)))
        (local.set $a1 (i32.add (local.get $a1) (i32.const 4)))
        (local.set $a2 (i32.add (local.get $a2) (i32.const 4)))
        (local.set $a3 (i32.add (local.get $a3) (i32.const 4)))
        (local.set $b (i32.add (local.get $b) (local.get $ldb)))
        (br_if $l (local.tee $k (i32.sub (local.get $k) (i32.const 1))))))
    (if (local.get $gelu)
      (then
        (local.set $x00 (call $gelu4 (local.get $x00))) (local.set $x01 (call $gelu4 (local.get $x01)))
        (local.set $x02 (call $gelu4 (local.get $x02))) (local.set $x03 (call $gelu4 (local.get $x03)))
        (local.set $x10 (call $gelu4 (local.get $x10))) (local.set $x11 (call $gelu4 (local.get $x11)))
        (local.set $x12 (call $gelu4 (local.get $x12))) (local.set $x13 (call $gelu4 (local.get $x13)))
        (local.set $x20 (call $gelu4 (local.get $x20))) (local.set $x21 (call $gelu4 (local.get $x21)))
        (local.set $x22 (call $gelu4 (local.get $x22))) (local.set $x23 (call $gelu4 (local.get $x23)))
        (local.set $x30 (call $gelu4 (local.get $x30))) (local.set $x31 (call $gelu4 (local.get $x31)))
        (local.set $x32 (call $gelu4 (local.get $x32))) (local.set $x33 (call $gelu4 (local.get $x33)))))
    (v128.store offset=0 (local.get $c) (local.get $x00))
    (v128.store offset=16 (local.get $c) (local.get $x01))
    (v128.store offset=32 (local.get $c) (local.get $x02))
    (v128.store offset=48 (local.get $c) (local.get $x03))
    (v128.store offset=0 (local.get $c1) (local.get $x10))
    (v128.store offset=16 (local.get $c1) (local.get $x11))
    (v128.store offset=32 (local.get $c1) (local.get $x12))
    (v128.store offset=48 (local.get $c1) (local.get $x13))
    (v128.store offset=0 (local.get $c2) (local.get $x20))
    (v128.store offset=16 (local.get $c2) (local.get $x21))
    (v128.store offset=32 (local.get $c2) (local.get $x22))
    (v128.store offset=48 (local.get $c2) (local.get $x23))
    (v128.store offset=0 (local.get $c3) (local.get $x30))
    (v128.store offset=16 (local.get $c3) (local.get $x31))
    (v128.store offset=32 (local.get $c3) (local.get $x32))
    (v128.store offset=48 (local.get $c3) (local.get $x33)))

  ;; Rewrites one quantized N x K matrix in place, once, into panels of 16 output columns:
  ;; weights [N/16][K][16] int8 (q - 128), scales [N/16][K/32][16] f32. H and TMP serve as scratch.
  (func $to_panels (param $wq i32) (param $ws i32) (param $N i32) (param $K i32)
    (local $n i32) (local $k i32) (local $kb i32) (local $nb i32)
    (local.set $nb (i32.shr_u (local.get $K) (i32.const 5)))
    (loop $rows
      (local.set $k (i32.const 0))
      (loop $cols
        ;; W[n][k] -> T[n/16][k][n%16]
        (i32.store8
          (i32.add (global.get $H) (i32.add
            (i32.mul (i32.shr_u (local.get $n) (i32.const 4)) (i32.shl (local.get $K) (i32.const 4)))
            (i32.add (i32.shl (local.get $k) (i32.const 4)) (i32.and (local.get $n) (i32.const 15)))))
          (i32.xor (i32.load8_u (i32.add (local.get $wq) (i32.add (i32.mul (local.get $n) (local.get $K)) (local.get $k))))
            (i32.const 0x80)))
        (br_if $cols (i32.lt_u (local.tee $k (i32.add (local.get $k) (i32.const 1))) (local.get $K))))
      (local.set $kb (i32.const 0))
      (loop $blocks
        (f32.store
          (i32.add (global.get $TMP) (i32.shl (i32.add
            (i32.mul (i32.shr_u (local.get $n) (i32.const 4)) (i32.shl (local.get $nb) (i32.const 4)))
            (i32.add (i32.shl (local.get $kb) (i32.const 4)) (i32.and (local.get $n) (i32.const 15)))) (i32.const 2)))
          (f32.load (i32.add (local.get $ws)
            (i32.shl (i32.add (i32.mul (local.get $n) (local.get $nb)) (local.get $kb)) (i32.const 2)))))
        (br_if $blocks (i32.lt_u (local.tee $kb (i32.add (local.get $kb) (i32.const 1))) (local.get $nb))))
      (br_if $rows (i32.lt_u (local.tee $n (i32.add (local.get $n) (i32.const 1))) (local.get $N))))
    (memory.copy (local.get $wq) (global.get $H) (i32.mul (local.get $N) (local.get $K)))
    (memory.copy (local.get $ws) (global.get $TMP) (i32.shl (i32.mul (local.get $N) (local.get $nb)) (i32.const 2))))

  ;; Once after the weights are in: the 18 encoder matrices into panels.
  (func (export "prepare")
    (local $l i32) (local $m i32) (local $base i32) (local $N i32) (local $K i32)
    (loop $layers
      (local.set $base (i32.add (i32.const 6) (i32.mul (local.get $l) (i32.const 22))))
      (local.set $m (i32.const 0))
      (loop $mats
        ;; q k v o: 768 x 768; ff1: 3072 x 768; ff2: 768 x 3072
        (local.set $N (select (i32.const 3072) (i32.const 768) (i32.eq (local.get $m) (i32.const 4))))
        (local.set $K (select (i32.const 3072) (i32.const 768) (i32.eq (local.get $m) (i32.const 5))))
        (call $to_panels
          (call $slot (i32.add (local.get $base) (i32.shl (local.get $m) (i32.const 1))))
          (call $slot (i32.add (local.get $base) (i32.add (i32.shl (local.get $m) (i32.const 1)) (i32.const 1))))
          (local.get $N) (local.get $K))
        (br_if $mats (i32.lt_u (local.tee $m (i32.add (local.get $m) (i32.const 1))) (i32.const 6))))
      (br_if $layers (i32.lt_u (local.tee $l (i32.add (local.get $l) (i32.const 1))) (i32.const 3)))))

  ;; Dequantizes panel n0/16, rows kb .. kb+kc, into dst[kc][16] (layout of $to_panels).
  (func $pack (param $wq i32) (param $ws i32) (param $K i32) (param $n0 i32) (param $kb i32) (param $kc i32)
              (param $dst i32)
    (local $src i32) (local $sc i32) (local $end i32) (local $k i32)
    (local $q v128) (local $lo v128) (local $hi v128)
    (local $s0 v128) (local $s1 v128) (local $s2 v128) (local $s3 v128)
    ;; panel base: n0/16 * K * 16 = n0 * K
    (local.set $src (i32.add (local.get $wq) (i32.add (i32.mul (local.get $n0) (local.get $K)) (i32.shl (local.get $kb) (i32.const 4)))))
    (local.set $sc (i32.add (local.get $ws) (i32.shl (i32.add (i32.mul (local.get $n0) (i32.shr_u (local.get $K) (i32.const 5)))
      (i32.shl (i32.shr_u (local.get $kb) (i32.const 5)) (i32.const 4))) (i32.const 2))))
    (local.set $k (i32.const 0))
    (loop $l
      (if (i32.eqz (i32.and (local.get $k) (i32.const 31)))
        (then
          (local.set $s0 (v128.load offset=0 (local.get $sc)))
          (local.set $s1 (v128.load offset=16 (local.get $sc)))
          (local.set $s2 (v128.load offset=32 (local.get $sc)))
          (local.set $s3 (v128.load offset=48 (local.get $sc)))
          (local.set $sc (i32.add (local.get $sc) (i32.const 64)))))
      (local.set $q (v128.load (local.get $src)))
      (local.set $lo (i16x8.extend_low_i8x16_s (local.get $q)))
      (local.set $hi (i16x8.extend_high_i8x16_s (local.get $q)))
      (v128.store offset=0 (local.get $dst)
        (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_low_i16x8_s (local.get $lo))) (local.get $s0)))
      (v128.store offset=16 (local.get $dst)
        (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_high_i16x8_s (local.get $lo))) (local.get $s1)))
      (v128.store offset=32 (local.get $dst)
        (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_low_i16x8_s (local.get $hi))) (local.get $s2)))
      (v128.store offset=48 (local.get $dst)
        (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_high_i16x8_s (local.get $hi))) (local.get $s3)))
      (local.set $src (i32.add (local.get $src) (i32.const 16)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 64)))
      (br_if $l (i32.lt_u (local.tee $k (i32.add (local.get $k) (i32.const 1))) (local.get $kc)))))

  ;; C[0..SP][n0..n0+16] = A[SP][K] . W^T + bias (then GELU), W quantized N x K. ldc in floats.
  (func $gemm_panel (param $a i32) (param $K i32) (param $wq i32) (param $ws i32) (param $bias i32)
                    (param $c i32) (param $ldc i32) (param $n0 i32) (param $gelu i32)
    (local $pack i32) (local $kb i32) (local $m i32) (local $sp i32) (local $last i32)
    (local $lda i32) (local $ldcb i32) (local $cp i32) (local $ap i32)
    (local.set $pack (i32.add (global.get $SCR) (i32.mul (global.get $tid) (global.get $SCR_STRIDE))))
    (local.set $sp (i32.load (global.get $SP)))
    (local.set $lda (i32.shl (local.get $K) (i32.const 2)))
    (local.set $ldcb (i32.shl (local.get $ldc) (i32.const 2)))
    (loop $kblocks
      (call $pack (local.get $wq) (local.get $ws) (local.get $K) (local.get $n0) (local.get $kb)
        (global.get $KC) (local.get $pack))
      (local.set $last (i32.ge_u (i32.add (local.get $kb) (global.get $KC)) (local.get $K)))
      (local.set $m (i32.const 0))
      (local.set $cp (i32.add (local.get $c) (i32.shl (local.get $n0) (i32.const 2))))
      (local.set $ap (i32.add (local.get $a) (i32.shl (local.get $kb) (i32.const 2))))
      (loop $rows
        (call $mk (local.get $ap) (local.get $lda) (local.get $pack) (i32.const 64)
          (local.get $cp) (local.get $ldcb) (global.get $KC)
          (local.get $kb) ;; accumulate after the first block
          (i32.add (local.get $bias) (i32.shl (local.get $n0) (i32.const 2)))
          (i32.and (local.get $gelu) (local.get $last)))
        (local.set $ap (i32.add (local.get $ap) (i32.shl (local.get $lda) (i32.const 2))))
        (local.set $cp (i32.add (local.get $cp) (i32.shl (local.get $ldcb) (i32.const 2))))
        (br_if $rows (i32.lt_u (local.tee $m (i32.add (local.get $m) (i32.const 4))) (local.get $sp))))
      (br_if $kblocks (i32.lt_u (local.tee $kb (i32.add (local.get $kb) (global.get $KC))) (local.get $K)))))

  ;; ---------------------------------------------------------------- steps

  ;; x[i] = LN(word[id] + type[0] + pos[position]) for one row.
  (func $embed_row (param $i i32)
    (local $id i32) (local $x i32) (local $q i32) (local $s i32) (local $t i32) (local $p i32) (local $c i32)
    (local $v v128)
    (local.set $id (i32.load (i32.add (global.get $IDS) (i32.shl (local.get $i) (i32.const 2)))))
    (local.set $x (i32.add (global.get $X) (i32.mul (local.get $i) (i32.const 3072))))
    (local.set $q (i32.add (call $slot (i32.const 0)) (i32.mul (local.get $id) (i32.const 768))))
    (local.set $s (i32.add (call $slot (i32.const 1)) (i32.mul (local.get $id) (i32.const 96))))
    (local.set $t (call $slot (i32.const 3)))
    (local.set $p (i32.add (call $slot (i32.const 2))
      (i32.mul (i32.load (i32.add (global.get $POS) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 3072))))
    (loop $cols
      ;; 4 weights at column c (byte c of the row), scale of block c/32
      (local.set $v (f32x4.mul
        (f32x4.convert_i32x4_s (i32x4.sub
          (i32x4.extend_low_i16x8_u (i16x8.extend_low_i8x16_u
            (v128.load32_zero (i32.add (local.get $q) (local.get $c)))))
          (v128.const i32x4 128 128 128 128)))
        (v128.load32_splat (i32.add (local.get $s) (i32.shl (i32.shr_u (local.get $c) (i32.const 5)) (i32.const 2))))))
      (v128.store (i32.add (local.get $x) (i32.shl (local.get $c) (i32.const 2)))
        (f32x4.add
          (f32x4.add (local.get $v) (v128.load (i32.add (local.get $t) (i32.shl (local.get $c) (i32.const 2)))))
          (v128.load (i32.add (local.get $p) (i32.shl (local.get $c) (i32.const 2))))))
      (br_if $cols (i32.lt_u (local.tee $c (i32.add (local.get $c) (i32.const 4))) (i32.const 768))))
    (call $ln (local.get $x) (call $slot (i32.const 4)) (call $slot (i32.const 5))))

  ;; x[i] = LN(x[i] + src[i]) for one row
  (func $residual_ln_row (param $src i32) (param $i i32) (param $g i32) (param $b i32)
    (local $x i32) (local $y i32) (local $c i32)
    (local.set $x (i32.add (global.get $X) (i32.mul (local.get $i) (i32.const 3072))))
    (local.set $y (i32.add (local.get $src) (i32.mul (local.get $i) (i32.const 3072))))
    (loop $cols
      (v128.store (i32.add (local.get $x) (local.get $c))
        (f32x4.add (v128.load (i32.add (local.get $x) (local.get $c)))
          (v128.load (i32.add (local.get $y) (local.get $c)))))
      (br_if $cols (i32.lt_u (local.tee $c (i32.add (local.get $c) (i32.const 16))) (i32.const 3072))))
    (call $ln (local.get $x) (local.get $g) (local.get $b)))

  ;; One head, query rows rb*64 .. +64: softmax(Q K^T / 8 + bias) V into CTX.
  (func $attention (param $h i32) (param $rb i32)
    (local $s i32) (local $sp i32) (local $kt i32) (local $sc i32) (local $i0 i32) (local $r i32)
    (local $j i32) (local $d i32) (local $m i32) (local $n i32) (local $row i32) (local $src i32)
    (local $mx v128) (local $sum v128) (local $v v128) (local $ldsc i32) (local $hoff i32)
    (local.set $s (i32.load (global.get $S)))
    (local.set $sp (i32.load (global.get $SP)))
    (local.set $kt (i32.add (global.get $SCR) (i32.mul (global.get $tid) (global.get $SCR_STRIDE))))
    (local.set $sc (i32.add (local.get $kt) (global.get $SCORES_AT)))
    (local.set $i0 (i32.shl (local.get $rb) (i32.const 6)))
    (local.set $r (i32.sub (local.get $sp) (local.get $i0)))
    (if (i32.gt_u (local.get $r) (i32.const 64)) (then (local.set $r (i32.const 64))))
    (local.set $ldsc (i32.shl (local.get $sp) (i32.const 2)))
    (local.set $hoff (i32.shl (local.get $h) (i32.const 8))) ;; h * 64 floats, in bytes
    ;; Kt[d][j] = K[j][h*64 + d]
    (local.set $j (i32.const 0))
    (loop $tj
      (local.set $src (i32.add (i32.add (global.get $K) (i32.mul (local.get $j) (i32.const 3072))) (local.get $hoff)))
      (local.set $d (i32.const 0))
      (loop $td
        (f32.store (i32.add (local.get $kt)
            (i32.shl (i32.add (i32.mul (local.get $d) (local.get $sp)) (local.get $j)) (i32.const 2)))
          (f32.load (i32.add (local.get $src) (i32.shl (local.get $d) (i32.const 2)))))
        (br_if $td (i32.lt_u (local.tee $d (i32.add (local.get $d) (i32.const 1))) (i32.const 64))))
      (br_if $tj (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 1))) (local.get $sp))))
    ;; scores[r][j] = Q[i0 + r][h] . Kt[.][j]
    (local.set $m (i32.const 0))
    (loop $sm
      (local.set $n (i32.const 0))
      (loop $sn
        (call $mk
          (i32.add (i32.add (global.get $Q) (i32.mul (i32.add (local.get $i0) (local.get $m)) (i32.const 3072)))
            (local.get $hoff))
          (i32.const 3072)
          (i32.add (local.get $kt) (i32.shl (local.get $n) (i32.const 2))) (local.get $ldsc)
          (i32.add (local.get $sc) (i32.shl (i32.add (i32.mul (local.get $m) (local.get $sp)) (local.get $n)) (i32.const 2)))
          (local.get $ldsc) (i32.const 64) (i32.const 0) (global.get $ZERO) (i32.const 0))
        (br_if $sn (i32.lt_u (local.tee $n (i32.add (local.get $n) (i32.const 16))) (local.get $sp))))
      (br_if $sm (i32.lt_u (local.tee $m (i32.add (local.get $m) (i32.const 4))) (local.get $r))))
    ;; softmax of each row over all SP columns (padding has bias -65504 and comes out as 0)
    (local.set $m (i32.const 0))
    (loop $rows
      (local.set $row (i32.add (local.get $sc) (i32.mul (local.get $m) (local.get $ldsc))))
      (local.set $mx (v128.const f32x4 -inf -inf -inf -inf))
      (local.set $j (i32.const 0))
      (loop $c1
        (local.set $v (f32x4.add
          (f32x4.mul (v128.load (i32.add (local.get $row) (local.get $j))) (v128.const f32x4 0.125 0.125 0.125 0.125))
          (v128.load (i32.add (global.get $BIAS) (local.get $j)))))
        (v128.store (i32.add (local.get $row) (local.get $j)) (local.get $v))
        (local.set $mx (f32x4.max (local.get $mx) (local.get $v)))
        (br_if $c1 (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 16))) (local.get $ldsc))))
      (local.set $mx (f32x4.splat (call $hmax (local.get $mx))))
      (local.set $sum (v128.const f32x4 0 0 0 0))
      (local.set $j (i32.const 0))
      (loop $c2
        (local.set $v (call $exp4 (f32x4.sub (v128.load (i32.add (local.get $row) (local.get $j))) (local.get $mx))))
        (v128.store (i32.add (local.get $row) (local.get $j)) (local.get $v))
        (local.set $sum (f32x4.add (local.get $sum) (local.get $v)))
        (br_if $c2 (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 16))) (local.get $ldsc))))
      (local.set $sum (f32x4.splat (f32.div (f32.const 1) (call $hsum (local.get $sum)))))
      (local.set $j (i32.const 0))
      (loop $c3
        (v128.store (i32.add (local.get $row) (local.get $j))
          (f32x4.mul (v128.load (i32.add (local.get $row) (local.get $j))) (local.get $sum)))
        (br_if $c3 (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 16))) (local.get $ldsc))))
      (br_if $rows (i32.lt_u (local.tee $m (i32.add (local.get $m) (i32.const 1))) (local.get $r))))
    ;; CTX[i0 + r][h] = P[r][0..S] . V[0..S][h]
    (local.set $m (i32.const 0))
    (loop $pm
      (local.set $n (i32.const 0))
      (loop $pn
        (call $mk
          (i32.add (local.get $sc) (i32.mul (local.get $m) (local.get $ldsc))) (local.get $ldsc)
          (i32.add (i32.add (global.get $V) (local.get $hoff)) (i32.shl (local.get $n) (i32.const 2))) (i32.const 3072)
          (i32.add (i32.add (global.get $CTX) (i32.mul (i32.add (local.get $i0) (local.get $m)) (i32.const 3072)))
            (i32.add (local.get $hoff) (i32.shl (local.get $n) (i32.const 2))))
          (i32.const 3072) (local.get $s) (i32.const 0) (global.get $ZERO) (i32.const 0))
        (br_if $pn (i32.lt_u (local.tee $n (i32.add (local.get $n) (i32.const 16))) (i32.const 64))))
      (br_if $pm (i32.lt_u (local.tee $m (i32.add (local.get $m) (i32.const 4))) (local.get $r)))))

  (func $task (param $op i32) (param $t i32)
    (local $base i32) (local $i i32) (local $end i32) (local $mat i32)
    (local.set $base (i32.add (i32.const 6) (i32.mul (i32.load (global.get $LAYER)) (i32.const 22))))
    (block $out
      (if (i32.eq (local.get $op) (global.get $OP_EMBED))
        (then
          (local.set $i (i32.shl (local.get $t) (i32.const 4)))
          (local.set $end (i32.add (local.get $i) (i32.const 16)))
          (loop $l
            (call $embed_row (local.get $i))
            (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $end))))
          (br $out)))
      (if (i32.eq (local.get $op) (global.get $OP_QKV))
        (then
          (local.set $mat (i32.div_u (local.get $t) (i32.const 48)))
          (call $gemm_panel (global.get $X) (i32.const 768)
            (call $slot (i32.add (local.get $base) (i32.shl (local.get $mat) (i32.const 1))))
            (call $slot (i32.add (local.get $base) (i32.add (i32.shl (local.get $mat) (i32.const 1)) (i32.const 1))))
            (call $slot (i32.add (local.get $base) (i32.add (i32.const 12) (local.get $mat))))
            (i32.add (global.get $Q) (i32.mul (local.get $mat) (global.get $BUF)))
            (i32.const 768)
            (i32.shl (i32.rem_u (local.get $t) (i32.const 48)) (i32.const 4))
            (i32.const 0))
          (br $out)))
      (if (i32.eq (local.get $op) (global.get $OP_ATTN))
        (then
          (call $attention (i32.rem_u (local.get $t) (i32.const 12)) (i32.div_u (local.get $t) (i32.const 12)))
          (br $out)))
      (if (i32.eq (local.get $op) (global.get $OP_OPROJ))
        (then
          (call $gemm_panel (global.get $CTX) (i32.const 768)
            (call $slot (i32.add (local.get $base) (i32.const 6)))
            (call $slot (i32.add (local.get $base) (i32.const 7)))
            (call $slot (i32.add (local.get $base) (i32.const 15)))
            (global.get $TMP) (i32.const 768) (i32.shl (local.get $t) (i32.const 4)) (i32.const 0))
          (br $out)))
      (if (i32.eq (local.get $op) (global.get $OP_FF1))
        (then
          (call $gemm_panel (global.get $X) (i32.const 768)
            (call $slot (i32.add (local.get $base) (i32.const 8)))
            (call $slot (i32.add (local.get $base) (i32.const 9)))
            (call $slot (i32.add (local.get $base) (i32.const 18)))
            (global.get $H) (i32.const 3072) (i32.shl (local.get $t) (i32.const 4)) (i32.const 1))
          (br $out)))
      (if (i32.eq (local.get $op) (global.get $OP_FF2))
        (then
          (call $gemm_panel (global.get $H) (i32.const 3072)
            (call $slot (i32.add (local.get $base) (i32.const 10)))
            (call $slot (i32.add (local.get $base) (i32.const 11)))
            (call $slot (i32.add (local.get $base) (i32.const 19)))
            (global.get $TMP) (i32.const 768) (i32.shl (local.get $t) (i32.const 4)) (i32.const 0))
          (br $out)))
      ;; LN1 / LN2: 16 rows per task
      (local.set $i (i32.shl (local.get $t) (i32.const 4)))
      (local.set $end (i32.add (local.get $i) (i32.const 16)))
      (local.set $mat (select (i32.const 16) (i32.const 20) (i32.eq (local.get $op) (global.get $OP_LN1))))
      (loop $l
        (call $residual_ln_row (global.get $TMP) (local.get $i)
          (call $slot (i32.add (local.get $base) (local.get $mat)))
          (call $slot (i32.add (local.get $base) (i32.add (local.get $mat) (i32.const 1)))))
        (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $end))))))

  ;; ---------------------------------------------------------------- threads

  ;; Runs the tasks of generation g still unclaimed. NEXT holds (g << 16) | next task.
  (func $work (param $g i32) (param $op i32) (param $nt i32)
    (local $v i32)
    (loop $l
      (local.set $v (i32.atomic.load (global.get $NEXT)))
      (if (i32.ne (i32.shr_u (local.get $v) (i32.const 16)) (i32.and (local.get $g) (i32.const 0xFFFF)))
        (then (return)))
      (if (i32.ge_u (i32.and (local.get $v) (i32.const 0xFFFF)) (local.get $nt)) (then (return)))
      (if (i32.ne (i32.atomic.rmw.cmpxchg (global.get $NEXT) (local.get $v) (i32.add (local.get $v) (i32.const 1)))
                  (local.get $v))
        (then (br $l)))
      (call $task (local.get $op) (i32.and (local.get $v) (i32.const 0xFFFF)))
      (if (i32.eq (i32.add (i32.atomic.rmw.add (global.get $DONE) (i32.const 1)) (i32.const 1)) (local.get $nt))
        (then (drop (memory.atomic.notify (global.get $DONE) (i32.const 1)))))
      (br $l)))

  (func $run (param $op i32) (param $nt i32)
    (local $g i32) (local $t i32) (local $d i32)
    (if (i32.le_u (i32.load (global.get $NTH)) (i32.const 1))
      (then
        (loop $l
          (call $task (local.get $op) (local.get $t))
          (br_if $l (i32.lt_u (local.tee $t (i32.add (local.get $t) (i32.const 1))) (local.get $nt))))
        (return)))
    (local.set $g (i32.add (i32.atomic.load (global.get $GEN)) (i32.const 1)))
    (i32.atomic.store (global.get $DONE) (i32.const 0))
    ;; tag NEXT first, so that a worker still on the last generation cannot claim with the new NT
    (i32.atomic.store (global.get $NEXT) (i32.shl (local.get $g) (i32.const 16)))
    (i32.atomic.store (global.get $OP) (local.get $op))
    (i32.atomic.store (global.get $NT) (local.get $nt))
    (i32.atomic.store (global.get $GEN) (local.get $g))
    (drop (memory.atomic.notify (global.get $GEN) (i32.const -1)))
    (call $work (local.get $g) (local.get $op) (local.get $nt))
    (loop $wait
      (local.set $d (i32.atomic.load (global.get $DONE)))
      (if (i32.lt_u (local.get $d) (local.get $nt))
        (then
          (drop (memory.atomic.wait32 (global.get $DONE) (local.get $d) (i64.const -1)))
          (br $wait)))))

  ;; A worker thread: runs tasks of every new generation until QUIT.
  (func (export "worker") (param $id i32)
    (local $last i32) (local $g i32) (local $spin i32)
    (global.set $tid (local.get $id))
    (local.set $last (i32.atomic.load (global.get $GEN)))
    (loop $l
      (if (i32.atomic.load (global.get $QUIT)) (then (return)))
      (local.set $g (i32.atomic.load (global.get $GEN)))
      (if (i32.eq (local.get $g) (local.get $last))
        (then
          (if (i32.lt_u (local.get $spin) (i32.const 20000))
            (then (local.set $spin (i32.add (local.get $spin) (i32.const 1))) (br $l)))
          (drop (memory.atomic.wait32 (global.get $GEN) (local.get $last) (i64.const -1)))
          (br $l)))
      (local.set $spin (i32.const 0))
      (local.set $last (local.get $g))
      (call $work (local.get $g) (i32.atomic.load (global.get $OP)) (i32.atomic.load (global.get $NT)))
      (br $l)))

  ;; ---------------------------------------------------------------- forward

  ;; Logits of one sequence of s <= 512 tokens (ids and mask filled by the host).
  (func (export "forward") (param $s i32)
    (local $sp i32) (local $i i32) (local $c i32) (local $id i32) (local $l i32) (local $x i32)
    (local $q i32) (local $sc i32) (local $acc v128) (local $k i32) (local $bc f32)
    (local.set $sp (i32.and (i32.add (local.get $s) (i32.const 15)) (i32.const -16)))
    (i32.store (global.get $S) (local.get $s))
    (i32.store (global.get $SP) (local.get $sp))
    ;; padding up to SP: <pad>, masked
    (local.set $i (local.get $s))
    (block $pd (loop $p
      (br_if $pd (i32.ge_u (local.get $i) (local.get $sp)))
      (i32.store (i32.add (global.get $IDS) (i32.shl (local.get $i) (i32.const 2))) (i32.const 1))
      (f32.store (i32.add (global.get $MASK) (i32.shl (local.get $i) (i32.const 2))) (f32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $p)))
    ;; positions: cumsum(id != 1) * (id != 1) + 1; attention bias: (1 - mask) * -65504
    (local.set $i (i32.const 0))
    (loop $p
      (local.set $id (i32.load (i32.add (global.get $IDS) (i32.shl (local.get $i) (i32.const 2)))))
      (if (i32.ne (local.get $id) (i32.const 1)) (then (local.set $c (i32.add (local.get $c) (i32.const 1)))))
      (i32.store (i32.add (global.get $POS) (i32.shl (local.get $i) (i32.const 2)))
        (select (i32.add (local.get $c) (i32.const 1)) (i32.const 1) (i32.ne (local.get $id) (i32.const 1))))
      (f32.store (i32.add (global.get $BIAS) (i32.shl (local.get $i) (i32.const 2)))
        (f32.mul (f32.sub (f32.const 1)
          (f32.load (i32.add (global.get $MASK) (i32.shl (local.get $i) (i32.const 2))))) (f32.const -65504)))
      (br_if $p (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $sp))))

    (i32.store (global.get $LAYER) (i32.const 0))
    (call $run (global.get $OP_EMBED) (i32.shr_u (local.get $sp) (i32.const 4)))
    (loop $layers
      (i32.store (global.get $LAYER) (local.get $l))
      (call $run (global.get $OP_QKV) (i32.const 144))
      (call $run (global.get $OP_ATTN) (i32.mul (i32.const 12) (i32.shr_u (i32.add (local.get $sp) (i32.const 63)) (i32.const 6))))
      (call $run (global.get $OP_OPROJ) (i32.const 48))
      (call $run (global.get $OP_LN1) (i32.shr_u (local.get $sp) (i32.const 4)))
      (call $run (global.get $OP_FF1) (i32.const 192))
      (call $run (global.get $OP_FF2) (i32.const 48))
      (call $run (global.get $OP_LN2) (i32.shr_u (local.get $sp) (i32.const 4)))
      (br_if $layers (i32.lt_u (local.tee $l (i32.add (local.get $l) (i32.const 1))) (i32.const 3))))

    ;; classifier: logits[i] = x[i] . wc + b, wc dequantized from [1][24][32]
    (local.set $q (call $slot (i32.const 72)))
    (local.set $sc (call $slot (i32.const 73)))
    (local.set $k (i32.const 0))
    (loop $w
      (f32.store (i32.add (global.get $WC) (i32.shl (local.get $k) (i32.const 2)))
        (f32.mul
          (f32.convert_i32_s (i32.sub (i32.load8_u (i32.add (local.get $q) (local.get $k))) (i32.const 128)))
          (f32.load (i32.add (local.get $sc) (i32.shl (i32.shr_u (local.get $k) (i32.const 5)) (i32.const 2))))))
      (br_if $w (i32.lt_u (local.tee $k (i32.add (local.get $k) (i32.const 1))) (i32.const 768))))
    (local.set $bc (f32.load (call $slot (i32.const 74))))
    (local.set $i (i32.const 0))
    (loop $rows
      (local.set $x (i32.add (global.get $X) (i32.mul (local.get $i) (i32.const 3072))))
      (local.set $acc (v128.const f32x4 0 0 0 0))
      (local.set $k (i32.const 0))
      (loop $dot
        (local.set $acc (f32x4.add (local.get $acc)
          (f32x4.mul (v128.load (i32.add (local.get $x) (local.get $k)))
            (v128.load (i32.add (global.get $WC) (local.get $k))))))
        (br_if $dot (i32.lt_u (local.tee $k (i32.add (local.get $k) (i32.const 16))) (i32.const 3072))))
      (f32.store (i32.add (global.get $LOGITS) (i32.shl (local.get $i) (i32.const 2)))
        (f32.add (call $hsum (local.get $acc)) (local.get $bc)))
      (br_if $rows (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $s)))))
)
