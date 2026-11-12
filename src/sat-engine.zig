//! sat-3l-sm's forward pass in Zig, built as a shared library (scripts/zigbuild_sat.ts) with a C API that
//! src/sat-ffi.ts drives through bun:ffi. It started as a port of a hand-written WebAssembly module (SIMD128, one
//! thread pool on shared memory), whose design it keeps: blocked f32 GEMM on int8 weights dequantized while they
//! are rewritten into panels, attention on K and V panels, a thread pool that claims tasks with a generation-tagged
//! CAS counter, one op at a time.
//!
//! The host allocates each weight tensor with sat_slot and reads it from the file into that memory, then calls
//! sat_prepare (weights into panels, worker threads started) and sat_run per batch.
//!
//! Only the pinned `model.onnx` runs (75 tensors in the slot order of src/sat-tensors.ts, 3 layers of
//! d_model 768, FFN 3072, 12 heads); the tunables below were measured on the machines named beside them.
const std = @import("std");

/// Build-time tunables, one `pub const` per line: scripts/sat_tune.ts sweeps them by rewriting these lines.
/// One set for every target. Measured on a Core i5-14600KF (AVX2: 16 vector registers) and a Cortex-X925 (NEON: 32),
/// 1×512 on one thread: the GEMMs run near the core's peak (about 140 GFLOPS on the X925, which has four 128-bit FMA
/// pipes), so the best values of the two differ by under 3%. Tiles of 7 or more rows spill the accumulators on NEON
/// and cost 2.4 times as much, tiles of fewer rows leave the pipes idle (2 rows: 1.4 times); K blocks of 128 to 768
/// and the spin are flat.
const cfg = struct {
    /// f32 lanes per vector. On NEON 8 is two registers per vector, which measured the same as 4 (within 2%).
    pub const vw = 8;
    /// Rows of the GEMM micro-kernel.
    pub const mr = 6;
    /// Columns of the GEMM micro-kernel, and so the width of the weight panels (a multiple of 16).
    pub const nr = 16;
    /// Rows of the attention micro-kernel (always 16 columns: the K and V panels are 16 wide).
    pub const amr = 6;
    /// K block of the GEMM (a multiple of 32, the quantization block).
    pub const kc = 384;
    /// @mulAdd in the micro-kernels (scores, P·V and the GEMMs) instead of a separate mul and add (2.4 times as slow).
    pub const fma = true;
    /// @mulAdd in exp, GELU, LayerNorm and the classifier.
    pub const fma_math = true;
    /// Atomic loads (each followed by the CPU's spin-loop hint) a thread spins for before it sleeps on the futex: a
    /// worker waiting for the next op, and the caller waiting for the others to finish the last task of one. Not tuned:
    /// 0 to 200000 measured alike at 4 and 8 threads (identical builds differed by more; the caller's spin gained 3% on
    /// 1×128 at 8 threads, 1% on larger batches), so it only has to outlast the gap between two ops (microseconds) and
    /// stay short enough not to burn an idle core.
    pub const spin = 20000;
};

const VW: usize = cfg.vw;
const V = @Vector(VW, f32);
const VI = @Vector(VW, i32);
const VU = @Vector(VW, u32);
const MR: usize = cfg.mr;
const NR: usize = cfg.nr;
const AMR: usize = cfg.amr;
const KC: usize = cfg.kc;

comptime {
    if (NR % 16 != 0 or NR % VW != 0) @compileError("nr: a multiple of 16 and of vw");
    if (KC % 32 != 0) @compileError("kc: a multiple of 32");
}

const MAX_SEQ = 512;
const MAX_THREADS = 64;
const D = 768;
const FF = 3072;
const NSLOTS = 75;
/// Floats in each of X, Q, K, V, CTX, TMP.
const BUF = MAX_SEQ * D;
/// Per-thread scratch (floats): the packed panel of the GEMM; or, in attention, 1/sum of the softmax rows at 0
/// and the scores at SCORES_AT.
const SCORES_AT = std.mem.alignForward(usize, @max(KC * NR, 64), 16);
const SCR_STRIDE = SCORES_AT + 64 * MAX_SEQ;

