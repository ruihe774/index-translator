// Coding variance of upstream libopus 1.6.1: native scalar (intrinsics off) vs native SIMD (rtcd; NEON on
// aarch64, SSE/AVX2 on x86). SILK (RESTRICTED_SILK, 16 kHz mono) and CELT (RESTRICTED_CELT, 48 kHz mono/stereo)
// are measured separately, with the same shim.c configuration as the crates' compare.ts.
//
//   scripts/build-native.sh
//   deno run --allow-read --allow-write --allow-ffi --allow-run scripts/variance.ts [--quick] [--out=report.json]
//        [--audio=DIR] [--only-audio]
//
// Every run = one 3 s window (fresh encoder, so divergence is not inherited from earlier audio) x one config.
// A control (scalar vs a second scalar instance) is run alongside to prove the harness itself is deterministic.
// Both packet streams are decoded with the SAME scalar decoder, so differences come from the encoders only.
// Inputs: test/audio speech + synthetic signals. --audio=DIR adds every audio file in DIR (any format ffmpeg
// reads; decoded to 16 kHz mono for SILK, 48 kHz stereo for CELT, where mono configs get the L+R downmix);
// --only-audio drops the built-in signals (scripts/select-clips.ts cuts clips from long recordings).
//
// Reported, per group (overall, bitrate, complexity, format, channels, signal, worst cells), A = scalar, B = SIMD:
//   - hard invariants, which must be 0: decoder final range != encoder final range, bad TOC, lookahead mismatch
//     (exit status 1 if violated; the statistics below are only reported)
//   - %runs / %frames with a differing packet, first divergence, % of later frames that match again,
//     longest burst of differing frames, |packet length difference| of the differing frames
//   - signed and absolute ΔSNR against the input (B - A) and Δbytes %, with 95% CIs over runs: a bias means a bug,
//     float-order noise is symmetric
//   - SNR of the decoded A stream against the decoded B stream
//   - band-resolved log-spectral distance of the decoded streams (B - A; 21 CELT bands, 8 SILK bands of 1 kHz),
//     because SNR is dominated by the loud low bands and cannot see a defect in the top ones

const root = new URL('..', import.meta.url).pathname;
const quick = Deno.args.includes('--quick');
const outPath = Deno.args.find((a) => a.startsWith('--out='))?.slice(6);
const audioDir = Deno.args.find((a) => a.startsWith('--audio='))?.slice(8);
const onlyAudio = Deno.args.includes('--only-audio');
const WIN = 3; // seconds
const CAP = 1276;

// ---------- RNG / signals ----------
class Rng {
  s: bigint;
  constructor(seed: number) { this.s = BigInt(seed) * 0x9e3779b97f4a7c15n + 1n; }
  next(): number {
    let x = this.s;
    x ^= x >> 12n; x ^= (x << 25n) & 0xffffffffffffffffn; x ^= x >> 27n;
    this.s = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) >> 11n) / 2 ** 53;
  }
  int(lo: number, hi: number) { return lo + Math.floor(this.next() * (hi - lo)); }
}
const noise = (n: number, seed: number, amp: number) => { const r = new Rng(seed); return Float64Array.from({ length: n }, () => amp * (r.next() * 2 - 1)); };

function speechGen(n: number, fs: number, seed: number, gain = 3000): Float64Array {
  const rng = new Rng(seed), out = new Float64Array(n);
  let ph = 0, y0 = 0, y1 = 0, z0 = 0, z1 = 0;
  const a1 = 2 * 0.97 * Math.cos(2 * Math.PI * 700 / fs), a2 = -0.97 * 0.97;
  const b1 = 2 * 0.95 * Math.cos(2 * Math.PI * 1800 / fs), b2 = -0.95 * 0.95;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    ph += (110 + 25 * Math.sin(2 * Math.PI * 0.7 * t)) / fs; if (ph >= 1) ph -= 1;
    const x = (ph < 0.5 ? ph * 2 : ph * 2 - 2) * 0.6 + 0.01 * (rng.next() * 2 - 1);
    const y = x + a1 * y0 + a2 * y1; y1 = y0; y0 = y;
    const z = y * 0.3 + b1 * z0 + b2 * z1; z1 = z0; z0 = z;
    out[i] = Math.max(-32000, Math.min(32000, (0.25 * y + 0.1 * z) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2.5 * t)) * gain * 4));
  }
  return out;
}

