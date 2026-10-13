;; QOA (Quite OK Audio) encoder / decoder, hand-written WebAssembly text.
;;
;; Features used: SIMD128 (incl. i64x2), relaxed SIMD (i8x16.relaxed_swizzle),
;; bulk memory (memory.fill).
;;
;; Encoder: produces exactly the same bitstream as the reference qoa.h
;; encoder. For every slice all 16 scalefactors are tried; instead of trying
;; them one after the other, four candidates run side by side, one per SIMD
;; lane, with each candidate's LMS state transposed across vectors (h0..h3,
;; w0..w3), so prediction, quantization, reconstruction, error ranking and the
;; LMS update are all lane-wise without horizontal operations. A group of four
;; is abandoned as soon as all its lanes rank worse than the best candidate so
;; far; groups are tried nearest-to-the-previous-scalefactor first.
;;
;; Decoder: inherently serial per channel; written as tight scalar code (see
;; $decode_slice).
;;
;; Memory layout (first 64 KiB page is reserved for the codec):
;;   0x0000  SF2     i32[32]   scalefactor table, repeated twice so that four
;;                             consecutive (mod 16) entries can be v128-loaded
;;   0x0080  RCP2    i32[32]   reciprocal table (same layout)
;;   0x0100  DEQ     i32[16][8] dequantization table
;;   0x0300  SCR     scratch for spilling vectors (lane extraction), 0xc0 bytes
;;   0x0400  ELMS    encoder LMS state, 31 channels x { i32 h[4]; i32 w[4] }
;;   0x0800  EPSF    encoder previous scalefactor per channel, i32[32]
;;   0x0880  GOFS    u8[4] candidate group offsets
;;   0x0900  BEST    best candidate state: h[4] w[4] qa qhi
;;   0x0C00  DLMS    decoder LMS state, 31 channels x { i32 h[4]; i32 w[4] }
;;   0x10000 heap    free for the host (input / output buffers)
;;
;; Samples handed to / returned by the codec are interleaved native (little
;; endian) int16; QOA data is big endian as required by the format.
(module
  (memory (export "memory") 2)

  (global $f_channels   (export "frame_channels")   (mut i32) (i32.const 0))
  (global $f_samplerate (export "frame_samplerate") (mut i32) (i32.const 0))
  (global $f_samples    (export "frame_samples")    (mut i32) (i32.const 0))
  (global $heap_base    (export "heap_base")        i32 (i32.const 0x10000))
  ;; ELMS + EPSF: snapshot / restore to run several encoders on one instance
  (global (export "encoder_state")      i32 (i32.const 0x0400))
  (global (export "encoder_state_size") i32 (i32.const 0x0480))

  ;; search order of the four groups of four candidate scalefactors, relative
  ;; to the previous slice's scalefactor: {-1..2}, {-5..-2}, {3..6}, {7..10}
  (data (i32.const 0x0880) "\0f\0b\03\07")

  ;; ------------------------------------------------------------------------
  ;; tables
  ;; ------------------------------------------------------------------------
  (func $init
    (local $i i32) (local $x f64) (local $sf i32) (local $q i32) (local $k i32)
    (local $d i32)
    (loop $l
      ;; sf = round((i+1)^2.75) = round(x^2 * x^(1/2) * x^(1/4))
      (local.set $x (f64.convert_i32_u (i32.add (local.get $i) (i32.const 1))))
      (local.set $sf (i32.trunc_f64_u (f64.nearest
        (f64.mul (f64.mul (local.get $x) (local.get $x))
                 (f64.mul (f64.sqrt (local.get $x))
                          (f64.sqrt (f64.sqrt (local.get $x))))))))
      (i32.store (i32.shl (local.get $i) (i32.const 2)) (local.get $sf))
      (i32.store offset=64 (i32.shl (local.get $i) (i32.const 2)) (local.get $sf))
      ;; reciprocal = ceil(65536 / sf)
      (local.set $d (i32.div_u (i32.add (i32.const 65535) (local.get $sf)) (local.get $sf)))
      (i32.store offset=0x80 (i32.shl (local.get $i) (i32.const 2)) (local.get $d))
      (i32.store offset=0xc0 (i32.shl (local.get $i) (i32.const 2)) (local.get $d))
      ;; dequant: sf * {0.75, 2.5, 4.5, 7} = sf * {3, 10, 18, 28} / 4, rounded
      ;; half away from zero, odd indices negative
      (local.set $q (i32.const 0))
      (loop $lq
        (local.set $k
          (i32.and (i32.shr_u (i32.const 0x1c120a03)
                              (i32.shl (i32.shr_u (local.get $q) (i32.const 1)) (i32.const 3)))
                   (i32.const 0xff)))
        (local.set $d (i32.shr_u (i32.add (i32.mul (local.get $sf) (local.get $k)) (i32.const 2))
                                 (i32.const 2)))
        (if (i32.and (local.get $q) (i32.const 1))
          (then (local.set $d (i32.sub (i32.const 0) (local.get $d)))))
        (i32.store offset=0x100
          (i32.shl (i32.add (i32.shl (local.get $i) (i32.const 3)) (local.get $q)) (i32.const 2))
          (local.get $d))
        (br_if $lq (i32.ne (local.tee $q (i32.add (local.get $q) (i32.const 1))) (i32.const 8))))
      (br_if $l (i32.ne (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const 16)))))
  (start $init)

  ;; ------------------------------------------------------------------------
  ;; big endian helpers
  ;; ------------------------------------------------------------------------
  (func $load_be64 (param $p i32) (result i64)
    (i64x2.extract_lane 0
      (i8x16.shuffle 7 6 5 4 3 2 1 0 15 14 13 12 11 10 9 8
        (v128.load64_zero (local.get $p)) (v128.const i64x2 0 0))))

  (func $store_be64 (param $p i32) (param $x i64)
    (v128.store64_lane 0 (local.get $p)
      (i8x16.shuffle 7 6 5 4 3 2 1 0 15 14 13 12 11 10 9 8
        (i64x2.splat (local.get $x)) (v128.const i64x2 0 0))))

  ;; ------------------------------------------------------------------------
  ;; encoder
  ;; ------------------------------------------------------------------------

  ;; Reset the encoder LMS state for `ch` channels.
  (func (export "encode_init") (param $ch i32)
    (local $p i32)
    (local.set $p (i32.const 0x400))
    (loop $l
      (v128.store (local.get $p) (v128.const i32x4 0 0 0 0))
      (v128.store offset=16 (local.get $p) (v128.const i32x4 0 0 -8192 16384))
      (br_if $l (i32.lt_u (local.tee $p (i32.add (local.get $p) (i32.const 32)))
                          (i32.add (i32.const 0x400) (i32.shl (local.get $ch) (i32.const 5))))))
    (memory.fill (i32.const 0x800) (i32.const 0) (i32.const 128)))

  ;; Encode one slice of `len` (1..20) samples of one channel.
  ;; All 16 scalefactors are evaluated, four at a time: lane k of every vector
  ;; holds the LMS state of one candidate. Returns the 64 bit slice and updates
  ;; the channel's LMS state and previous scalefactor.
  (func $encode_slice (param $lms i32) (param $src i32) (param $stride i32)
                      (param $len i32) (param $psf i32) (result i64)
    (local $h0 v128) (local $h1 v128) (local $h2 v128) (local $h3 v128)
    (local $w0 v128) (local $w1 v128) (local $w2 v128) (local $w3 v128)
    (local $sfv v128) (local $rcp v128) (local $rlo v128) (local $rhi v128) (local $bestv v128)
    (local $qa v128) (local $qhi v128)
    (local $smp v128) (local $pred v128) (local $res v128) (local $sgn v128) (local $n v128)
    (local $mag v128) (local $deq v128) (local $rec v128) (local $err v128)
    (local $m0 v128) (local $m1 v128) (local $m2 v128) (local $m3 v128)
    (local $pen v128) (local $delta v128)
    (local $g i32) (local $base i32) (local $prev i32) (local $i i32) (local $p i32)
    (local $l i32) (local $r i64) (local $best i64) (local $bestsf i32) (local $key i32) (local $bestkey i32)
    (local $hi i64) (local $lo i64)

    (local.set $prev (i32.load (local.get $psf)))
    (local.set $best (i64.const 0x7fffffffffffffff))
    (local.set $bestv (i64x2.splat (local.get $best)))

    (loop $groups
      (block $next_group
        (local.set $base (i32.and (i32.add (local.get $prev)
                                           (i32.load8_u offset=0x880 (local.get $g)))
                                  (i32.const 15)))
        (local.set $sfv (v128.load (i32.shl (local.get $base) (i32.const 2))))
        (local.set $rcp (v128.load offset=0x80 (i32.shl (local.get $base) (i32.const 2))))
        (local.set $h0 (v128.load32_splat offset=0 (local.get $lms)))
        (local.set $h1 (v128.load32_splat offset=4 (local.get $lms)))
        (local.set $h2 (v128.load32_splat offset=8 (local.get $lms)))
        (local.set $h3 (v128.load32_splat offset=12 (local.get $lms)))
        (local.set $w0 (v128.load32_splat offset=16 (local.get $lms)))
        (local.set $w1 (v128.load32_splat offset=20 (local.get $lms)))
        (local.set $w2 (v128.load32_splat offset=24 (local.get $lms)))
        (local.set $w3 (v128.load32_splat offset=28 (local.get $lms)))
        (local.set $rlo (v128.const i32x4 0 0 0 0))
        (local.set $rhi (v128.const i32x4 0 0 0 0))
        (local.set $qa (v128.const i32x4 0 0 0 0))
        (local.set $qhi (v128.const i32x4 0 0 0 0))
        (local.set $i (i32.const 0))
        (local.set $p (local.get $src))

        (loop $samples
          (local.set $smp (i32x4.splat (i32.load16_s (local.get $p))))
          ;; prediction
          (local.set $pred (i32x4.shr_s
            (i32x4.add (i32x4.add (i32x4.mul (local.get $h0) (local.get $w0))
                                  (i32x4.mul (local.get $h1) (local.get $w1)))
                       (i32x4.add (i32x4.mul (local.get $h2) (local.get $w2))
                                  (i32x4.mul (local.get $h3) (local.get $w3))))
            (i32.const 13)))
          (local.set $res (i32x4.sub (local.get $smp) (local.get $pred)))
          ;; quantize exactly like the reference encoder:
          ;;   n = (res * rcp + 0x8000) >> 16;  n += sign(res) - sign(n)
          ;; then mag = 2 * index into {.75, 2.5, 4.5, 7} and the sign of n.
          ;; (For huge residuals with sf = 1 the product wraps just like the
          ;; int arithmetic of qoa.h; such a candidate simply ranks badly.)
          (local.set $n (i32x4.shr_s
            (i32x4.add (i32x4.mul (local.get $res) (local.get $rcp))
                       (v128.const i32x4 0x8000 0x8000 0x8000 0x8000))
            (i32.const 16)))
          ;; sign(x) = (x < 0 mask) - (x > 0 mask)
          (local.set $n (i32x4.add (local.get $n)
            (i32x4.sub
              (i32x4.sub (i32x4.lt_s (local.get $res) (v128.const i32x4 0 0 0 0))
                         (i32x4.gt_s (local.get $res) (v128.const i32x4 0 0 0 0)))
              (i32x4.sub (i32x4.lt_s (local.get $n) (v128.const i32x4 0 0 0 0))
                         (i32x4.gt_s (local.get $n) (v128.const i32x4 0 0 0 0))))))
          (local.set $sgn (i32x4.shr_s (local.get $n) (i32.const 31)))
          (local.set $mag (v128.and (i32x4.min_u (i32x4.abs (local.get $n)) (v128.const i32x4 7 7 7 7))
                                    (v128.const i32x4 6 6 6 6)))
          ;; dequantize: |deq| = (sf * {3,10,18,28}[mag/2] + 2) >> 2
          (local.set $deq (i32x4.shr_u
            (i32x4.add
              (i32x4.mul (local.get $sfv)
                (i8x16.relaxed_swizzle
                  (v128.const i8x16 3 0 10 0 18 0 28 0 0 0 0 0 0 0 0 0)
                  (v128.or (local.get $mag) (v128.const i32x4 0x01010100 0x01010100 0x01010100 0x01010100))))
              (v128.const i32x4 2 2 2 2))
            (i32.const 2)))
          (local.set $deq (i32x4.sub (v128.xor (local.get $deq) (local.get $sgn)) (local.get $sgn)))
          (local.set $rec (i32x4.max_s
            (i32x4.min_s (i32x4.add (local.get $pred) (local.get $deq))
                         (v128.const i32x4 32767 32767 32767 32767))
            (v128.const i32x4 -32768 -32768 -32768 -32768)))
          ;; rank += err^2 + weights_penalty^2, exactly as the reference
          ;; encoder: the penalty in (wrapping) i32, the rank in i64
          (local.set $err (i32x4.sub (local.get $smp) (local.get $rec)))
          (local.set $pen (i32x4.max_s
            (i32x4.sub
              (i32x4.shr_s
                (i32x4.add (i32x4.add (i32x4.mul (local.get $w0) (local.get $w0))
                                      (i32x4.mul (local.get $w1) (local.get $w1)))
                           (i32x4.add (i32x4.mul (local.get $w2) (local.get $w2))
                                      (i32x4.mul (local.get $w3) (local.get $w3))))
                (i32.const 18))
              (v128.const i32x4 0x8ff 0x8ff 0x8ff 0x8ff))
            (v128.const i32x4 0 0 0 0)))
          (local.set $pen (i32x4.mul (local.get $pen) (local.get $pen)))
          (local.set $rlo (i64x2.add (local.get $rlo)
            (i64x2.add (i64x2.extmul_low_i32x4_s (local.get $err) (local.get $err))
                       (i64x2.extend_low_i32x4_u (local.get $pen)))))
          (local.set $rhi (i64x2.add (local.get $rhi)
            (i64x2.add (i64x2.extmul_high_i32x4_s (local.get $err) (local.get $err))
                       (i64x2.extend_high_i32x4_u (local.get $pen)))))
          ;; every candidate of this group is already worse than the best one
          (br_if $next_group (i64x2.all_true
            (v128.and (i64x2.gt_s (local.get $rlo) (local.get $bestv))
                      (i64x2.gt_s (local.get $rhi) (local.get $bestv)))))
          ;; LMS update
          (local.set $delta (i32x4.shr_s (local.get $deq) (i32.const 4)))
          (local.set $m0 (i32x4.shr_s (local.get $h0) (i32.const 31)))
          (local.set $m1 (i32x4.shr_s (local.get $h1) (i32.const 31)))
          (local.set $m2 (i32x4.shr_s (local.get $h2) (i32.const 31)))
          (local.set $m3 (i32x4.shr_s (local.get $h3) (i32.const 31)))
          (local.set $w0 (i32x4.add (local.get $w0)
            (i32x4.sub (v128.xor (local.get $delta) (local.get $m0)) (local.get $m0))))
          (local.set $w1 (i32x4.add (local.get $w1)
            (i32x4.sub (v128.xor (local.get $delta) (local.get $m1)) (local.get $m1))))
          (local.set $w2 (i32x4.add (local.get $w2)
            (i32x4.sub (v128.xor (local.get $delta) (local.get $m2)) (local.get $m2))))
          (local.set $w3 (i32x4.add (local.get $w3)
            (i32x4.sub (v128.xor (local.get $delta) (local.get $m3)) (local.get $m3))))
          (local.set $h0 (local.get $h1))
          (local.set $h1 (local.get $h2))
          (local.set $h2 (local.get $h3))
          (local.set $h3 (local.get $rec))
          ;; append the 3 bit code: mag | sign
          (local.set $qa (v128.or (i32x4.shl (local.get $qa) (i32.const 3))
                                  (v128.or (local.get $mag) (i32x4.shr_u (local.get $n) (i32.const 31)))))
          (local.set $p (i32.add (local.get $p) (local.get $stride)))
          (if (i32.eq (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const 10))
            (then (local.set $qhi (local.get $qa))
                  (local.set $qa (v128.const i32x4 0 0 0 0))))
          (br_if $samples (i32.lt_u (local.get $i) (local.get $len))))

        ;; the group ran to completion: spill and pick its best lane. Ties go
        ;; to the candidate the reference encoder tries first, i.e. the one
        ;; with the smallest (sf - prev) mod 16.
        (v128.store offset=0x300 (i32.const 0) (local.get $rlo))
        (v128.store offset=0x310 (i32.const 0) (local.get $rhi))
        (v128.store offset=0x320 (i32.const 0) (local.get $h0))
        (v128.store offset=0x330 (i32.const 0) (local.get $h1))
        (v128.store offset=0x340 (i32.const 0) (local.get $h2))
        (v128.store offset=0x350 (i32.const 0) (local.get $h3))
        (v128.store offset=0x360 (i32.const 0) (local.get $w0))
        (v128.store offset=0x370 (i32.const 0) (local.get $w1))
        (v128.store offset=0x380 (i32.const 0) (local.get $w2))
        (v128.store offset=0x390 (i32.const 0) (local.get $w3))
        (v128.store offset=0x3a0 (i32.const 0) (local.get $qa))
        (v128.store offset=0x3b0 (i32.const 0) (local.get $qhi))
        (local.set $l (i32.const 0))
        (loop $lanes
          (local.set $r (i64.load offset=0x300 (i32.shl (local.get $l) (i32.const 3))))
          (local.set $key (i32.and (i32.sub (i32.add (local.get $base) (local.get $l)) (local.get $prev))
                                   (i32.const 15)))
          (if (i32.or (i64.lt_s (local.get $r) (local.get $best))
                      (i32.and (i64.eq (local.get $r) (local.get $best))
                               (i32.lt_u (local.get $key) (local.get $bestkey))))
            (then
              (local.set $best (local.get $r))
              (local.set $bestkey (local.get $key))
              (local.set $bestsf (i32.and (i32.add (local.get $base) (local.get $l)) (i32.const 15)))
              (local.set $p (i32.add (i32.const 0x320) (i32.shl (local.get $l) (i32.const 2))))
              (i32.store offset=0x900 (i32.const 0) (i32.load offset=0x00 (local.get $p)))
              (i32.store offset=0x904 (i32.const 0) (i32.load offset=0x10 (local.get $p)))
              (i32.store offset=0x908 (i32.const 0) (i32.load offset=0x20 (local.get $p)))
              (i32.store offset=0x90c (i32.const 0) (i32.load offset=0x30 (local.get $p)))
              (i32.store offset=0x910 (i32.const 0) (i32.load offset=0x40 (local.get $p)))
              (i32.store offset=0x914 (i32.const 0) (i32.load offset=0x50 (local.get $p)))
              (i32.store offset=0x918 (i32.const 0) (i32.load offset=0x60 (local.get $p)))
              (i32.store offset=0x91c (i32.const 0) (i32.load offset=0x70 (local.get $p)))
              (i32.store offset=0x920 (i32.const 0) (i32.load offset=0x80 (local.get $p)))
              (i32.store offset=0x924 (i32.const 0) (i32.load offset=0x90 (local.get $p)))))
          (br_if $lanes (i32.ne (local.tee $l (i32.add (local.get $l) (i32.const 1))) (i32.const 4))))
        (local.set $bestv (i64x2.splat (local.get $best))))
      (br_if $groups (i32.ne (local.tee $g (i32.add (local.get $g) (i32.const 1))) (i32.const 4))))

    ;; commit the winner
    (v128.store offset=0 (local.get $lms) (v128.load (i32.const 0x900)))
    (v128.store offset=16 (local.get $lms) (v128.load (i32.const 0x910)))
    (i32.store (local.get $psf) (local.get $bestsf))
    (if (i32.gt_u (local.get $len) (i32.const 10))
      (then
        (local.set $hi (i64.extend_i32_u (i32.load (i32.const 0x924))))
        (local.set $lo (i64.shl (i64.extend_i32_u (i32.load (i32.const 0x920)))
                                (i64.extend_i32_u (i32.mul (i32.sub (i32.const 20) (local.get $len))
                                                           (i32.const 3))))))
      (else
        (local.set $hi (i64.shl (i64.extend_i32_u (i32.load (i32.const 0x920)))
                                (i64.extend_i32_u (i32.mul (i32.sub (i32.const 10) (local.get $len))
                                                           (i32.const 3)))))))
    (i64.or (i64.or (i64.shl (i64.extend_i32_u (local.get $bestsf)) (i64.const 60))
                    (i64.shl (local.get $hi) (i64.const 30)))
            (local.get $lo)))

  ;; Encode one frame of `flen` (1..5120) samples per channel from interleaved
  ;; int16 at `src`. Writes the frame to `dst` and returns its size in bytes.
  (func (export "encode_frame") (param $src i32) (param $ch i32) (param $sr i32)
                                (param $flen i32) (param $dst i32) (result i32)
    (local $slices i32) (local $fsize i32) (local $c i32) (local $lms i32) (local $v v128)
    (local $s i32) (local $len i32) (local $p i32) (local $stride i32) (local $sp i32)
    (local.set $slices (i32.div_u (i32.add (local.get $flen) (i32.const 19)) (i32.const 20)))
    (local.set $fsize (i32.add (i32.add (i32.const 8) (i32.shl (local.get $ch) (i32.const 4)))
                               (i32.shl (i32.mul (local.get $slices) (local.get $ch)) (i32.const 3))))
    (call $store_be64 (local.get $dst)
      (i64.or
        (i64.or (i64.shl (i64.extend_i32_u (local.get $ch)) (i64.const 56))
                (i64.shl (i64.extend_i32_u (i32.and (local.get $sr) (i32.const 0xffffff))) (i64.const 32)))
        (i64.extend_i32_u (i32.or (i32.shl (local.get $flen) (i32.const 16)) (local.get $fsize)))))
    ;; LMS state per channel; weights are saturated to int16 (and the encoder's
    ;; own copy too) so that the decoder starts from exactly the same state
    (local.set $p (i32.add (local.get $dst) (i32.const 8)))
    (local.set $lms (i32.const 0x400))
    (loop $lc
      (local.set $v (i16x8.narrow_i32x4_s (v128.load (local.get $lms))
                                          (v128.load offset=16 (local.get $lms))))
      (v128.store offset=16 (local.get $lms) (i32x4.extend_high_i16x8_s (local.get $v)))
      (v128.store (local.get $p)
        (i8x16.shuffle 1 0 3 2 5 4 7 6 9 8 11 10 13 12 15 14 (local.get $v) (local.get $v)))
      (local.set $p (i32.add (local.get $p) (i32.const 16)))
      (local.set $lms (i32.add (local.get $lms) (i32.const 32)))
      (br_if $lc (i32.ne (local.tee $c (i32.add (local.get $c) (i32.const 1))) (local.get $ch))))
    ;; slices, interleaved by channel
    (local.set $stride (i32.shl (local.get $ch) (i32.const 1)))
    (loop $ls
      (local.set $len (i32.sub (local.get $flen) (local.get $s)))
      (if (i32.gt_u (local.get $len) (i32.const 20)) (then (local.set $len (i32.const 20))))
      (local.set $sp (i32.add (local.get $src) (i32.mul (local.get $s) (local.get $stride))))
      (local.set $c (i32.const 0))
      (loop $lc2
        (call $store_be64 (local.get $p)
          (call $encode_slice
            (i32.add (i32.const 0x400) (i32.shl (local.get $c) (i32.const 5)))
            (i32.add (local.get $sp) (i32.shl (local.get $c) (i32.const 1)))
            (local.get $stride) (local.get $len)
            (i32.add (i32.const 0x800) (i32.shl (local.get $c) (i32.const 2)))))
        (local.set $p (i32.add (local.get $p) (i32.const 8)))
        (br_if $lc2 (i32.ne (local.tee $c (i32.add (local.get $c) (i32.const 1))) (local.get $ch))))
      (br_if $ls (i32.lt_u (local.tee $s (i32.add (local.get $s) (i32.const 20))) (local.get $flen))))
    (local.get $fsize))

  ;; ------------------------------------------------------------------------
  ;; decoder
  ;; ------------------------------------------------------------------------

  ;; Decode one slice of one channel: LMS state at `lms`, slice at `p`, `len`
  ;; samples written to `out` with a byte stride of `stride`.
  ;; Scalar on purpose: the loop is one long dependency chain through the
  ;; newest history sample, and a scalar imul is much shorter than a vector
  ;; multiply plus horizontal reduction. h3 * w3 is added last so that only it
  ;; sits on the critical path; the weight update is off the chain.
  ;; (Interleaving two channels in one loop was tried and is slower: the
  ;; doubled state no longer fits in registers.)
  (func $decode_slice (param $lms i32) (param $p i32) (param $out i32) (param $stride i32) (param $len i32)
    (local $h0 i32) (local $h1 i32) (local $h2 i32) (local $h3 i32)
    (local $w0 i32) (local $w1 i32) (local $w2 i32) (local $w3 i32)
    (local $sl i64) (local $row i32) (local $r i32) (local $x i32)
    (local $end i32) (local $m i32)
    (local.set $h0 (i32.load offset=0 (local.get $lms)))
    (local.set $h1 (i32.load offset=4 (local.get $lms)))
    (local.set $h2 (i32.load offset=8 (local.get $lms)))
    (local.set $h3 (i32.load offset=12 (local.get $lms)))
    (local.set $w0 (i32.load offset=16 (local.get $lms)))
    (local.set $w1 (i32.load offset=20 (local.get $lms)))
    (local.set $w2 (i32.load offset=24 (local.get $lms)))
    (local.set $w3 (i32.load offset=28 (local.get $lms)))
    (local.set $sl (call $load_be64 (local.get $p)))
    (local.set $row (i32.add (i32.const 0x100)
      (i32.shl (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 60))) (i32.const 5))))
    (local.set $sl (i64.shl (local.get $sl) (i64.const 4)))
    (if (i32.eq (local.get $len) (i32.const 20))
      (then
        ;; full slice: completely unrolled, history roles rotate between the
        ;; locals h0..h3 so that no values have to be moved around
        ;; sample 0
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 59))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h0) (local.get $w0))
                                       (i32.mul (local.get $h1) (local.get $w1)))
                              (i32.mul (local.get $h2) (local.get $w2)))
                     (i32.mul (local.get $h3) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h0 (local.get $x))
        ;; sample 1
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 56))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h1) (local.get $w0))
                                       (i32.mul (local.get $h2) (local.get $w1)))
                              (i32.mul (local.get $h3) (local.get $w2)))
                     (i32.mul (local.get $h0) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h1 (local.get $x))
        ;; sample 2
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 53))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h2) (local.get $w0))
                                       (i32.mul (local.get $h3) (local.get $w1)))
                              (i32.mul (local.get $h0) (local.get $w2)))
                     (i32.mul (local.get $h1) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h2 (local.get $x))
        ;; sample 3
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 50))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h3) (local.get $w0))
                                       (i32.mul (local.get $h0) (local.get $w1)))
                              (i32.mul (local.get $h1) (local.get $w2)))
                     (i32.mul (local.get $h2) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h3 (local.get $x))
        ;; sample 4
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 47))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h0) (local.get $w0))
                                       (i32.mul (local.get $h1) (local.get $w1)))
                              (i32.mul (local.get $h2) (local.get $w2)))
                     (i32.mul (local.get $h3) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h0 (local.get $x))
        ;; sample 5
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 44))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h1) (local.get $w0))
                                       (i32.mul (local.get $h2) (local.get $w1)))
                              (i32.mul (local.get $h3) (local.get $w2)))
                     (i32.mul (local.get $h0) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h1 (local.get $x))
        ;; sample 6
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 41))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h2) (local.get $w0))
                                       (i32.mul (local.get $h3) (local.get $w1)))
                              (i32.mul (local.get $h0) (local.get $w2)))
                     (i32.mul (local.get $h1) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h2 (local.get $x))
        ;; sample 7
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 38))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h3) (local.get $w0))
                                       (i32.mul (local.get $h0) (local.get $w1)))
                              (i32.mul (local.get $h1) (local.get $w2)))
                     (i32.mul (local.get $h2) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h3 (local.get $x))
        ;; sample 8
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 35))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h0) (local.get $w0))
                                       (i32.mul (local.get $h1) (local.get $w1)))
                              (i32.mul (local.get $h2) (local.get $w2)))
                     (i32.mul (local.get $h3) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h0 (local.get $x))
        ;; sample 9
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 32))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h1) (local.get $w0))
                                       (i32.mul (local.get $h2) (local.get $w1)))
                              (i32.mul (local.get $h3) (local.get $w2)))
                     (i32.mul (local.get $h0) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h1 (local.get $x))
        ;; sample 10
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 29))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h2) (local.get $w0))
                                       (i32.mul (local.get $h3) (local.get $w1)))
                              (i32.mul (local.get $h0) (local.get $w2)))
                     (i32.mul (local.get $h1) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h2 (local.get $x))
        ;; sample 11
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 26))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h3) (local.get $w0))
                                       (i32.mul (local.get $h0) (local.get $w1)))
                              (i32.mul (local.get $h1) (local.get $w2)))
                     (i32.mul (local.get $h2) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h3 (local.get $x))
        ;; sample 12
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 23))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h0) (local.get $w0))
                                       (i32.mul (local.get $h1) (local.get $w1)))
                              (i32.mul (local.get $h2) (local.get $w2)))
                     (i32.mul (local.get $h3) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h0 (local.get $x))
        ;; sample 13
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 20))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h1) (local.get $w0))
                                       (i32.mul (local.get $h2) (local.get $w1)))
                              (i32.mul (local.get $h3) (local.get $w2)))
                     (i32.mul (local.get $h0) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h1 (local.get $x))
        ;; sample 14
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 17))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h2) (local.get $w0))
                                       (i32.mul (local.get $h3) (local.get $w1)))
                              (i32.mul (local.get $h0) (local.get $w2)))
                     (i32.mul (local.get $h1) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h2 (local.get $x))
        ;; sample 15
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 14))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h3) (local.get $w0))
                                       (i32.mul (local.get $h0) (local.get $w1)))
                              (i32.mul (local.get $h1) (local.get $w2)))
                     (i32.mul (local.get $h2) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h3 (local.get $x))
        ;; sample 16
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 11))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h0) (local.get $w0))
                                       (i32.mul (local.get $h1) (local.get $w1)))
                              (i32.mul (local.get $h2) (local.get $w2)))
                     (i32.mul (local.get $h3) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h0 (local.get $x))
        ;; sample 17
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 8))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h1) (local.get $w0))
                                       (i32.mul (local.get $h2) (local.get $w1)))
                              (i32.mul (local.get $h3) (local.get $w2)))
                     (i32.mul (local.get $h0) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h1 (local.get $x))
        ;; sample 18
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 5))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h2) (local.get $w0))
                                       (i32.mul (local.get $h3) (local.get $w1)))
                              (i32.mul (local.get $h0) (local.get $w2)))
                     (i32.mul (local.get $h1) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h2 (local.get $x))
        ;; sample 19
        (local.set $r (i32.load (i32.add (local.get $row)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 2))) (i32.const 0x1c)))))
        (local.set $x (i32.add
          (i32.shr_s
            (i32.add (i32.add (i32.add (i32.mul (local.get $h3) (local.get $w0))
                                       (i32.mul (local.get $h0) (local.get $w1)))
                              (i32.mul (local.get $h1) (local.get $w2)))
                     (i32.mul (local.get $h2) (local.get $w3)))
            (i32.const 13))
          (local.get $r)))
        (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
        (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
        (i32.store16 (local.get $out) (local.get $x))
        (local.set $out (i32.add (local.get $out) (local.get $stride)))
        (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
        (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
        (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
        (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
        (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
        (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
        (local.set $h3 (local.get $x))
        ;; after 20 steps (a multiple of 4) the roles are back in place
        )
      (else
        ;; partial slice (end of the stream)
        (local.set $end (i32.add (local.get $out) (i32.mul (local.get $len) (local.get $stride))))
        (loop $li
          (local.set $r (i32.load (i32.add (local.get $row)
            (i32.shl (i32.wrap_i64 (i64.shr_u (local.get $sl) (i64.const 61))) (i32.const 2)))))
          (local.set $sl (i64.shl (local.get $sl) (i64.const 3)))
          (local.set $x (i32.add
            (i32.shr_s
              (i32.add (i32.add (i32.add (i32.mul (local.get $h0) (local.get $w0))
                                         (i32.mul (local.get $h1) (local.get $w1)))
                                (i32.mul (local.get $h2) (local.get $w2)))
                       (i32.mul (local.get $h3) (local.get $w3)))
              (i32.const 13))
            (local.get $r)))
          (local.set $x (select (local.get $x) (i32.const 32767) (i32.lt_s (local.get $x) (i32.const 32767))))
          (local.set $x (select (local.get $x) (i32.const -32768) (i32.gt_s (local.get $x) (i32.const -32768))))
          (i32.store16 (local.get $out) (local.get $x))
          (local.set $r (i32.shr_s (local.get $r) (i32.const 4)))
          (local.set $m (i32.shr_s (local.get $h0) (i32.const 31)))
          (local.set $w0 (i32.add (local.get $w0) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
          (local.set $m (i32.shr_s (local.get $h1) (i32.const 31)))
          (local.set $w1 (i32.add (local.get $w1) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
          (local.set $m (i32.shr_s (local.get $h2) (i32.const 31)))
          (local.set $w2 (i32.add (local.get $w2) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
          (local.set $m (i32.shr_s (local.get $h3) (i32.const 31)))
          (local.set $w3 (i32.add (local.get $w3) (i32.sub (i32.xor (local.get $r) (local.get $m)) (local.get $m))))
          (local.set $h0 (local.get $h1))
          (local.set $h1 (local.get $h2))
          (local.set $h2 (local.get $h3))
          (local.set $h3 (local.get $x))
          (br_if $li (i32.ne (local.tee $out (i32.add (local.get $out) (local.get $stride)))
                             (local.get $end))))))
    (i32.store offset=0 (local.get $lms) (local.get $h0))
    (i32.store offset=4 (local.get $lms) (local.get $h1))
    (i32.store offset=8 (local.get $lms) (local.get $h2))
    (i32.store offset=12 (local.get $lms) (local.get $h3))
    (i32.store offset=16 (local.get $lms) (local.get $w0))
    (i32.store offset=20 (local.get $lms) (local.get $w1))
    (i32.store offset=24 (local.get $lms) (local.get $w2))
    (i32.store offset=28 (local.get $lms) (local.get $w3)))

  ;; Decode one frame from `src` (with `avail` bytes available) into
  ;; interleaved int16 at `dst`. Returns the number of bytes consumed, or
  ;;   -1  not enough data for the frame header
  ;;   -2  invalid frame header (zero channels / samplerate / samples, > 5120 samples)
  ;;   -3  frame size does not match the header
  ;;   -4  frame truncated
  ;; The frame's parameters are left in frame_channels / frame_samplerate /
  ;; frame_samples.
  (func (export "decode_frame") (param $src i32) (param $avail i32) (param $dst i32) (result i32)
    (local $hdr i64) (local $ch i32) (local $sr i32) (local $fs i32) (local $fsize i32)
    (local $slices i32) (local $c i32) (local $p i32) (local $v v128) (local $lms i32)
    (local $s i32) (local $len i32) (local $stride i32)
    (local $out i32)
    (if (i32.lt_u (local.get $avail) (i32.const 8)) (then (return (i32.const -1))))
    (local.set $hdr (call $load_be64 (local.get $src)))
    (local.set $ch (i32.wrap_i64 (i64.shr_u (local.get $hdr) (i64.const 56))))
    (local.set $sr (i32.and (i32.wrap_i64 (i64.shr_u (local.get $hdr) (i64.const 32))) (i32.const 0xffffff)))
    (local.set $fs (i32.shr_u (i32.wrap_i64 (local.get $hdr)) (i32.const 16)))
    (local.set $fsize (i32.and (i32.wrap_i64 (local.get $hdr)) (i32.const 0xffff)))
    (global.set $f_channels (local.get $ch))
    (global.set $f_samplerate (local.get $sr))
    (global.set $f_samples (local.get $fs))
    (if (i32.or (i32.or (i32.eqz (local.get $ch)) (i32.gt_u (local.get $ch) (i32.const 31)))
                (i32.or (i32.eqz (local.get $sr))
                        (i32.or (i32.eqz (local.get $fs)) (i32.gt_u (local.get $fs) (i32.const 5120)))))
      (then (return (i32.const -2))))
    (local.set $slices (i32.div_u (i32.add (local.get $fs) (i32.const 19)) (i32.const 20)))
    (if (i32.ne (local.get $fsize)
                (i32.add (i32.add (i32.const 8) (i32.shl (local.get $ch) (i32.const 4)))
                         (i32.shl (i32.mul (local.get $slices) (local.get $ch)) (i32.const 3))))
      (then (return (i32.const -3))))
    (if (i32.gt_u (local.get $fsize) (local.get $avail)) (then (return (i32.const -4))))

    ;; LMS state: int16 big endian history[4], weights[4] -> i32x4 h, w
    (local.set $p (i32.add (local.get $src) (i32.const 8)))
    (local.set $lms (i32.const 0xc00))
    (loop $lc
      (local.set $v (i8x16.shuffle 1 0 3 2 5 4 7 6 9 8 11 10 13 12 15 14
                      (v128.load (local.get $p)) (v128.const i64x2 0 0)))
      (v128.store (local.get $lms) (i32x4.extend_low_i16x8_s (local.get $v)))
      (v128.store offset=16 (local.get $lms) (i32x4.extend_high_i16x8_s (local.get $v)))
      (local.set $p (i32.add (local.get $p) (i32.const 16)))
      (local.set $lms (i32.add (local.get $lms) (i32.const 32)))
      (br_if $lc (i32.ne (local.tee $c (i32.add (local.get $c) (i32.const 1))) (local.get $ch))))

    (local.set $stride (i32.shl (local.get $ch) (i32.const 1)))
    (loop $ls
      (local.set $len (i32.sub (local.get $fs) (local.get $s)))
      (if (i32.gt_u (local.get $len) (i32.const 20)) (then (local.set $len (i32.const 20))))
      (local.set $out (i32.add (local.get $dst) (i32.shl (i32.mul (local.get $s) (local.get $ch)) (i32.const 1))))
      (local.set $lms (i32.const 0xc00))
      (local.set $c (i32.const 0))
      (loop $lc2
        (call $decode_slice (local.get $lms) (local.get $p) (local.get $out) (local.get $stride) (local.get $len))
        (local.set $lms (i32.add (local.get $lms) (i32.const 32)))
        (local.set $p (i32.add (local.get $p) (i32.const 8)))
        (local.set $out (i32.add (local.get $out) (i32.const 2)))
        (br_if $lc2 (i32.ne (local.tee $c (i32.add (local.get $c) (i32.const 1))) (local.get $ch))))
      (br_if $ls (i32.lt_u (local.tee $s (i32.add (local.get $s) (i32.const 20))) (local.get $fs))))
    (local.get $fsize))
)