const OP_EMBED = 0;
const OP_QKV = 1;
const OP_ATTN = 2;
const OP_OPROJ = 3;
const OP_LN1 = 4;
const OP_FF1 = 5;
const OP_FF2 = 6;
const OP_LN2 = 7;

const Engine = struct {
    // control block
    gen: u32,
    next: u32,
    op: u32,
    nt: u32,
    done: u32,
    quit: u32,
    nthreads: u32,
    /// Worker threads running (tids 1 .. started).
    started: u32,
    s: usize,
    sp: usize,
    layer: usize,
    /// Address of each tensor, in the slot order of src/sat-tensors.ts, and its size.
    slots: [NSLOTS]?[*]u8,
    slot_bytes: [NSLOTS]usize,
    ids: [MAX_SEQ]i32,
    mask: [MAX_SEQ]f32,
    /// Attention bias: (1 - mask) * -65504.
    bias: [MAX_SEQ]f32 align(64),
    pos: [MAX_SEQ]i32,
    logits: [MAX_SEQ]f32,
    zero: [64]f32 align(64),
    /// Classifier weights, dequantized.
    wc: [D]f32 align(64),
    x: [*]f32,
    /// Q, K, V, each BUF floats.
    qkv: [*]f32,
    ctx: [*]f32,
    /// From QKV to attention, TMP holds K as KT panels and H holds V as VP panels (see kvStrip).
    tmp: [*]f32,
    h: [*]f32,
    scr: [*]f32,
    threads: [MAX_THREADS]std.Thread,
};

// ---------------------------------------------------------------- memory

const gpa = std.heap.c_allocator;

/// `bytes` zeroed bytes at a 64-byte boundary; freed by `release` with the same size.
fn alloc(bytes: usize) ?[*]u8 {
    const b = gpa.alignedAlloc(u8, .@"64", bytes) catch return null;
    @memset(b, 0);
    return b.ptr;
}

fn release(p: [*]u8, bytes: usize) void {
    gpa.free(@as([]align(64) u8, @alignCast(p[0..bytes])));
}

fn allocF(n: usize) ?[*]f32 {
    return @ptrCast(@alignCast(alloc(n * 4) orelse return null));
}

fn slotF(e: *Engine, i: usize) [*]f32 {
    return @ptrCast(@alignCast(e.slots[i].?));
}

fn slotI8(e: *Engine, i: usize) [*]i8 {
    return @ptrCast(e.slots[i].?);
}

fn slotU8(e: *Engine, i: usize) [*]u8 {
    return e.slots[i].?;
}

// ---------------------------------------------------------------- vectors

inline fn ld(p: [*]const f32) V {
    return p[0..VW].*;
}

inline fn st(p: [*]f32, v: V) void {
    p[0..VW].* = v;
}

inline fn splat(x: f32) V {
    return @splat(x);
}

/// a * b + c, fused or as a mul and an add.
inline fn madd(comptime fused: bool, a: V, b: V, c: V) V {
    return if (fused) @mulAdd(V, a, b, c) else a * b + c;
}

/// Lane sum, (0 + 1) + (2 + 3) for 4 lanes.
inline fn hsum(v: V) f32 {
    if (VW == 4) return (v[0] + v[1]) + (v[2] + v[3]);
    const lo: @Vector(4, f32) = @shuffle(f32, v, undefined, [4]i32{ 0, 1, 2, 3 });
    const hi: @Vector(4, f32) = @shuffle(f32, v, undefined, [4]i32{ 4, 5, 6, 7 });
    const s = lo + hi;
    return (s[0] + s[1]) + (s[2] + s[3]);
}

/// f32x4.pmax: b if a < b, else a (one maxps; there are no NaNs here).
inline fn pmax(a: V, b: V) V {
    return @select(f32, a < b, b, a);
}