// Chords of decaying harmonic notes + percussive noise bursts, up to the Nyquist.
function music(n: number, fs: number, seed: number): Float64Array {
  const rng = new Rng(seed), out = new Float64Array(n), seg = Math.floor(fs * 0.5);
  for (let s0 = 0; s0 < n; s0 += seg) {
    const roots = [0, 1, 2].map(() => 110 * 2 ** (rng.int(0, 36) / 12));
    const hat = rng.next() < 0.6;
    for (let i = 0; i < seg && s0 + i < n; i++) {
      const t = i / fs; let v = 0;
      for (const f0 of roots) for (let k = 1; k * f0 < fs / 2 * 0.95 && k <= 40; k++) v += Math.sin(2 * Math.PI * f0 * k * t) / k ** 1.2;
      v *= Math.exp(-2.5 * t) * 2500;
      if (hat) v += (rng.next() * 2 - 1) * 6000 * Math.exp(-40 * t);
      out[s0 + i] = Math.max(-32000, Math.min(32000, v));
    }
  }
  return out;
}

function readWav(path: string): Float64Array {
  const b = Deno.readFileSync(path), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
  for (let o = 12; o + 8 <= b.length; o += 8 + v.getUint32(o + 4, true) + (v.getUint32(o + 4, true) & 1)) {
    if (tag(o) === 'data') return Float64Array.from({ length: v.getUint32(o + 4, true) >> 1 }, (_, i) => v.getInt16(o + 8 + 2 * i, true));
  }
  throw new Error(path);
}
const upsample3 = (x: Float64Array) => Float64Array.from({ length: x.length * 3 }, (_, i) => { const j = Math.floor(i / 3), f = (i % 3) / 3; return x[j] * (1 - f) + (x[j + 1] ?? x[j]) * f; });

// x = mono (or left) channel; r = right channel when the source is real stereo (CELT only).
type Sig = { name: string; x: Float64Array; r?: Float64Array };

// Decodes any audio file with ffmpeg to interleaved s16 at `fs` with `ch` channels.
function ffDecode(path: string, fs: number, ch: number): Int16Array {
  const { code, stdout, stderr } = new Deno.Command('ffmpeg', { args: ['-v', 'error', '-i', path, '-f', 's16le', '-ac', String(ch), '-ar', String(fs), '-'] }).outputSync();
  if (code !== 0) throw new Error(`ffmpeg ${path}: ${new TextDecoder().decode(stderr)}`);
  return new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length >> 1);
}

function audioSignals(fs: number): Sig[] {
  const ch = fs === 48000 ? 2 : 1, sigs: Sig[] = [];
  const files = [...Deno.readDirSync(audioDir!)].filter((e) => e.isFile).map((e) => e.name).sort();
  for (const name of files) {
    const pcm = ffDecode(`${audioDir}/${name}`, fs, ch), n = pcm.length / ch;
    const l = Float64Array.from({ length: n }, (_, i) => pcm[i * ch]);
    const r = ch === 2 ? Float64Array.from({ length: n }, (_, i) => pcm[i * 2 + 1]) : undefined;
    for (let o = 0, k = 0; o + fs <= n; o += WIN * fs, k++) {
      sigs.push({ name: `audio:${name.replace(/\.[^.]*$/, '')}#${k}`, x: l.subarray(o, o + WIN * fs), r: r?.subarray(o, o + WIN * fs) });
    }
  }
  return sigs;
}

function signals(fs: number): Sig[] {
  const sec = fs, sigs: Sig[] = [];
  if (onlyAudio) return audioSignals(fs);
  const wavs = [...Deno.readDirSync(`${root}test/audio`)].filter((e) => e.name.endsWith('.wav')).map((e) => e.name).sort();
  for (const w of wavs) for (const g of [1, 0.25]) {
    let x = readWav(`${root}test/audio/${w}`);
    if (fs === 48000) x = upsample3(x);
    sigs.push({ name: `speech:${w.replace('.wav', '')}@${g}`, x: x.map((v) => v * g) });
  }
  const long = (name: string, x: Float64Array) => { for (let o = 0, k = 0; o + sec <= x.length; o += WIN * sec, k++) sigs.push({ name: `${name}#${k}`, x: x.subarray(o, Math.min(x.length, o + WIN * sec)) }); };
  long('synth-voiced', speechGen(9 * sec, fs, 1));
  long('synth-voiced-loud', speechGen(6 * sec, fs, 2, 9000));
  long('music', music(12 * sec, fs, 3));
  long('music-b', music(9 * sec, fs, 4));
  long('white-noise-2000', noise(6 * sec, 5, 2000));
  long('white-noise-200', noise(3 * sec, 6, 200));
  long('chirp', Float64Array.from({ length: 6 * sec }, (_, i) => 12000 * Math.sin(2 * Math.PI * (50 * i / sec + (fs / 2 - 100) / 6 * (i / sec) ** 2))));
  if (audioDir) sigs.push(...audioSignals(fs));
  return sigs;
}

