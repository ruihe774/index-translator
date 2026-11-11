//! sat-3l-sm's forward pass in Zig: a port of src/sat.wat (the design notes are there), built as a shared library
//! with a C API that native/engine.ts drives through bun:ffi. Build-time tunables come from the `config` module
//! (native/config.zig, or the copy that native/build.sh writes for a variant).
//!
//! The host (engine.ts) allocates each weight tensor with sat_slot and reads it from the file into that memory,
//! then calls sat_prepare (weights into panels, worker threads started) and sat_run per batch.
const std = @import("std");
const cfg = @import("config");
const linux = std.os.linux;

const VW: usize = cfg.vw;
const V = @Vector(VW, f32);
const VI = @Vector(VW, i32);
const VU = @Vector(VW, u32);
const MR: usize = cfg.mr;
const NR: usize = cfg.nr;
const AMR: usize = cfg.amr;
const KC: usize = cfg.kc;
const manual = cfg.kernel == .manual;
const naive = cfg.kernel == .naive or cfg.kernel == .naive2;
const fmode: std.builtin.FloatMode = if (cfg.fast) .optimized else .strict;

comptime {
    if (NR % 16 != 0 or NR % VW != 0) @compileError("nr: a multiple of 16 and of vw");
    if (KC % 32 != 0) @compileError("kc: a multiple of 32");
    switch (cfg.kernel) {
        .manual, .auto, .naive, .naive2 => {},
        else => @compileError("kernel: manual, auto, naive or naive2"),
    }
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
    // control block, as in sat.wat
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
    /// Address of each tensor, in the slot order of src/tensors.ts.
    slots: [NSLOTS]?[*]u8,
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

fn alloc(bytes: usize) ?[*]u8 {
    var p: ?*anyopaque = null;
    if (std.c.posix_memalign(&p, 64, bytes) != 0) return null;
    const b: [*]u8 = @ptrCast(p.?);
    @memset(b[0..bytes], 0);
    return b;
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

/// Lane sum, in sat.wat's order for 4 lanes: (0 + 1) + (2 + 3).
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
/// through the 1.5 * 2^23 trick, 2^n from the same bits (see sat.wat's $exp4).
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

/// x * Phi(x) with erf from Abramowitz-Stegun 7.1.26 (see sat.wat's $gelu4).
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

/// The scalar forms of expv and geluv, for the .auto and .naive code. exps stays strict even with cfg.fast:
/// reassociated, (x log2e + 1.5 * 2^23) - 1.5 * 2^23 folds to x log2e, n is no integer, and 2^n is garbage.
inline fn exps(x0: f32) f32 {
    @setFloatMode(.strict);
    const x = if (x0 < -87.3) -87.3 else x0;
    const m = x * 1.44269504 + 12582912.0;
    const n = m - 12582912.0;
    var r = x - n * 0.693359375;
    r = r - n * -2.12194440e-4;
    var p: f32 = 1.3888889e-3;
    p = p * r + 8.3333333e-3;
    p = p * r + 4.1666667e-2;
    p = p * r + 0.16666667;
    p = p * r + 0.5;
    p = p * r + 1;
    p = p * r + 1;
    const two_n: f32 = @bitCast((@as(u32, @bitCast(m)) +% 127) << 23);
    return if (x0 < -87.3) 0 else p * two_n;
}

inline fn gelus(x: f32) f32 {
    @setFloatMode(fmode);
    const z = @abs(x) * 0.70710678;
    const t = 1 / (z * 0.3275911 + 1);
    var p: f32 = 1.061405429;
    p = p * t + -1.453152027;
    p = p * t + 1.421413741;
    p = p * t + -0.284496736;
    p = p * t + 0.254829592;
    p = p * t;
    const e = p * exps(-(z * z));
    return (x * 0.5) * (if (x < 0) e else 2 - e);
}

/// In-place LayerNorm of one 768-wide row, epsilon 1e-5.
fn ln(p: [*]f32, g: [*]const f32, b: [*]const f32) void {
    if (!manual) return lnScalar(p, g, b);
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

fn lnScalar(p: [*]f32, g: [*]const f32, b: [*]const f32) void {
    @setFloatMode(fmode);
    var sum: f32 = 0;
    for (0..D) |i| sum += p[i];
    const mean = sum / 768.0;
    var vs: f32 = 0;
    for (0..D) |i| vs += (p[i] - mean) * (p[i] - mean);
    const inv = 1.0 / @sqrt(vs / 768.0 + 1e-5);
    for (0..D) |i| p[i] = (p[i] - mean) * inv * g[i] + b[i];
}

// ---------------------------------------------------------------- GEMM

/// C[R][N] (=|+=) A[R][k] . B[k][N], B rows contiguous (N floats). Strides in floats. Rows start from `bias`
/// (N floats, every row) unless `acc`, then from C. sat.wat's $mk, at any R x N.
fn mk(comptime R: usize, comptime N: usize, a: [*]const f32, lda: usize, b: [*]const f32, c: [*]f32, ldc: usize, k: usize, acc: bool, bias: [*]const f32) void {
    if (!manual) return mkScalar(R, N, a, lda, b, c, ldc, k, acc, bias);
    const NV = N / VW;
    var x: [R][NV]V = undefined;
    inline for (0..R) |i| {
        inline for (0..NV) |j| x[i][j] = if (acc) ld(c + i * ldc + j * VW) else ld(bias + j * VW);
    }
    // one pointer per A row (as in sat.wat; LLVM picks its own addressing anyway)
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

/// mk written on scalars, for LLVM to vectorize (.auto).
fn mkScalar(comptime R: usize, comptime N: usize, a: [*]const f32, lda: usize, b: [*]const f32, c: [*]f32, ldc: usize, k: usize, acc: bool, bias: [*]const f32) void {
    @setFloatMode(fmode);
    var x: [R][N]f32 = undefined;
    for (0..R) |i| {
        for (0..N) |j| x[i][j] = if (acc) c[i * ldc + j] else bias[j];
    }
    for (0..k) |kk| {
        for (0..R) |i| {
            const av = a[i * lda + kk];
            for (0..N) |j| x[i][j] += av * b[kk * N + j];
        }
    }
    for (0..R) |i| {
        for (0..N) |j| c[i * ldc + j] = x[i][j];
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
    defer std.c.free(tq);
    const ts = allocF(n_ * nb) orelse return false;
    defer std.c.free(ts);
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
    if (!manual) {
        @setFloatMode(fmode);
        for (0..kc) |k| {
            for (0..NR) |j| dst[k * NR + j] = @as(f32, @floatFromInt(src[k * NR + j])) * sc[(k / 32) * NR + j];
        }
        return;
    }
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
    if (naive) return gemmNaive(e, a, k_, slotU8(e, w), slotF(e, w + 1), bias, c, ldc, n0, gelu);
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
            if (manual) {
                inline for (0..NR / VW) |j| st(row + j * VW, geluv(ld(row + j * VW)));
            } else {
                for (0..NR) |j| row[j] = gelus(row[j]);
            }
        }
    }
}

/// The textbook form (.naive): one dot product per output, over the row-major quantized weights.
fn gemmNaive(e: *Engine, a: [*]const f32, k_: usize, wq: [*]const u8, ws: [*]const f32, bias: [*]const f32, c: [*]f32, ldc: usize, n0: usize, gelu: bool) void {
    @setFloatMode(fmode);
    const nb = k_ / 32;
    for (0..e.sp) |i| {
        for (n0..n0 + NR) |n| {
            var acc: f32 = 0;
            if (cfg.kernel == .naive2) {
                // split at the quantization block: one scale per 32 products
                for (0..nb) |kb| {
                    var part: f32 = 0;
                    for (kb * 32..kb * 32 + 32) |k| part += a[i * k_ + k] * @as(f32, @floatFromInt(@as(i32, wq[n * k_ + k]) - 128));
                    acc += part * ws[n * nb + kb];
                }
            } else for (0..k_) |k| {
                const w = @as(f32, @floatFromInt(@as(i32, wq[n * k_ + k]) - 128)) * ws[n * nb + k / 32];
                acc += a[i * k_ + k] * w;
            }
            const y = acc + bias[n];
            c[i * ldc + n] = if (gelu) gelus(y) else y;
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
    if (manual) {
        var c: usize = 0;
        while (c < D) : (c += VW) {
            const qv: @Vector(VW, u8) = q[c..][0..VW].*;
            const v = @as(V, @floatFromInt(@as(VI, qv) - @as(VI, @splat(128)))) * splat(s[c / 32]);
            st(x + c, (v + ld(t + c)) + ld(p + c));
        }
    } else {
        @setFloatMode(fmode);
        for (0..D) |c| {
            const v = @as(f32, @floatFromInt(@as(i32, q[c]) - 128)) * s[c / 32];
            x[c] = (v + t[c]) + p[c];
        }
    }
    ln(x, slotF(e, 4), slotF(e, 5));
}

/// x[i] = LN(x[i] + src[i]) for one row.
fn residualLnRow(e: *Engine, src: [*]const f32, i: usize, g: [*]const f32, b: [*]const f32) void {
    const x = e.x + i * D;
    const y = src + i * D;
    if (manual) {
        var c: usize = 0;
        while (c < D) : (c += VW) st(x + c, ld(x + c) + ld(y + c));
    } else {
        for (0..D) |c| x[c] += y[c];
    }
    ln(x, g, b);
}

/// One head, query rows rb*64 .. +64: softmax(Q K^T / 8 + bias) V into CTX (Q is already / 8, see
/// sat_prepare). K and V come as panels of 16 columns (KT and VP, see kvStrip). See sat.wat's $attention.
fn attention(e: *Engine, tid: usize, h: usize, rb: usize) void {
    if (naive) return attentionNaive(e, tid, h, rb);
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
        if (manual) {
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
        } else {
            inv[m] = 1 / softmaxScalar(row, sp);
        }
    }
    // CTX[row0 + r][h] = (P[r][0..S] . V[0..S][h]) / sum[r]
    n = 0;
    while (n < 64) : (n += 16) mkRows(AMR, 16, r, sc, sp, e.h + (h * 4 + n / 16) * sp * 16, e.ctx + row0 * D + hoff + n, D, s, false, &e.zero);
    for (0..r) |m| {
        const out = e.ctx + (row0 + m) * D + hoff;
        if (manual) {
            const v = splat(inv[m]);
            var j: usize = 0;
            while (j < 64) : (j += VW) st(out + j, ld(out + j) * v);
        } else {
            for (0..64) |j| out[j] *= inv[m];
        }
    }
}

/// row[j] = e^(row[j] - max) in place; returns the sum.
fn softmaxScalar(row: [*]f32, n: usize) f32 {
    @setFloatMode(fmode);
    var mx: f32 = -3.0e38;
    for (0..n) |j| mx = @max(mx, row[j]);
    var sum: f32 = 0;
    for (0..n) |j| {
        row[j] = exps(row[j] - mx);
        sum += row[j];
    }
    return sum;
}

/// The textbook form (.naive): row by row, straight from Q, K, V.
fn attentionNaive(e: *Engine, tid: usize, h: usize, rb: usize) void {
    @setFloatMode(fmode);
    const sp = e.sp;
    const sc = e.scr + tid * SCR_STRIDE;
    const hoff = h * 64;
    const q = e.qkv;
    const k = e.qkv + BUF;
    const v = e.qkv + 2 * BUF;
    const row0 = rb * 64;
    for (row0..@min(row0 + 64, sp)) |i| {
        for (0..sp) |j| {
            var acc: f32 = 0;
            for (0..64) |d| acc += q[i * D + hoff + d] * k[j * D + hoff + d];
            sc[j] = acc + e.bias[j];
        }
        const inv = 1 / softmaxScalar(sc, sp);
        const out = e.ctx + i * D + hoff;
        for (0..64) |d| out[d] = 0;
        for (0..e.s) |j| {
            for (0..64) |d| out[d] += sc[j] * v[j * D + hoff + d];
        }
        for (0..64) |d| out[d] *= inv;
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
            if (mat != 0 and !naive) kvStrip(e, mat, n0);
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

fn futexWait(p: *u32, val: u32) void {
    _ = linux.futex_4arg(p, .{ .cmd = .WAIT, .private = true }, val, null);
}

fn futexWake(p: *u32, n: u32) void {
    _ = linux.futex_3arg(p, .{ .cmd = .WAKE, .private = true }, n);
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
    while (true) {
        const d = @atomicLoad(u32, &e.done, .seq_cst);
        if (d >= nt) break;
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
        if (manual) {
            var acc = splat(0);
            var k: usize = 0;
            while (k < D) : (k += VW) acc = madd(FM, ld(x + k), ld(e.wc[k..].ptr), acc);
            e.logits[i] = hsum(acc) + bc;
        } else {
            @setFloatMode(fmode);
            var acc: f32 = 0;
            for (0..D) |k| acc += x[k] * e.wc[k];
            e.logits[i] = acc + bc;
        }
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
    return e.slots[i];
}

/// Once all slots are filled: the 18 encoder matrices into panels, Q pre-scaled by 1/8 (exact, a power of 2),
/// worker threads started. 0 on success.
export fn sat_prepare(e: *Engine) i32 {
    for (e.slots) |s| if (s == null) return -1;
    for (0..3) |l| {
        const base = 6 + l * 22;
        if (!naive) {
            for (0..6) |m| {
                const n: usize = if (m == 4) FF else D;
                const k: usize = if (m == 5) FF else D;
                if (!toPanels(slotU8(e, base + 2 * m), slotF(e, base + 2 * m + 1), n, k)) return -2;
            }
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

/// Runs one op (OP_*) of the current layer on the state left by the last sat_run (for test/profile_native.ts).
export fn sat_step(e: *Engine, op: u32) void {
    run(e, op);
}

export fn sat_ntasks(e: *Engine, op: u32) u32 {
    return ntasks(e, op);
}

export fn sat_config() [*:0]const u8 {
    return std.fmt.comptimePrint("kernel={s} vw={d} mr={d} nr={d} amr={d} kc={d} fma={} fma_math={} fast={} spin={d}", .{
        @tagName(cfg.kernel), VW, MR, NR, AMR, KC, cfg.fma, cfg.fma_math, cfg.fast, cfg.spin,
    });
}

export fn sat_destroy(e: *Engine) void {
    @atomicStore(u32, &e.quit, 1, .seq_cst);
    _ = @atomicRmw(u32, &e.gen, .Add, 1, .seq_cst);
    futexWake(&e.gen, std.math.maxInt(i32));
    for (1..e.started + 1) |tid| e.threads[tid].join();
    for (e.slots) |s| if (s) |p| std.c.free(p);
    for ([_][*]f32{ e.x, e.qkv, e.ctx, e.tmp, e.h, e.scr }) |p| std.c.free(p);
    std.c.free(e);
}