// ---------------------------------------------------------------- math

const FM = cfg.fma_math;

/// e^x for x <= 0 (0 below -87.3), Cephes-style range reduction, degree-6 polynomial; n = round(x log2 e)
/// through the 1.5 * 2^23 trick, 2^n from the same bits.
inline fn expv(x0: V) V {
    const lo = splat(-87.3);
    const under = x0 < lo;
    const x = pmax(x0, lo);
    const big = splat(12582912.0);
    const m = madd(FM, x, splat(1.44269504), big);
    const n = m - big;
    var r: V = undefined;
    if (FM) {
        r = @mulAdd(V, -n, splat(0.693359375), x);
        r = @mulAdd(V, -n, splat(-2.12194440e-4), r);
    } else {
        r = x - n * splat(0.693359375);
        r = r - n * splat(-2.12194440e-4);
    }
    var p = splat(1.3888889e-3);
    p = madd(FM, p, r, splat(8.3333333e-3));
    p = madd(FM, p, r, splat(4.1666667e-2));
    p = madd(FM, p, r, splat(0.16666667));
    p = madd(FM, p, r, splat(0.5));
    p = madd(FM, p, r, splat(1));
    p = madd(FM, p, r, splat(1));
    const bits = (@as(VU, @bitCast(m)) +% @as(VU, @splat(127))) << @as(@Vector(VW, u5), @splat(23));
    return @select(f32, under, splat(0), p * @as(V, @bitCast(bits)));
}

/// x * Phi(x) with erf from Abramowitz-Stegun 7.1.26.
inline fn geluv(x: V) V {
    const z = @abs(x) * splat(0.70710678);
    const t = splat(1) / madd(FM, z, splat(0.3275911), splat(1));
    var p = splat(1.061405429);
    p = madd(FM, p, t, splat(-1.453152027));
    p = madd(FM, p, t, splat(1.421413741));
    p = madd(FM, p, t, splat(-0.284496736));
    p = madd(FM, p, t, splat(0.254829592));
    p = p * t;
    const e = p * expv(-(z * z));
    return (x * splat(0.5)) * @select(f32, x < splat(0), e, splat(2) - e);
}

/// In-place LayerNorm of one 768-wide row, epsilon 1e-5.
fn ln(p: [*]f32, g: [*]const f32, b: [*]const f32) void {
    var acc = splat(0);
    var i: usize = 0;
    while (i < D) : (i += VW) acc += ld(p + i);
    const mean = splat(hsum(acc) / 768.0);
    acc = splat(0);
    i = 0;
    while (i < D) : (i += VW) {
        const d = ld(p + i) - mean;
        acc = madd(FM, d, d, acc);
    }
    const inv = splat(1.0 / @sqrt(hsum(acc) / 768.0 + 1e-5));
    i = 0;
    while (i < D) : (i += VW) st(p + i, madd(FM, (ld(p + i) - mean) * inv, ld(g + i), ld(b + i)));
}

// ---------------------------------------------------------------- GEMM

/// C[R][N] (=|+=) A[R][k] . B[k][N], B rows contiguous (N floats). Strides in floats. Rows start from `bias`
/// (N floats, every row) unless `acc`, then from C. At any R x N.
fn mk(comptime R: usize, comptime N: usize, a: [*]const f32, lda: usize, b: [*]const f32, c: [*]f32, ldc: usize, k: usize, acc: bool, bias: [*]const f32) void {
    const NV = N / VW;
    var x: [R][NV]V = undefined;
    inline for (0..R) |i| {
        inline for (0..NV) |j| x[i][j] = if (acc) ld(c + i * ldc + j * VW) else ld(bias + j * VW);
    }
    // one pointer per A row
    var ap: [R][*]const f32 = undefined;
    inline for (0..R) |i| ap[i] = a + i * lda;
    var bp = b;
    var kk = k;
    while (kk != 0) : (kk -= 1) {
        inline for (0..R) |i| {
            const av: V = @splat(ap[i][0]);
            inline for (0..NV) |j| x[i][j] = madd(cfg.fma, av, ld(bp + j * VW), x[i][j]);
            ap[i] += 1;
        }
        bp += N;
    }
    inline for (0..R) |i| {
        inline for (0..NV) |j| st(c + i * ldc + j * VW, x[i][j]);
    }
}