// ---------- codec adapters ----------
type Enc = { encode(pcm: Int16Array | Float32Array): number; packet(n: number): Uint8Array; lookahead(): number; range(): number; destroy(): void };
type Dec = { decode(pkt: Uint8Array, pcm: Int16Array): number; range(): number; destroy(): void };
type Cfg = { name: string; ch: number; bitrate: number; cx: number; vbrc: number; float: boolean };
type Lib = { newEnc(c: Cfg): Enc; newDec(ch: number): Dec; version: string };

function loadLib(codec: 'silk' | 'celt', name: string): Lib {
  const silk = codec === 'silk';
  const lib = Deno.dlopen(`${root}target/native/mini${codec}-${name}.so`, {
    shim_enc_create: { parameters: silk ? ['i32', 'i32', 'i32', 'buffer'] : ['i32', 'i32', 'i32', 'i32', 'i32', 'buffer'], result: 'pointer' },
    shim_enc_destroy: { parameters: ['pointer'], result: 'void' },
    shim_enc_lookahead: { parameters: ['pointer'], result: 'i32' },
    shim_enc_final_range: { parameters: ['pointer'], result: 'u32' },
    shim_dec_final_range: { parameters: ['pointer'], result: 'u32' },
    shim_encode:{ parameters: ['pointer', 'buffer', 'buffer', 'i32'], result: 'i32' },
    shim_encode_float: { parameters: ['pointer', 'buffer', 'buffer', 'i32'], result: 'i32' },
    shim_dec_create: { parameters: silk ? ['buffer'] : ['i32', 'buffer'], result: 'pointer' },
    shim_dec_destroy: { parameters: ['pointer'], result: 'void' },
    shim_decode: { parameters: ['pointer', 'buffer', 'i32', 'buffer'], result: 'i32' },
    shim_version: { parameters: [], result: 'pointer' },
  });
  const s = lib.symbols;
  return {
    version: new Deno.UnsafePointerView(s.shim_version()!).getCString(),
    newEnc(c) {
      const err = new Int32Array(1);
      // deno-lint-ignore no-explicit-any
      const st = silk ? (s.shim_enc_create as any)(c.bitrate, c.cx, 0, err) : (s.shim_enc_create as any)(c.ch, c.bitrate, c.cx, c.vbrc, 0, err);
      if (!st) throw new Error(`${name} enc create ${err[0]}`);
      const out = new Uint8Array(CAP);
      return {
        encode: (pcm) => pcm instanceof Float32Array ? s.shim_encode_float(st, pcm, out, CAP) : s.shim_encode(st, pcm, out, CAP),
        packet: (n) => out.slice(0, n),
        lookahead: () => s.shim_enc_lookahead(st),
        range: () => s.shim_enc_final_range(st),
        destroy: () => s.shim_enc_destroy(st),
      };
    },
    newDec(ch) {
      const err = new Int32Array(1);
      // deno-lint-ignore no-explicit-any
      const st = silk ? (s.shim_dec_create as any)(err) : (s.shim_dec_create as any)(ch, err);
      if (!st) throw new Error(`dec create ${err[0]}`);
      return { decode: (p, pcm) => s.shim_decode(st, p, p.length, pcm), range: () => s.shim_dec_final_range(st), destroy: () => s.shim_dec_destroy(st) };
    },
  };
}

function configs(codec: 'silk' | 'celt'): Cfg[] {
  const cfgs: Cfg[] = []; let i = 0;
  const bitrates = codec === 'silk' ? (quick ? [8000, 16000, 32000, -1000] : [6000, 8000, 12000, 16000, 24000, 32000, 64000, -1000])
    : (quick ? [32000, 96000, 256000] : [16000, 32000, 64000, 96000, 128000, 256000]);
  const cxs = codec === 'silk' ? (quick ? [0, 5, 10] : [0, 2, 4, 6, 8, 10]) : (quick ? [0, 5, 10] : [0, 2, 5, 8, 10]);
  for (const ch of codec === 'silk' ? [1] : [1, 2]) for (const bitrate of bitrates) for (const cx of cxs) for (const float of [false, true]) {
    const vbrc = codec === 'celt' ? i & 1 : 0;
    cfgs.push({ name: `ch${ch} b${bitrate} c${cx} ${float ? 'f32' : 'i16'}${codec === 'celt' ? ` vbrc${vbrc}` : ''}`, ch, bitrate, cx, vbrc, float });
    i++;
  }
  return cfgs;
}

// ---------- one run ----------
type Res = {
  frames: number; divFrames: number; firstDiv: number; bytesA: number; bytesB: number;
  snrA: number; snrB: number; snrAB: number; lenAbsDiff: number;
  afterFrames: number; afterMatch: number; maxBurst: number; lenDiffs: number[]; // re-convergence, |packet length difference| per differing frame
  rangeBadA: number; rangeBadB: number; tocBadA: number; tocBadB: number; lookaheadBad: number; // invariants (must be 0)
  bandAbs: number[]; bandSgn: number[]; bandMax: number[]; bandN: number; // band-resolved log-spectral distance B-A (dB), summed over differing decoded frames x channels
};

// ---------- band-resolved log-spectral distance ----------
// CELT: the 21 eband5ms bands (200 Hz units at 5 ms resolution; 0-20 kHz). SILK: 8 uniform 1 kHz bands.
const CELT_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 34, 40, 48, 60, 78, 100].map((e) => e * 200);
const SILK_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((e) => e * 1000);
const bandEdges = (codec: 'silk' | 'celt') => codec === 'silk' ? SILK_EDGES : CELT_EDGES;

function makeBands(codec: 'silk' | 'celt') {
  const F = codec === 'silk' ? 320 : 960, fs = codec === 'silk' ? 16000 : 48000, NF = codec === 'silk' ? 512 : 1024;
  const edges = bandEdges(codec), nb = edges.length - 1;
  const win = Float64Array.from({ length: F }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / F));
  const w2 = win.reduce((a, v) => a + v * v, 0);
  const bins = edges.slice(0, nb).map((lo, b) => [Math.ceil(lo * NF / fs), Math.ceil(edges[b + 1] * NF / fs)]);
  // Floor: white noise of one int16 LSB (variance 1/12) in each bin, so that empty bands do not blow up the ratio.
  const floor = bins.map(([lo, hi]) => (hi - lo) * w2 / 12);
  const cos = Float64Array.from({ length: NF / 2 }, (_, i) => Math.cos(-2 * Math.PI * i / NF));
  const sin = Float64Array.from({ length: NF / 2 }, (_, i) => Math.sin(-2 * Math.PI * i / NF));
  const rev = new Uint32Array(NF);
  for (let i = 0, lg = Math.log2(NF); i < NF; i++) { let r = 0; for (let b = 0; b < lg; b++) if (i >> b & 1) r |= 1 << (lg - 1 - b); rev[i] = r; }
  const re = new Float64Array(NF), im = new Float64Array(NF);
  function energies(x: Int16Array | Float64Array, off: number, stride: number): Float64Array {
    re.fill(0); im.fill(0);
    for (let i = 0; i < F; i++) re[rev[i]] = x[off + i * stride] * win[i];
    for (let len = 2; len <= NF; len <<= 1) {
      const h = len >> 1, step = NF / len;
      for (let s = 0; s < NF; s += len) for (let k = 0; k < h; k++) {
        const a = s + k, b = a + h, c = cos[k * step], d = sin[k * step];
        const tr = re[b] * c - im[b] * d, ti = re[b] * d + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    return Float64Array.from(bins, ([lo, hi]) => { let e = 0; for (let k = lo; k < hi; k++) e += re[k] * re[k] + im[k] * im[k]; return e; });
  }
  return { nb, floor, energies };
}
const bandTools = { silk: makeBands('silk'), celt: makeBands('celt') };

function snr(ref: Float64Array, dec: Float64Array, delay: number) {
  let s = 0, e = 0;
  for (let i = 0; i + delay < dec.length && i < ref.length; i++) {
    const r = Math.max(-32768, Math.min(32767, ref[i])); s += r * r; e += (r - dec[i + delay]) ** 2;
  }
  return s === 0 ? NaN : 10 * Math.log10(s / Math.max(e, 1e-9));
}

function run(codec: 'silk' | 'celt', A: Lib, B: Lib, decLib: Lib, sig: Sig, cfg: Cfg): Res {
  const F = codec === 'silk' ? 320 : 960, ch = cfg.ch, N = F * ch, x = sig.x, xr = sig.r;
  // Mono config of a stereo source: L+R downmix. Stereo config of a mono source: L = x, R = delayed,
  // attenuated copy plus a little uncorrelated noise.
  const nFrames = Math.floor(x.length / F);
  const inter = new Float64Array(nFrames * N);
  const nz = ch === 2 && !xr ? noise(nFrames * F, 77, 150) : undefined;
  for (let i = 0; i < nFrames * F; i++) {
    if (ch === 1) inter[i] = xr ? (x[i] + xr[i]) / 2 : x[i];
    else { inter[2 * i] = x[i]; inter[2 * i + 1] = xr ? xr[i] : 0.7 * (x[i - 7] ?? 0) + nz![i]; }
  }
  const eA = A.newEnc(cfg), eB = B.newEnc(cfg), dA = decLib.newDec(ch), dB = decLib.newDec(ch);
  const decA = new Float64Array(nFrames * N), decB = new Float64Array(nFrames * N), pcmD = new Int16Array(N);
  const pcmI = new Int16Array(N), pcmF = new Float32Array(N);
  const bt = bandTools[codec];
  const r: Res = {
    frames: nFrames, divFrames: 0, firstDiv: -1, bytesA: 0, bytesB: 0, snrA: 0, snrB: 0, snrAB: NaN, lenAbsDiff: 0,
    afterFrames: 0, afterMatch: 0, maxBurst: 0, lenDiffs: [], rangeBadA: 0, rangeBadB: 0, tocBadA: 0, tocBadB: 0,
    lookaheadBad: eA.lookahead() !== eB.lookahead() ? 1 : 0,
    bandAbs: new Array(bt.nb).fill(0), bandSgn: new Array(bt.nb).fill(0), bandMax: new Array(bt.nb).fill(0), bandN: 0,
  };
  const chk = (w: string, v: number) => { if (v < 0) throw new Error(`${w}: ${v}`); return v; };
  // TOC as minisilk/minicelt produce it: SILK-only wideband 20 ms (0x48..), CELT-only 20 ms, one frame, stereo bit <= channels.
  const tocOk = (p: Uint8Array) => codec === 'silk' ? p.length >= 1 && (p[0] & 0xfc) === 0x48
    : p.length >= 1 && (p[0] & 0x80) !== 0 && ((p[0] >> 3) & 3) === 3 && (p[0] & 3) === 0 && ((p[0] >> 2) & 1) <= ch - 1;
  let burst = 0;
  for (let f = 0; f < nFrames; f++) {
    const seg = inter.subarray(f * N, (f + 1) * N);
    let pa: Uint8Array, pb: Uint8Array;
    if (cfg.float) {
      for (let i = 0; i < N; i++) pcmF[i] = Math.fround(seg[i] / 32768);
      pa = eA.packet(chk('encA', eA.encode(pcmF))); pb = eB.packet(chk('encB', eB.encode(pcmF)));
    } else {
      for (let i = 0; i < N; i++) pcmI[i] = Math.max(-32768, Math.min(32767, Math.round(seg[i])));
      pa = eA.packet(chk('encA', eA.encode(pcmI))); pb = eB.packet(chk('encB', eB.encode(pcmI)));
    }
    r.bytesA += pa.length; r.bytesB += pb.length;
    const differs = pa.length !== pb.length || pa.some((v, i) => v !== pb[i]);
    if (r.firstDiv >= 0) { r.afterFrames++; if (!differs) r.afterMatch++; }
    if (differs) {
      r.divFrames++; if (r.firstDiv < 0) r.firstDiv = f;
      r.lenAbsDiff += Math.abs(pa.length - pb.length); r.lenDiffs.push(Math.abs(pa.length - pb.length));
      r.maxBurst = Math.max(r.maxBurst, ++burst);
    } else burst = 0;
    if (!tocOk(pa)) r.tocBadA++;
    if (!tocOk(pb)) r.tocBadB++;
    const rangeA = eA.range(), rangeB = eB.range();
    if (chk('decA', dA.decode(pa, pcmD)) !== F) throw new Error('short decode A');
    decA.set(pcmD, f * N);
    // A 1-2 byte packet (DTX) carries no frame, so the decoder runs PLC and reports range 0.
    if (pa.length > 2 && dA.range() !== rangeA) r.rangeBadA++;
    if (chk('decB', dB.decode(pb, pcmD)) !== F) throw new Error('short decode B');
    decB.set(pcmD, f * N);
    if (pb.length > 2 && dB.range() !== rangeB) r.rangeBadB++;
    // Band-resolved distance for every frame whose decoded output differs (decoder state keeps differing after a packet flip).
    if (r.firstDiv >= 0) {
      for (let c = 0; c < ch; c++) {
        let same = true;
        for (let i = 0; i < F && same; i++) same = decA[f * N + i * ch + c] === decB[f * N + i * ch + c];
        if (same) continue;
        const ea = bt.energies(decA, f * N + c, ch), eb = bt.energies(decB, f * N + c, ch);
        for (let b = 0; b < bt.nb; b++) {
          const d = 10 * Math.log10((eb[b] + bt.floor[b]) / (ea[b] + bt.floor[b]));
          r.bandAbs[b] += Math.abs(d); r.bandSgn[b] += d; r.bandMax[b] = Math.max(r.bandMax[b], Math.abs(d));
        }
        r.bandN++;
      }
    }
  }
  const delay = eA.lookahead() * ch;
  r.snrA = snr(inter, decA, delay); r.snrB = snr(inter, decB, delay);
  if (r.divFrames) r.snrAB = abSnr(decA, decB);
  eA.destroy(); eB.destroy(); dA.destroy(); dB.destroy();
  return r;
}
function abSnr(a: Float64Array, b: Float64Array) { let s = 0, e = 0; for (let i = 0; i < a.length; i++) { s += a[i] * a[i]; e += (a[i] - b[i]) ** 2; } return s === 0 ? NaN : 10 * Math.log10(s / Math.max(e, 1e-9)); }

// ---------- statistics ----------
const fin = (a: number[]) => a.filter(Number.isFinite);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || NaN);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const q = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ci = (a: number[]) => 1.96 * sd(a) / Math.sqrt(a.length || NaN);
const f = (v: number, d = 2) => Number.isFinite(v) ? v.toFixed(d) : '-';