/// mk over `rows` rows, R at a time, the rest with a smaller kernel.
fn mkRows(comptime R: usize, comptime N: usize, rows: usize, a: [*]const f32, lda: usize, b: [*]const f32, c: [*]f32, ldc: usize, k: usize, acc: bool, bias: [*]const f32) void {
    var m: usize = 0;
    while (m + R <= rows) : (m += R) mk(R, N, a + m * lda, lda, b, c + m * ldc, ldc, k, acc, bias);
    if (R > 1) {
        if (m < rows) switch (rows - m) {
            inline 1...R - 1 => |t| mk(t, N, a + m * lda, lda, b, c + m * ldc, ldc, k, acc, bias),
            else => unreachable,
        };
    }
}

/// Rewrites one quantized N x K matrix in place, once, into panels of NR output columns:
/// weights [N/NR][K][NR] int8 (q - 128), scales [N/NR][K/32][NR] f32.
fn toPanels(wq: [*]u8, ws: [*]f32, n_: usize, k_: usize) bool {
    const nb = k_ / 32;
    const tq = alloc(n_ * k_) orelse return false;
    defer release(tq, n_ * k_);
    const ts = allocF(n_ * nb) orelse return false;
    defer release(@ptrCast(ts), n_ * nb * 4);
    for (0..n_) |n| {
        for (0..k_) |k| tq[(n / NR) * k_ * NR + k * NR + n % NR] = wq[n * k_ + k] ^ 0x80;
        for (0..nb) |kb| ts[(n / NR) * nb * NR + kb * NR + n % NR] = ws[n * nb + kb];
    }
    @memcpy(wq[0 .. n_ * k_], tq[0 .. n_ * k_]);
    @memcpy(ws[0 .. n_ * nb], ts[0 .. n_ * nb]);
    return true;
}

/// Dequantizes the panel of column n0, rows kb .. kb+kc, into dst[kc][NR] (layout of toPanels).
fn pack(wq: [*]const i8, ws: [*]const f32, k_: usize, n0: usize, kb: usize, kc: usize, dst: [*]f32) void {
    const src = wq + n0 * k_ + kb * NR;
    const sc = ws + n0 * (k_ / 32) + (kb / 32) * NR;
    var s: [NR / VW]V = undefined;
    for (0..kc) |k| {
        if (k % 32 == 0) {
            inline for (0..NR / VW) |j| s[j] = ld(sc + (k / 32) * NR + j * VW);
        }
        inline for (0..NR / VW) |j| {
            const q: @Vector(VW, i8) = src[k * NR + j * VW ..][0..VW].*;
            st(dst + k * NR + j * VW, @as(V, @floatFromInt(@as(VI, q))) * s[j]);
        }
    }
}

/// C[0..SP][n0..n0+NR] = A[SP][K] . W^T + bias (then GELU), W quantized N x K. ldc in floats.
fn gemmPanel(e: *Engine, tid: usize, a: [*]const f32, k_: usize, w: usize, bias: [*]const f32, c: [*]f32, ldc: usize, n0: usize, gelu: bool) void {
    const pk = e.scr + tid * SCR_STRIDE;
    const wq = slotI8(e, w);
    const ws = slotF(e, w + 1);
    var kb: usize = 0;
    while (kb < k_) : (kb += KC) {
        const kc = @min(KC, k_ - kb);
        pack(wq, ws, k_, n0, kb, kc, pk);
        mkRows(MR, NR, e.sp, a + kb, k_, pk, c + n0, ldc, kc, kb != 0, bias + n0);
    }
    // GELU over the finished strip
    if (gelu) {
        for (0..e.sp) |m| {
            const row = c + m * ldc + n0;
            inline for (0..NR / VW) |j| st(row + j * VW, geluv(ld(row + j * VW)));
        }
    }
}