type Row = { sig: string; cfg: Cfg; r: Res };
function summarize(label: string, rows: Row[]) {
  const div = rows.filter((x) => x.r.divFrames > 0);
  const frames = rows.reduce((a, x) => a + x.r.frames, 0), dfr = rows.reduce((a, x) => a + x.r.divFrames, 0);
  const dS = fin(rows.map((x) => x.r.snrB - x.r.snrA));
  const dB = rows.map((x) => 100 * (x.r.bytesB - x.r.bytesA) / x.r.bytesA);
  const dBd = div.map((x) => 100 * (x.r.bytesB - x.r.bytesA) / x.r.bytesA);
  const dSd = fin(div.map((x) => x.r.snrB - x.r.snrA));
  const lenDiffs = rows.flatMap((x) => x.r.lenDiffs);
  const out = {
    label, runs: rows.length, pctRunsDiff: 100 * div.length / rows.length, pctFramesDiff: 100 * dfr / frames,
    medFirstDiv: q(div.map((x) => x.r.firstDiv), 0.5),
    dSnrMean: mean(dS), dSnrCI: ci(dS), dSnrAbsMean: mean(dS.map(Math.abs)), dSnrAbsP95: q(dS.map(Math.abs), 0.95), dSnrAbsMax: Math.max(...dS.map(Math.abs), 0),
    dSnrDivMean: mean(dSd),
    dBytesMean: mean(dB), dBytesCI: ci(dB), dBytesAbsMean: mean(dB.map(Math.abs)), dBytesAbsMax: Math.max(...dB.map(Math.abs), 0), dBytesDivAbsMean: mean(dBd.map(Math.abs)),
    meanAbsLenDiffPerDivFrame: div.length ? rows.reduce((a, x) => a + x.r.lenAbsDiff, 0) / Math.max(1, dfr) : 0,
    snrABMed: q(fin(div.map((x) => x.r.snrAB)), 0.5), snrABMin: Math.min(...fin(div.map((x) => x.r.snrAB)), Infinity),
    // Re-convergence: share of the frames after a run's first divergence whose packet matches again, and burst lengths.
    pctMatchAfter: 100 * div.reduce((a, x) => a + x.r.afterMatch, 0) / Math.max(1, div.reduce((a, x) => a + x.r.afterFrames, 0)),
    burstP95: q(div.map((x) => x.r.maxBurst), 0.95), burstMax: Math.max(...div.map((x) => x.r.maxBurst), 0),
    lenDiffMean: mean(lenDiffs), lenDiffP99: q(lenDiffs, 0.99), lenDiffMax: lenDiffs.reduce((a, v) => Math.max(a, v), 0),
    inv: {
      rangeBadA: rows.reduce((a, x) => a + x.r.rangeBadA, 0), rangeBadB: rows.reduce((a, x) => a + x.r.rangeBadB, 0),
      tocBadA: rows.reduce((a, x) => a + x.r.tocBadA, 0), tocBadB: rows.reduce((a, x) => a + x.r.tocBadB, 0),
      lookaheadBad: rows.reduce((a, x) => a + x.r.lookaheadBad, 0),
    },
    // Per band: mean |LSD|, frame-weighted signed mean (B - A), its 95% CI over runs, worst frame.
    bands: bandSum(rows),
  };
  return out;
}
function bandSum(rows: Row[]) {
  const nb = rows[0]?.r.bandAbs.length ?? 0, withBands = rows.filter((x) => x.r.bandN > 0);
  return Array.from({ length: nb }, (_, b) => {
    const n = withBands.reduce((a, x) => a + x.r.bandN, 0);
    const runMeans = withBands.map((x) => x.r.bandSgn[b] / x.r.bandN);
    return {
      abs: withBands.reduce((a, x) => a + x.r.bandAbs[b], 0) / (n || NaN), sgn: withBands.reduce((a, x) => a + x.r.bandSgn[b], 0) / (n || NaN),
      sgnCI: ci(runMeans), max: Math.max(...withBands.map((x) => x.r.bandMax[b]), 0), n,
    };
  });
}
type Sum = ReturnType<typeof summarize>;
function printTable(title: string, sums: Sum[]) {
  console.log(`\n${title}`);
  const cols: [string, (s: Sum) => string][] = [
    ['group', (s) => s.label], ['runs', (s) => String(s.runs)], ['%runs≠', (s) => f(s.pctRunsDiff, 1)], ['%frames≠', (s) => f(s.pctFramesDiff, 3)],
    ['1stDiv(med)', (s) => f(s.medFirstDiv, 0)],
    ['ΔSNR mean±CI dB', (s) => `${f(s.dSnrMean, 5)}±${f(s.dSnrCI, 5)}`], ['|ΔSNR| mean/p95/max', (s) => `${f(s.dSnrAbsMean, 5)}/${f(s.dSnrAbsP95, 4)}/${f(s.dSnrAbsMax, 3)}`],
    ['Δbytes% mean±CI', (s) => `${f(s.dBytesMean, 5)}±${f(s.dBytesCI, 5)}`], ['|Δbytes%| mean/max', (s) => `${f(s.dBytesAbsMean, 5)}/${f(s.dBytesAbsMax, 3)}`],
    ['A-vs-B SNR med/min dB', (s) => `${f(s.snrABMed, 1)}/${f(s.snrABMin, 1)}`],
  ];
  const w = cols.map(([h, g]) => Math.max(h.length, ...sums.map((s) => g(s).length)));
  console.log(cols.map(([h], i) => h.padEnd(w[i])).join('  '));
  for (const s of sums) console.log(cols.map(([, g], i) => g(s).padEnd(w[i])).join('  '));
}

// Re-convergence and packet-length structure of the divergences.
function printStructure(title: string, sums: Sum[]) {
  console.log(`\n${title}`);
  const cols: [string, (s: Sum) => string][] = [
    ['group', (s) => s.label], ['runs≠', (s) => String(Math.round(s.runs * s.pctRunsDiff / 100))],
    ['%match after 1stDiv', (s) => f(s.pctMatchAfter, 1)], ['burst p95/max (frames)', (s) => `${f(s.burstP95, 0)}/${f(s.burstMax, 0)}`],
    ['|Δlen| per ≠frame mean/p99/max (B)', (s) => `${f(s.lenDiffMean, 2)}/${f(s.lenDiffP99, 0)}/${f(s.lenDiffMax, 0)}`],
  ];
  const w = cols.map(([h, g]) => Math.max(h.length, ...sums.map((s) => g(s).length)));
  console.log(cols.map(([h], i) => h.padEnd(w[i])).join('  '));
  for (const s of sums) console.log(cols.map(([, g], i) => g(s).padEnd(w[i])).join('  '));
}

function printBands(title: string, codec: 'silk' | 'celt', s: Sum) {
  const e = bandEdges(codec);
  console.log(`\n${title} (B - A, ${s.bands[0]?.n ?? 0} differing decoded frames x channels)`);
  console.log('band  range(Hz)        mean|LSD| dB  signed mean±CI dB      worst frame dB');
  s.bands.forEach((b, i) => console.log(`${String(i).padEnd(4)}  ${`${e[i]}-${e[i + 1]}`.padEnd(15)}  ${f(b.abs, 4).padEnd(12)}  ${`${f(b.sgn, 4)}±${f(b.sgnCI, 4)}`.padEnd(20)}  ${f(b.max, 2)}`));
}