// ---------------------------------------------------------------- steps

/// x[i] = LN(word[id] + type[0] + pos[position]) for one row.
fn embedRow(e: *Engine, i: usize) void {
    const id: usize = @intCast(e.ids[i]);
    const x = e.x + i * D;
    const q = slotU8(e, 0) + id * D;
    const s = slotF(e, 1) + id * 24;
    const t = slotF(e, 3);
    const p = slotF(e, 2) + @as(usize, @intCast(e.pos[i])) * D;
    var c: usize = 0;
    while (c < D) : (c += VW) {
        const qv: @Vector(VW, u8) = q[c..][0..VW].*;
        const v = @as(V, @floatFromInt(@as(VI, qv) - @as(VI, @splat(128)))) * splat(s[c / 32]);
        st(x + c, (v + ld(t + c)) + ld(p + c));
    }
    ln(x, slotF(e, 4), slotF(e, 5));
}

/// x[i] = LN(x[i] + src[i]) for one row.
fn residualLnRow(e: *Engine, src: [*]const f32, i: usize, g: [*]const f32, b: [*]const f32) void {
    const x = e.x + i * D;
    const y = src + i * D;
    var c: usize = 0;
    while (c < D) : (c += VW) st(x + c, ld(x + c) + ld(y + c));
    ln(x, g, b);
}

/// One head, query rows rb*64 .. +64: softmax(Q K^T / 8 + bias) V into CTX (Q is already / 8, see
/// sat_prepare). K and V come as panels of 16 columns (KT and VP, see kvStrip).
fn attention(e: *Engine, tid: usize, h: usize, rb: usize) void {
    const s = e.s;
    const sp = e.sp;
    const inv = e.scr + tid * SCR_STRIDE;
    const sc = inv + SCORES_AT;
    const row0 = rb * 64;
    const r = @min(64, sp - row0);
    const hoff = h * 64;
    const kt = e.tmp + hoff * sp;
    // scores[r][j] = bias[j] + Q[row0 + r][h] . K[j][h]
    var n: usize = 0;
    while (n < sp) : (n += 16) mkRows(AMR, 16, r, e.qkv + row0 * D + hoff, D, kt + n * 64, sc + n, sp, 64, false, e.bias[n..].ptr);
    // e^(x - max) of each row over all SP columns (padding has bias -65504 and comes out as 0); 1/sum to inv
    for (0..r) |m| {
        const row = sc + m * sp;
        var mx = splat(-std.math.inf(f32));
        var j: usize = 0;
        while (j < sp) : (j += VW) mx = pmax(mx, ld(row + j));
        const mxs = splat(@reduce(.Max, mx));
        var sum = splat(0);
        j = 0;
        while (j < sp) : (j += VW) {
            const v = expv(ld(row + j) - mxs);
            st(row + j, v);
            sum += v;
        }
        inv[m] = 1 / hsum(sum);
    }
    // CTX[row0 + r][h] = (P[r][0..S] . V[0..S][h]) / sum[r]
    n = 0;
    while (n < 64) : (n += 16) mkRows(AMR, 16, r, sc, sp, e.h + (h * 4 + n / 16) * sp * 16, e.ctx + row0 * D + hoff + n, D, s, false, &e.zero);
    for (0..r) |m| {
        const out = e.ctx + (row0 + m) * D + hoff;
        const v = splat(inv[m]);
        var j: usize = 0;
        while (j < 64) : (j += VW) st(out + j, ld(out + j) * v);
    }
}

/// After the QKV task that wrote columns n0 .. n0+NR of K or V, for rows j < SP, while they are in cache:
///   K into KT[h][j/16][d][j%16] (h = n/64, d = n mod 64), the B operand of the scores, 64 x 16 per block;
///   V into VP[n/16][j][16], the B operand of P V.
fn kvStrip(e: *Engine, mat: usize, n0: usize) void {
    const sp = e.sp;
    var u: usize = 0;
    while (u < NR) : (u += 16) {
        const n = n0 + u;
        if (mat == 2) {
            const src = e.qkv + 2 * BUF + n;
            const dst = e.h + (n / 16) * sp * 16;
            for (0..sp) |j| @memcpy(dst[j * 16 ..][0..16], src[j * D ..][0..16]);
        } else {
            const src = e.qkv + BUF + n;
            for (0..sp) |j| {
                const dst = e.tmp + (n / 64) * 64 * sp + (j / 16) * 1024 + (n % 64) * 16 + j % 16;
                for (0..16) |c| dst[c * 16] = src[j * D + c];
            }
        }
    }
}

fn ntasks(e: *Engine, op: u32) u32 {
    const sp: u32 = @intCast(e.sp);
    return switch (op) {
        OP_EMBED, OP_LN1, OP_LN2 => sp / 16,
        OP_QKV => 3 * D / NR,
        OP_ATTN => 12 * ((sp + 63) / 64),
        OP_OPROJ, OP_FF2 => D / NR,
        OP_FF1 => FF / NR,
        else => 0,
    };
}

fn task(e: *Engine, tid: usize, op: u32, t: usize) void {
    const base = 6 + e.layer * 22;
    switch (op) {
        OP_EMBED => for (t * 16..t * 16 + 16) |i| embedRow(e, i),
        OP_QKV => {
            const per = D / NR;
            const mat = t / per;
            const n0 = (t % per) * NR;
            gemmPanel(e, tid, e.x, D, base + 2 * mat, slotF(e, base + 12 + mat), e.qkv + mat * BUF, D, n0, false);
            if (mat != 0) kvStrip(e, mat, n0);
        },
        OP_ATTN => attention(e, tid, t % 12, t / 12),
        OP_OPROJ => gemmPanel(e, tid, e.ctx, D, base + 6, slotF(e, base + 15), e.tmp, D, t * NR, false),
        OP_FF1 => gemmPanel(e, tid, e.x, D, base + 8, slotF(e, base + 18), e.h, FF, t * NR, true),
        OP_FF2 => gemmPanel(e, tid, e.h, FF, base + 10, slotF(e, base + 19), e.tmp, D, t * NR, false),
        // LN1 / LN2: 16 rows per task
        else => {
            const g = base + @as(usize, if (op == OP_LN1) 16 else 20);
            for (t * 16..t * 16 + 16) |i| residualLnRow(e, e.tmp, i, slotF(e, g), slotF(e, g + 1));
        },
    }
}

// ---------------------------------------------------------------- threads

/// std's futex (Linux futex, Windows WaitOnAddress, ...) through the one Io that needs no setup.
const io = std.Io.Threaded.global_single_threaded.io();

fn futexWait(p: *u32, val: u32) void {
    io.futexWaitUncancelable(u32, p, val);
}

fn futexWake(p: *u32, n: u32) void {
    io.futexWake(u32, p, n);
}

/// Runs the tasks of generation g still unclaimed. NEXT holds (g << 16) | next task.
fn work(e: *Engine, tid: usize, g: u32, op: u32, nt: u32) void {
    while (true) {
        const v = @atomicLoad(u32, &e.next, .seq_cst);
        if (v >> 16 != g & 0xFFFF) return;
        if (v & 0xFFFF >= nt) return;
        if (@cmpxchgStrong(u32, &e.next, v, v + 1, .seq_cst, .seq_cst) != null) continue;
        task(e, tid, op, v & 0xFFFF);
        if (@atomicRmw(u32, &e.done, .Add, 1, .seq_cst) + 1 == nt) futexWake(&e.done, 1);
    }
}