// ---------- main ----------
const report: Record<string, unknown> = {};
let failed = false; // an invariant was violated (the statistics themselves are only reported, never gated)
// Which SIMD kernels the rtcd build picked at runtime (opus_select_arch; aarch64: 3 = NEON dotprod; x86: 4 = AVX2).
for (const codec of ['silk', 'celt']) {
  try {
    const l = Deno.dlopen(`${root}target/native/mini${codec}-rtcd.so`, { opus_select_arch: { parameters: [], result: 'i32' } });
    console.log(`${codec} rtcd opus_select_arch = ${l.symbols.opus_select_arch()}`);
  } catch (e) { console.log(`${codec} rtcd opus_select_arch unavailable: ${e}`); }
}
console.log(`host: ${Deno.build.target}`);
const scalar =(c: 'silk' | 'celt') => loadLib(c, 'scalar'), simd = (c: 'silk' | 'celt') => loadLib(c, 'rtcd');
for (const codec of ['silk', 'celt'] as const) {
  const A = scalar(codec), B = simd(codec), A2 = scalar(codec);
  const sigs = signals(codec === 'silk' ? 16000 : 48000), cfgs = configs(codec);
  console.log(`\n=== ${codec.toUpperCase()}: ${A.version}; ${sigs.length} windows x ${cfgs.length} configs = ${sigs.length * cfgs.length} runs, ` +
    `${(sigs.reduce((a, s) => a + s.x.length, 0) / (codec === 'silk' ? 16000 : 48000)).toFixed(1)} s of audio ===`);
  const rows: Row[] = [], ctrl: Row[] = [];
  const t0 = performance.now();
  for (const sig of sigs) for (const cfg of cfgs) {
    rows.push({ sig: sig.name, cfg, r: run(codec, A, B, A, sig, cfg) });
    ctrl.push({ sig: sig.name, cfg, r: run(codec, A, A2, A, sig, cfg) });
  }
  console.log(`done in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  const c = summarize('control (scalar vs scalar)', ctrl);
  console.log(`control: ${f(c.pctRunsDiff, 2)}% runs differ (must be 0)`);
  const all = summarize('ALL', rows);
  // Hard invariants: independent of the oracle; A = scalar, B = SIMD. All must be 0.
  const inv = all.inv;
  console.log(`invariants (must be 0): decoder-vs-encoder final range mismatches scalar ${inv.rangeBadA} / SIMD ${inv.rangeBadB}; ` +
    `bad TOC scalar ${inv.tocBadA} / SIMD ${inv.tocBadB}; lookahead mismatches ${inv.lookaheadBad}`);
  const invBad = inv.rangeBadA + inv.rangeBadB + inv.tocBadA + inv.tocBadB + inv.lookaheadBad + c.inv.rangeBadA + c.inv.rangeBadB;
  if (invBad) { console.log('INVARIANT VIOLATIONS'); failed = true; }

  const by = (key: (r: Row) => string, order?: string[]) => {
    const m = new Map<string, Row[]>();
    for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
    const keys = order ?? [...m.keys()];
    return keys.filter((k) => m.has(k)).map((k) => summarize(k, m.get(k)!));
  };
  printTable(`${codec.toUpperCase()} overall`, [all]);
  printStructure(`${codec.toUpperCase()} divergence structure, overall`, [all]);
  printTable(`${codec.toUpperCase()} by bitrate`, by((r) => `b=${r.cfg.bitrate}`));
  printTable(`${codec.toUpperCase()} by complexity`, by((r) => `c=${r.cfg.cx}`, [...Array(11).keys()].map((i) => `c=${i}`)));
  printTable(`${codec.toUpperCase()} by input format`, by((r) => r.cfg.float ? 'f32' : 'i16'));
  if (codec === 'celt') printTable('CELT by channels', by((r) => `ch=${r.cfg.ch}`));
  printTable(`${codec.toUpperCase()} by signal class`, by((r) => r.sig.replace(/#\d+$/, '').replace(/^(speech):.*@(.*)$/, '$1@$2')));
  // Per cell (channels x bitrate x complexity, formats pooled): the gates should hold per cell, not only on average.
  const cells = by((r) => `ch${r.cfg.ch} b${r.cfg.bitrate} c${r.cfg.cx}`);
  const worst = [...cells].sort((a, b) => b.pctFramesDiff - a.pctFramesDiff).slice(0, 8);
  printTable(`${codec.toUpperCase()} worst ${worst.length} of ${cells.length} cells by %frames≠`, worst);
  printStructure(`${codec.toUpperCase()} divergence structure, same cells`, worst);
  const mx = (g: (s: Sum) => number) => Math.max(...cells.map(g));
  console.log(`worst over all ${cells.length} cells: %frames≠ ${f(mx((s) => s.pctFramesDiff), 3)}, |ΔSNR| ${f(mx((s) => s.dSnrAbsMax), 4)} dB, ` +
    `|mean ΔSNR| ${f(mx((s) => Math.abs(s.dSnrMean)), 5)} dB, |Δbytes| ${f(mx((s) => s.dBytesAbsMax), 4)} %, |mean Δbytes| ${f(mx((s) => Math.abs(s.dBytesMean)), 5)} %, ` +
    `min A-vs-B SNR ${f(Math.min(...cells.map((s) => s.snrABMin)), 1)} dB, min %match after 1stDiv ${f(Math.min(...cells.filter((s) => s.pctRunsDiff > 0).map((s) => s.pctMatchAfter)), 1)}`);
  if (all.bands[0]?.n) printBands(`${codec.toUpperCase()} band-resolved distance, all`, codec, all);
  if (codec === 'celt') {
    const hi = summarize('ch2 c>=8', rows.filter((r) => r.cfg.ch === 2 && r.cfg.cx >= 8));
    if (hi.bands[0]?.n) printBands('CELT band-resolved distance, stereo complexity >= 8', codec, hi);
  }
  report[codec] = { control: c, all, cells, rows: rows.map((x) => ({ sig: x.sig, cfg: x.cfg.name, ...x.r })) };
}
if (outPath) Deno.writeTextFileSync(outPath, JSON.stringify(report));
if (failed) Deno.exit(1);