fn run(e: *Engine, op: u32) void {
    const nt = ntasks(e, op);
    if (e.nthreads <= 1) {
        for (0..nt) |t| task(e, 0, op, t);
        return;
    }
    const g = @atomicLoad(u32, &e.gen, .seq_cst) +% 1;
    @atomicStore(u32, &e.done, 0, .seq_cst);
    // tag NEXT first, so that a worker still on the last generation cannot claim with the new NT
    @atomicStore(u32, &e.next, (g & 0xFFFF) << 16, .seq_cst);
    @atomicStore(u32, &e.op, op, .seq_cst);
    @atomicStore(u32, &e.nt, nt, .seq_cst);
    @atomicStore(u32, &e.gen, g, .seq_cst);
    futexWake(&e.gen, std.math.maxInt(i32));
    work(e, 0, g, op, nt);
    var spin: u32 = 0;
    while (true) {
        const d = @atomicLoad(u32, &e.done, .seq_cst);
        if (d >= nt) break;
        if (spin < cfg.spin) {
            spin += 1;
            std.atomic.spinLoopHint();
            continue;
        }
        futexWait(&e.done, d);
    }
}

/// A worker thread: runs tasks of every new generation until QUIT.
fn worker(e: *Engine, tid: usize) void {
    var last = @atomicLoad(u32, &e.gen, .seq_cst);
    var spin: u32 = 0;
    while (true) {
        if (@atomicLoad(u32, &e.quit, .seq_cst) != 0) return;
        const g = @atomicLoad(u32, &e.gen, .seq_cst);
        if (g == last) {
            if (spin < cfg.spin) {
                spin += 1;
                std.atomic.spinLoopHint();
                continue;
            }
            futexWait(&e.gen, last);
            continue;
        }
        spin = 0;
        last = g;
        work(e, tid, g, @atomicLoad(u32, &e.op, .seq_cst), @atomicLoad(u32, &e.nt, .seq_cst));
    }
}

// ---------------------------------------------------------------- forward

/// Logits of one sequence of s <= 512 tokens (ids and mask in e.ids / e.mask).
fn forward(e: *Engine, s: usize) void {
    const sp = (s + 15) & ~@as(usize, 15);
    e.s = s;
    e.sp = sp;
    // padding up to SP: <pad>, masked
    for (s..sp) |i| {
        e.ids[i] = 1;
        e.mask[i] = 0;
    }
    // positions: cumsum(id != 1) * (id != 1) + 1; attention bias: (1 - mask) * -65504
    var c: i32 = 0;
    for (0..sp) |i| {
        if (e.ids[i] != 1) c += 1;
        e.pos[i] = if (e.ids[i] != 1) c + 1 else 1;
        e.bias[i] = (1 - e.mask[i]) * -65504.0;
    }
    e.layer = 0;
    run(e, OP_EMBED);
    for (0..3) |l| {
        e.layer = l;
        run(e, OP_QKV);
        run(e, OP_ATTN);
        run(e, OP_OPROJ);
        run(e, OP_LN1);
        run(e, OP_FF1);
        run(e, OP_FF2);
        run(e, OP_LN2);
    }
    // classifier: logits[i] = x[i] . wc + b, wc dequantized from [1][24][32]
    const q = slotU8(e, 72);
    const sc = slotF(e, 73);
    for (0..D) |k| e.wc[k] = @as(f32, @floatFromInt(@as(i32, q[k]) - 128)) * sc[k / 32];
    const bc = slotF(e, 74)[0];
    for (0..s) |i| {
        const x = e.x + i * D;
        var acc = splat(0);
        var k: usize = 0;
        while (k < D) : (k += VW) acc = madd(FM, ld(x + k), ld(e.wc[k..].ptr), acc);
        e.logits[i] = hsum(acc) + bc;
    }
}

// ---------------------------------------------------------------- C API

/// A new engine for `threads` threads (the caller's, and threads - 1 workers started by sat_prepare).
export fn sat_create(threads: u32) ?*Engine {
    const e: *Engine = @ptrCast(@alignCast(alloc(@sizeOf(Engine)) orelse return null));
    e.nthreads = std.math.clamp(threads, 1, MAX_THREADS);
    e.x = allocF(BUF) orelse return null;
    e.qkv = allocF(3 * BUF) orelse return null;
    e.ctx = allocF(BUF) orelse return null;
    e.tmp = allocF(BUF) orelse return null;
    e.h = allocF(MAX_SEQ * FF) orelse return null;
    e.scr = allocF(MAX_THREADS * SCR_STRIDE) orelse return null;
    return e;
}

/// Allocates weight slot i (64-byte aligned) for the host to fill; null if out of memory.
export fn sat_slot(e: *Engine, i: u32, bytes: usize) ?[*]u8 {
    if (i >= NSLOTS) return null;
    e.slots[i] = alloc(bytes);
    e.slot_bytes[i] = bytes;
    return e.slots[i];
}

/// Once all slots are filled: the 18 encoder matrices into panels, Q pre-scaled by 1/8 (exact, a power of 2),
/// worker threads started. 0 on success.
export fn sat_prepare(e: *Engine) i32 {
    for (e.slots) |s| if (s == null) return -1;
    for (0..3) |l| {
        const base = 6 + l * 22;
        for (0..6) |m| {
            const n: usize = if (m == 4) FF else D;
            const k: usize = if (m == 5) FF else D;
            if (!toPanels(slotU8(e, base + 2 * m), slotF(e, base + 2 * m + 1), n, k)) return -2;
        }
        for (slotF(e, base + 1)[0 .. D * 24]) |*v| v.* *= 0.125;
        for (slotF(e, base + 12)[0..D]) |*v| v.* *= 0.125;
    }
    while (e.started + 1 < e.nthreads) : (e.started += 1) {
        const tid = e.started + 1;
        e.threads[tid] = std.Thread.spawn(.{ .stack_size = 1 << 20 }, worker, .{ e, @as(usize, tid) }) catch return -3;
    }
    return 0;
}

/// RunModel's shape: rows x width ids and mask in, one logit per token out (padding left 0). Each row is cut at
/// its last unmasked token. 0 on success, -1 if width > 512.
export fn sat_run(e: *Engine, ids: [*]const i64, mask: [*]const f32, rows: u32, width: u32, out: [*]f32) i32 {
    if (width > MAX_SEQ) return -1;
    @memset(out[0 .. rows * width], 0);
    for (0..rows) |r| {
        const at = r * width;
        var s: usize = width;
        while (s > 0 and mask[at + s - 1] == 0) s -= 1;
        if (s == 0) continue;
        for (0..s) |t| {
            e.ids[t] = @intCast(ids[at + t]);
            e.mask[t] = mask[at + t];
        }
        forward(e, s);
        @memcpy(out[at .. at + s], e.logits[0..s]);
    }
    return 0;
}

export fn sat_config() [*:0]const u8 {
    return std.fmt.comptimePrint("vw={d} mr={d} nr={d} amr={d} kc={d} fma={} fma_math={} spin={d}", .{
        VW, MR, NR, AMR, KC, cfg.fma, cfg.fma_math, cfg.spin,
    });
}

export fn sat_destroy(e: *Engine) void {
    @atomicStore(u32, &e.quit, 1, .seq_cst);
    _ = @atomicRmw(u32, &e.gen, .Add, 1, .seq_cst);
    futexWake(&e.gen, std.math.maxInt(i32));
    for (1..e.started + 1) |tid| e.threads[tid].join();
    for (e.slots, e.slot_bytes) |s, bytes| if (s) |p| release(p, bytes);
    const buffers = [_]struct { [*]f32, usize }{
        .{ e.x, BUF }, .{ e.qkv, 3 * BUF }, .{ e.ctx, BUF }, .{ e.tmp, BUF }, .{ e.h, MAX_SEQ * FF }, .{ e.scr, MAX_THREADS * SCR_STRIDE },
    };
    for (buffers) |b| release(@ptrCast(b[0]), b[1] * 4);
    release(@ptrCast(e), @sizeOf(Engine));
}
