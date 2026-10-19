// Differential test of the minicelt wasm builds against builds of the libopus C reference.
//
//   scripts/test.sh celt [--quick] [--all] [--refs-only] [audio files...]
//   (= scripts/build-native.sh && scripts/build.sh celt all both &&
//      deno run --allow-read --allow-ffi --allow-run minicelt/test/compare.ts [flags] [audio files...])
//
// Implementations (all behind one adapter, `Impl`/`Enc`, with the shim.c API):
//   scalar   target/native/minicelt-scalar.so   upstream libopus 1.6.1, intrinsics off (Deno FFI)
//   rtcd     target/native/minicelt-rtcd.so     upstream with SSE/AVX2 and runtime detection (FFI)
//   cwasm2   target/native/minicelt-cwasm2.wasm the fork's C (celt/wasm, silk/wasm kernels), -msimd128
//   cwasm3   target/native/minicelt-cwasm3.wasm  same with -mrelaxed-simd (minicelt/test/build-cwasm.sh)
//   wasm2, wasm2-checked, wasm3, wasm3-checked   target/minicelt-wasm{2,3}[-checked].wasm
// For each pairing it encodes the same input with both implementations and compares packets,
// OPUS_GET_FINAL_RANGE, OPUS_GET_IN_DTX, ctl return codes and lookahead frame by frame.
// Exact pairs (a mismatch fails the test): cwasm2 = wasm2 = wasm2-checked and cwasm3 = wasm3 =
// wasm3-checked, i.e. each minicelt build against the fork's C built with the same SIMD kernels and
// run in the same engine. This is the only possible reference: the fork's float SIMD kernels
// (celt_inner_prod, xcorr, op_pvq_search, ...) sum in lane order like SSE/NEON, not in the C order,
// so native scalar libopus is NOT bit-exact with wasm2 (checked: the fork's C built with its kernels
// disabled matches scalar in every run), and with relaxed SIMD f32x4.relaxed_madd is additionally
// fused by V8 on FMA hardware. Informational pairs (reported, never fail): scalar and rtcd vs the
// minicelt/C-wasm builds, and cwasm2 vs cwasm3 (the effect of FMA). `--strict-scalar` makes
// scalar vs wasm2/wasm2-checked exact pairs (they hold only for a build without the SIMD float kernels).
// The cwasm builds are optional (they need wasi-sdk): without them these exact pairs are skipped.
// Tolerance gate (the oracle that needs no fork): the minicelt builds are also judged against upstream scalar by
// effects instead of packets (see GATE and gateReport): ctl codes and lookahead, mean SNR and size deltas, per-run
// bounds, in_dtx agreement, and band-resolved log-spectral distance of the decoded streams. The bounds come from
// scripts/variance.ts on upstream's own scalar-vs-SIMD builds (aarch64 NEON, x86-64 AVX2); scalar vs rtcd runs through
// the same checks as the baseline (reported, not gated). In --quick the band checks are informational.
// Any trap, native decoder rejection, bad TOC or encoder/decoder final range mismatch of any
// implementation fails the test.
// Every packet is also decoded by the native (scalar) decoder, whose final range must equal the
// encoder's (the bitstream check from opus_demo); the SNR of both decoded streams is reported.
//
// Flags: --quick (each run is a 3 s window, 3 signals per configuration, fewer configurations; < 2 min),
// --filter=text (only runs whose "signal [config]" contains text), --all (every signal for every configuration), --refs-only (self-check of the references: scalar vs
// cwasm2 exact, cwasm3 and rtcd informational; needs no minicelt wasm).
// The speech corpus is test/audio/*.wav (16 kHz mono 16-bit, upsampled x3 here; see
// THIRD_PARTY_NOTICES.md). Audio files given as arguments replace it; other formats go through ffmpeg.

const root = new URL('../..', import.meta.url).pathname;
const FRAME = 960;
const CAP = 1276;
const quick = Deno.args.includes('--quick');
const allSigs = Deno.args.includes('--all');
const refsOnly = Deno.args.includes('--refs-only');
const strictScalar = Deno.args.includes('--strict-scalar');
const filter = Deno.args.find((a) => a.startsWith('--filter='))?.slice(9); // only runs whose name contains this
const files = Deno.args.filter((a) => !a.startsWith('--'));

// ---------- adapter ----------

// ctl indices: bitrate, complexity, vbr_constraint, dtx, packet_loss_perc, bandwidth
const CTL = ['bitrate', 'complexity', 'vbr_constraint', 'dtx', 'packet_loss_perc', 'bandwidth'];

type Enc = {
  ctl(which: number, v: number): number;
  lookahead(): number;
  range(): number;
  inDtx(): number;
  encode(pcm: Int16Array | Float32Array): number; // packet length or negative error
  packet(len: number): Uint8Array;
  destroy(): void;
};
type Impl = { name: string; create(ch: number, bitrate: number, cx: number, vbrc: number, dtx: number): Enc; reset(): Promise<void> };
type Cfg = {
  name: string; ch: number; bitrate: number; complexity: number; vbrc: number; dtx: number; float: 0 | 1 | 2; // 2 = alternate per frame
  scale?: number; plc?: number; bw?: number; dynamic?: number;
};

// ---------- native libopus (FFI) ----------

function loadNative(name: string) {
  const lib = Deno.dlopen(`${root}target/native/minicelt-${name}.so`, {
    shim_enc_create: { parameters: ['i32', 'i32', 'i32', 'i32', 'i32', 'buffer'], result: 'pointer' },
    shim_enc_destroy: { parameters: ['pointer'], result: 'void' },
    shim_enc_set_bitrate: { parameters: ['pointer', 'i32'], result: 'i32' },
    shim_enc_set_complexity: { parameters: ['pointer', 'i32'], result: 'i32' },
    shim_enc_set_vbr_constraint: { parameters: ['pointer', 'i32'], result: 'i32' },
    shim_enc_set_dtx: { parameters: ['pointer', 'i32'], result: 'i32' },
    shim_enc_set_packet_loss_perc: { parameters: ['pointer', 'i32'], result: 'i32' },
    shim_enc_set_bandwidth: { parameters: ['pointer', 'i32'], result: 'i32' },
    shim_enc_lookahead: { parameters: ['pointer'], result: 'i32' },
    shim_enc_final_range: { parameters: ['pointer'], result: 'u32' },
    shim_enc_in_dtx: { parameters: ['pointer'], result: 'i32' },
    shim_encode: { parameters: ['pointer', 'buffer', 'buffer', 'i32'], result: 'i32' },
    shim_encode_float: { parameters: ['pointer', 'buffer', 'buffer', 'i32'], result: 'i32' },
    shim_dec_create: { parameters: ['i32', 'buffer'], result: 'pointer' },
    shim_dec_destroy: { parameters: ['pointer'], result: 'void' },
    shim_decode: { parameters: ['pointer', 'buffer', 'i32', 'buffer'], result: 'i32' },
    shim_dec_final_range: { parameters: ['pointer'], result: 'u32' },
    shim_version: { parameters: [], result: 'pointer' },
  });
  const s = lib.symbols;
  const setters = [s.shim_enc_set_bitrate, s.shim_enc_set_complexity, s.shim_enc_set_vbr_constraint, s.shim_enc_set_dtx,
    s.shim_enc_set_packet_loss_perc, s.shim_enc_set_bandwidth];
  const impl: Impl = {
    name,
    reset: async () => {},
    create(ch, bitrate, cx, vbrc, dtx) {
      const err = new Int32Array(1);
      const st = s.shim_enc_create(ch, bitrate, cx, vbrc, dtx, err);
      if (!st) throw new Error(`${name} create: ${err[0]}`);
      const out = new Uint8Array(CAP);
      return {
        ctl: (w, v) => setters[w](st, v),
        lookahead: () => s.shim_enc_lookahead(st),
        range: () => s.shim_enc_final_range(st),
        inDtx: () => s.shim_enc_in_dtx(st),
        encode: (pcm) => pcm instanceof Float32Array ? s.shim_encode_float(st, pcm, out, CAP) : s.shim_encode(st, pcm, out, CAP),
        packet: (len) => out.slice(0, len),
        destroy: () => s.shim_enc_destroy(st),
      };
    },
  };
  const version = new Deno.UnsafePointerView(s.shim_version()!).getCString();
  const decoder = (ch: number) => {
    const err = new Int32Array(1);
    const st = s.shim_dec_create(ch, err);
    if (!st) throw new Error(`decoder create: ${err[0]}`);
    return {
      decode: (pkt: Uint8Array, pcm: Int16Array) => s.shim_decode(st, pkt, pkt.length, pcm),
      range: () => s.shim_dec_final_range(st),
      destroy: () => s.shim_dec_destroy(st),
    };
  };
  return { impl, version, decoder };
}

// ---------- C reference built for wasm (cwasm2/cwasm3) ----------

// wasm32-wasip1 reactor; it imports nothing today, but stub whatever WASI imports a toolchain adds.
function wasiImports(module: WebAssembly.Module) {
  const wasi: Record<string, WebAssembly.ImportValue> = {};
  for (const i of WebAssembly.Module.imports(module)) {
    if (i.module === 'wasi_snapshot_preview1' && i.kind === 'function') {
      wasi[i.name] = i.name === 'proc_exit' ? (c: number) => { throw new Error(`proc_exit(${c})`); }
        : i.name === 'random_get' ? () => 0 : () => 52; // ENOSYS
    } else {
      throw new Error(`unexpected import ${i.module}.${i.name}`);
    }
  }
  return { wasi_snapshot_preview1: wasi };
}

async function loadCWasm(variant: number): Promise<Impl> {
  const name = `cwasm${variant}`;
  const path = `${root}target/native/minicelt-${name}.wasm`;
  const module = await WebAssembly.compile(await Deno.readFile(path));
  // deno-lint-ignore no-explicit-any
  const impl = { name, e: undefined as any, reset: async () => {} } as any;
  impl.reset = async () => {
    const inst = await WebAssembly.instantiate(module, wasiImports(module));
    impl.e = inst.exports;
    impl.e._initialize();
  };
  await impl.reset();
  impl.create = (ch: number, bitrate: number, cx: number, vbrc: number, dtx: number): Enc => {
    const e = impl.e;
    const errp = e.malloc(4), inp = e.malloc(FRAME * 2 * 4), outp = e.malloc(CAP);
    const mem = () => e.memory.buffer as ArrayBuffer;
    const st = e.shim_enc_create(ch, bitrate, cx, vbrc, dtx, errp);
    if (!st) throw new Error(`${name} create: ${new Int32Array(mem(), errp, 1)[0]}`);
    const setters = [e.shim_enc_set_bitrate, e.shim_enc_set_complexity, e.shim_enc_set_vbr_constraint, e.shim_enc_set_dtx,
      e.shim_enc_set_packet_loss_perc, e.shim_enc_set_bandwidth];
    return {
      ctl: (w, v) => setters[w](st, v),
      lookahead: () => e.shim_enc_lookahead(st),
      range: () => e.shim_enc_final_range(st) >>> 0,
      inDtx: () => e.shim_enc_in_dtx(st),
      encode(pcm) {
        new Uint8Array(mem(), inp, pcm.byteLength).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        return pcm instanceof Float32Array ? e.shim_encode_float(st, inp, outp, CAP) : e.shim_encode(st, inp, outp, CAP);
      },
      packet: (len) => new Uint8Array(mem(), outp, len).slice(),
      destroy() { e.shim_enc_destroy(st); e.free(errp); e.free(inp); e.free(outp); },
    };
  };
  return impl as Impl;
}

// ---------- minicelt wasm ----------

// `checked` builds keep debug_assert!s and overflow checks; a failing one traps.
async function loadMini(variant: number, checked: boolean): Promise<Impl> {
  const name = `wasm${variant}${checked ? '-checked' : ''}`;
  const module = await WebAssembly.compile(await Deno.readFile(`${root}target/minicelt-${name}.wasm`));
  // deno-lint-ignore no-explicit-any
  const impl = { name, e: undefined as any, reset: async () => {} } as any;
  // After a trap the pseudostack is left unbalanced, so the instance is replaced.
  impl.reset = async () => {
    impl.e = (await WebAssembly.instantiate(module, wasiImports(module))).exports;
    impl.e._initialize?.(); // the Rust builds have no start function (nor imports)
  };
  await impl.reset();
  impl.create = (ch: number, bitrate: number, cx: number, vbrc: number, dtx: number): Enc => {
    const e = impl.e;
    const r = e.minicelt_init(ch, bitrate, cx, vbrc, dtx);
    if (r < 0) throw new Error(`${name} minicelt_init: ${r}`);
    const setters = [e.minicelt_set_bitrate, e.minicelt_set_complexity, e.minicelt_set_vbr_constraint, e.minicelt_set_dtx,
      e.minicelt_set_packet_loss_perc, e.minicelt_set_bandwidth];
    return {
      ctl: (w, v) => setters[w](v),
      lookahead: () => e.minicelt_lookahead(),
      range: () => e.minicelt_final_range() >>> 0,
      inDtx: () => e.minicelt_in_dtx(),
      encode(pcm) {
        const n = FRAME * ch;
        if (pcm instanceof Float32Array) {
          new Float32Array(e.memory.buffer, e.minicelt_input_ptr(), n).set(pcm);
          return e.minicelt_encode();
        }
        new Int16Array(e.memory.buffer, e.minicelt_input_i16_ptr(), n).set(pcm);
        return e.minicelt_encode_i16();
      },
      packet: (len) => new Uint8Array(e.memory.buffer, e.minicelt_output_ptr(), len).slice(),
      destroy: () => {},
    };
  };
  return impl as Impl;
}

// ---------- signals (48 kHz, [L, R], amplitudes in 16-bit units) ----------

class Rng {
  s: bigint;
  constructor(seed: number) {
    this.s = BigInt(seed) * 0x9e3779b97f4a7c15n + 1n;
  }
  next(): number { // xorshift64*, uniform in [0, 1)
    let x = this.s;
    x ^= x >> 12n; x ^= (x << 25n) & 0xffffffffffffffffn; x ^= x >> 27n;
    this.s = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) >> 11n) / 2 ** 53;
  }
  int(lo: number, hi: number) { return lo + Math.floor(this.next() * (hi - lo)); }
  pick<T>(a: T[]): T { return a[this.int(0, a.length)]; }
}

const FS = 48000;
type Sig = { name: string; L: Float64Array; R: Float64Array; stereoOnly?: boolean };
const sec = (s: number) => Math.round(s * FS);
const zeros = (n: number) => new Float64Array(n);
const gen = (n: number, f: (i: number) => number) => Float64Array.from({ length: n }, (_, i) => f(i));
const clip = (v: number) => Math.max(-32768, Math.min(32767, v));

function concat(parts: Float64Array[]) {
  const out = new Float64Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function delayed(x: Float64Array, d: number, g: number) { return gen(x.length, (i) => i >= d ? g * x[i - d] : 0); }
function mix(a: Float64Array, ga: number, b: Float64Array, gb: number) { return gen(Math.min(a.length, b.length), (i) => ga * a[i] + gb * b[i]); }

function white(n: number, seed: number, amp: number) {
  const rng = new Rng(seed);
  return gen(n, () => amp * (rng.next() * 2 - 1));
}
function pink(n: number, seed: number, amp: number) { // Paul Kellet's filter
  const rng = new Rng(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return gen(n, () => {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
    return amp * y * 0.11;
  });
}

// Harmonic tone with vibrato (rate 5.5 Hz, depth 1 %), 12 harmonics at 1/k.
function vibratoTone(n: number, f0: number, amp: number) {
  let ph = 0;
  return gen(n, (i) => {
    ph += 2 * Math.PI * f0 * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * i / FS)) / FS;
    let y = 0;
    for (let k = 1; k <= 12; k++) y += Math.sin(k * ph) / k;
    return amp * y * 0.45;
  });
}
function chords(n: number, root: number, amp: number) {
  const ratios = [1, 5 / 4, 3 / 2, 15 / 8, 2];
  return gen(n, (i) => {
    const t = i / FS, ch = Math.floor(t / 1.0);
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.8 * t);
    let y = 0;
    ratios.forEach((r, j) => {
      const f = root * r * (1 + 0.15 * ((ch + j) % 3)) * (1 + 0.0007 * j);
      y += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * 2 * f * t) + 0.1 * Math.sin(2 * Math.PI * 3 * f * t);
    });
    return amp * env * y / 6;
  });
}
// Piano-like notes: instant attack (plus a noise click), exponential decay, slightly inharmonic partials.
function piano(n: number, seed: number, amp: number) {
  const rng = new Rng(seed);
  const out = zeros(n);
  for (let t0 = sec(0.1); t0 < n; t0 += sec(0.25 + 0.3 * rng.next())) {
    const f = 110 * 2 ** (rng.int(0, 36) / 12), a = amp * (0.3 + 0.7 * rng.next()), tau = 0.15 + 0.5 * rng.next();
    const len = Math.min(n - t0, sec(1.5));
    for (let i = 0; i < len; i++) {
      const t = i / FS;
      let y = 0;
      for (let k = 1; k <= 8; k++) y += Math.sin(2 * Math.PI * f * k * Math.sqrt(1 + 0.0004 * k * k) * t) * Math.exp(-t / (tau / (0.5 + k / 3))) / k;
      out[t0 + i] += a * (y + (i < 96 ? 1.5 * (rng.next() - 0.5) * (1 - i / 96) : 0));
    }
  }
  return out.map(clip);
}
function castanets(n: number, seed: number, amp: number) {
  const rng = new Rng(seed);
  const out = zeros(n);
  for (let t0 = sec(0.05); t0 < n; t0 += sec(0.04 + 0.12 * rng.next())) {
    const a = amp * (0.3 + 0.7 * rng.next()), tau = 0.0008 + 0.003 * rng.next();
    let lp = 0;
    for (let i = 0; i < Math.min(n - t0, sec(0.02)); i++) {
      lp = 0.6 * lp + 0.4 * (rng.next() * 2 - 1);
      out[t0 + i] += a * (rng.next() * 2 - 1 + lp) * Math.exp(-i / FS / tau) * 0.5;
    }
  }
  return out.map(clip);
}
function expChirp(n: number, amp: number) { // 20 Hz .. 20 kHz
  const k = 1000, T = n / FS;
  return gen(n, (i) => amp * Math.sin(2 * Math.PI * 20 * T / Math.log(k) * (k ** (i / n) - 1)));
}

// x3 interpolation with a Blackman-windowed sinc (cutoff = input Nyquist, 32 taps per phase).
function upsample3(x: Float64Array): Float64Array {
  const H = 16, out = new Float64Array(x.length * 3);
  const h = (t: number) => {
    if (Math.abs(t) >= H) return 0;
    const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    return s * (0.42 + 0.5 * Math.cos(Math.PI * t / H) + 0.08 * Math.cos(2 * Math.PI * t / H));
  };
  const taps = [0, 1, 2].map((p) => Array.from({ length: 2 * H }, (_, j) => h(p / 3 - (j - H + 1))));
  for (let i = 0; i < x.length; i++) {
    for (let p = 0; p < 3; p++) {
      let y = 0;
      for (let j = 0; j < 2 * H; j++) { const k = i + j - H + 1; if (k >= 0 && k < x.length) y += x[k] * taps[p][j]; }
      out[3 * i + p] = y;
    }
  }
  return out;
}

// 16 kHz mono 16-bit PCM WAV, read directly; anything else goes through ffmpeg.
function readWav(path: string): Float64Array | undefined {
  const b = Deno.readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let fmtOk = false;
  for (let o = 12; o + 8 <= b.length; o += 8 + v.getUint32(o + 4, true) + (v.getUint32(o + 4, true) & 1)) {
    const size = v.getUint32(o + 4, true);
    if (tag(o) === 'fmt ') {
      fmtOk = v.getUint16(o + 8, true) === 1 && v.getUint16(o + 10, true) === 1 &&
        v.getUint32(o + 12, true) === 16000 && v.getUint16(o + 22, true) === 16;
    } else if (tag(o) === 'data' && fmtOk) {
      return Float64Array.from({ length: size >> 1 }, (_, i) => v.getInt16(o + 8 + 2 * i, true));
    }
  }
  return undefined;
}
async function readAudio(path: string): Promise<Float64Array> {
  const wav = readWav(path);
  if (wav) return wav;
  const { code, stdout, stderr } = await new Deno.Command('ffmpeg', {
    args: ['-v', 'error', '-i', path, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'],
  }).output();
  if (code !== 0) throw new Error(`ffmpeg ${path}: ${new TextDecoder().decode(stderr)}`);
  return Float64Array.from(new Int16Array(stdout.buffer, 0, stdout.length >> 1));
}

async function signals(): Promise<Sig[]> {
  const sigs: Sig[] = [];
  // A music-like signal; the stereo version is partly correlated (delayed copy + its own part).
  const both = (name: string, g: (seed: number) => Float64Array) => {
    const L = g(1);
    sigs.push({ name, L, R: mix(delayed(L, 13, 0.6), 1, g(2), 0.7) });
  };
  const speechFiles = files.length ? files : [...Deno.readDirSync(`${root}test/audio`)]
    .filter((e) => e.name.endsWith('.wav')).map((e) => `${root}test/audio/${e.name}`).sort();
  if (!speechFiles.length) throw new Error('no speech files');
  // Real speech (x3 upsampled) with pauses (digital silence and low noise) between utterances, for
  // DTX; the corpus is used at its own level and again 14 dB quieter. R: delayed 9 samples, -3 dB.
  const speech = await Promise.all(speechFiles.slice(0, quick ? 3 : undefined).map(async (f) => upsample3(await readAudio(f))));
  const parts: Float64Array[] = [];
  for (const gain of quick ? [1] : [1, 0.2]) {
    for (const [i, x] of speech.entries()) parts.push(x.map((v) => v * gain), i % 2 ? zeros(sec(0.4)) : white(sec(0.4), 900 + i, 20));
  }
  const sp = concat(parts);
  sigs.push({ name: `speech(${speech.length} files)`, L: sp, R: delayed(sp, 9, 0.7) });
  both('vibrato-tones', (s) => vibratoTone(sec(3), s === 1 ? 220 : 331, 9000));
  both('chords', (s) => chords(sec(3), s === 1 ? 261.6 : 196, 14000));
  both('piano', (s) => piano(sec(4), 10 + s, 16000));
  both('castanets', (s) => castanets(sec(3), 20 + s, 28000));
  both('noise-levels', (s) => concat([white(sec(0.4), 30 + s, 20000), white(sec(0.4), 40 + s, 2000), white(sec(0.4), 50 + s, 200),
    white(sec(0.4), 60 + s, 20), white(sec(0.4), 70 + s, 2), pink(sec(0.4), 80 + s, 12000), pink(sec(0.4), 90 + s, 300), zeros(sec(0.4))]));
  both('chirp-20Hz-20kHz', (s) => s === 1 ? expChirp(sec(4), 12000) : expChirp(sec(4), 8000).reverse());
  // Silence, +-1..3 LSB noise and short bursts: DTX entry/exit and the comfort-noise path.
  both('dtx-pattern', (s) => concat([zeros(sec(0.6)), white(sec(0.6), 100 + s, 1), zeros(sec(0.6)), vibratoTone(sec(0.3), 300 * s, 6000),
    zeros(sec(1.2)), white(sec(0.6), 110 + s, 3), zeros(sec(0.4)), pink(sec(0.2), 120 + s, 4000), zeros(sec(1.0))]));
  both('dc', (s) => concat([gen(sec(0.8), () => 8000 * s), gen(sec(0.4), () => -20000), zeros(sec(0.4))]));
  both('clipped-square', (s) => concat([gen(sec(1.2), (i) => Math.floor(i / (34 * s)) % 2 ? 32767 : -32768),
    gen(sec(1.2), (i) => clip(60000 * Math.sin(2 * Math.PI * 1100 * s * i / FS)))]));
  // Stereo-only images: hard-panned (then swapped), anti-phase, mono-compatible, decorrelated noise.
  const pn = piano(sec(3), 77, 15000), ch = chords(sec(3), 220, 12000);
  const pan = (name: string, L: Float64Array, R: Float64Array) => sigs.push({ name, L, R, stereoOnly: true });
  pan('hard-pan', concat([pn.subarray(0, sec(1.5)), zeros(sec(1.5))]), concat([zeros(sec(1.5)), pn.subarray(sec(1.5))]));
  pan('anti-phase', ch, ch.map((v) => -v));
  pan('mono-compatible', pn, pn);
  pan('decorrelated-noise', white(sec(3), 5, 6000), pink(sec(3), 6, 9000));
  return sigs;
}

// ---------- configurations ----------

const BW = [-1000, 1101, 1102, 1103, 1104, 1105]; // AUTO, NB, MB, WB, SWB, FB
const BITRATES = [6000, 8000, 12000, 16000, 24000, 32000, 48000, 64000, 96000, 128000, 192000, 256000, 510000, -1000, -1];

function configs(): Cfg[] {
  const cfgs: Cfg[] = [];
  const bitrates = quick ? [6000, 24000, 64000, 510000, -1000] : BITRATES;
  const complexities = quick ? [0, 3, 10] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  let i = 0;
  for (const ch of [1, 2]) {
    for (const bitrate of bitrates) {
      for (const complexity of complexities) {
        const vbrc = (i >> 1) & 1, dtx = i & 1, float = ((i >> 2) & 1) as 0 | 1;
        cfgs.push({ name: `${ch}ch b${bitrate} c${complexity} vc${vbrc} dtx${dtx} ${float ? 'f32' : 'i16'}`, ch, bitrate, complexity, vbrc, dtx, float });
        i++;
      }
    }
    // Both constraint and DTX settings at the extreme complexities and a couple of bitrates.
    for (const bitrate of [12000, 32000, 128000, -1]) {
      for (const vbrc of [0, 1]) for (const dtx of [0, 1]) {
        cfgs.push({ name: `${ch}ch b${bitrate} c10 vc${vbrc} dtx${dtx} i16`, ch, bitrate, complexity: 10, vbrc, dtx, float: 0 });
        if (quick) break;
      }
    }
    // Float input beyond +-1.0 (opus_encode_float accepts it).
    cfgs.push({ name: `${ch}ch hot f32 x2.5`, ch, bitrate: 64000, complexity: 10, vbrc: 1, dtx: 0, float: 1, scale: 2.5 });
    for (const plc of quick ? [20] : [1, 5, 20, 100]) {
      cfgs.push({ name: `${ch}ch plc${plc}`, ch, bitrate: 32000, complexity: 10, vbrc: 1, dtx: 0, float: 1, plc });
    }
    for (const bw of quick ? [1101, 1104] : BW) {
      for (const bitrate of quick ? [24000] : [16000, 64000]) {
        cfgs.push({ name: `${ch}ch bw${bw} b${bitrate}`, ch, bitrate, complexity: 10, vbrc: 1, dtx: 0, float: 0, bw });
      }
    }
    // Random ctl changes every few frames, i16/f32 alternating per frame.
    for (let s = 0; s < (quick ? 2 : 8); s++) {
      cfgs.push({ name: `${ch}ch dynamic#${s}`, ch, bitrate: 32000, complexity: 9, vbrc: s & 1, dtx: (s >> 1) & 1, float: 2, dynamic: 1000 + s + 100 * ch });
    }
  }
  return cfgs;
}

// Per-run schedule of ctl changes (frame -> [[which, value]]) and per-frame input type; the same
// for every implementation.
function schedule(cfg: Cfg, nFrames: number) {
  const ctls = new Map<number, [number, number][]>();
  const rng = new Rng(cfg.dynamic ?? 1);
  if (cfg.dynamic) {
    const vals = [
      () => rng.pick([5000, 6000, 9000, 14000, 20000, 32000, 64000, 128000, 300000, 510000, -1000, -1]),
      () => rng.int(0, 11), () => rng.int(0, 2), () => rng.int(0, 2), () => rng.pick([0, 1, 5, 10, 25, 50, 100]), () => rng.pick(BW),
    ];
    for (let f = 3; f < nFrames; f += 4) {
      if (rng.next() < 0.5) continue;
      const list: [number, number][] = [];
      for (let k = rng.int(1, 3); k > 0; k--) { const w = rng.int(0, 6); list.push([w, vals[w]()]); }
      ctls.set(f, list);
    }
  }
  const floatFrame = Uint8Array.from({ length: nFrames }, () => cfg.float === 2 ? (rng.next() < 0.5 ? 1 : 0) : cfg.float);
  return { ctls, floatFrame };
}

// ---------- one run of one implementation ----------

type Trace = {
  error?: string; lookahead: number; lens: number[]; pkts: Uint8Array[]; ranges: number[]; dtx: number[]; ctl: number[];
  bytes: number; snr: number; decoded: Float64Array; // decoded: native scalar decoder output, interleaved
};
type Decoder = ReturnType<ReturnType<typeof loadNative>['decoder']>;

function snr(ref: Float64Array, dec: Float64Array, delay: number) {
  let s = 0, e = 0;
  for (let i = 0; i + delay < dec.length && i < ref.length; i++) {
    s += ref[i] * ref[i];
    e += (ref[i] - dec[i + delay]) ** 2;
  }
  return s === 0 ? Infinity : 10 * Math.log10(s / Math.max(e, 1e-9));
}

type Input = { nFrames: number; i16: Int16Array; f32: Float32Array; ref: Float64Array };

function prepare(sig: Sig, cfg: Cfg, start: number, nFrames: number): Input {
  const ch = cfg.ch, scale = cfg.scale ?? 1, n = nFrames * FRAME * ch;
  const i16 = new Int16Array(n), f32 = new Float32Array(n), ref = new Float64Array(n);
  for (let i = 0; i < nFrames * FRAME; i++) {
    for (let c = 0; c < ch; c++) {
      const v = (c ? sig.R : sig.L)[start * FRAME + i] ?? 0;
      i16[i * ch + c] = clip(Math.round(v));
      f32[i * ch + c] = Math.fround(v / 32768 * scale);
    }
  }
  // Reference for the SNR: what the decoder should reproduce (the 16-bit decoder output is clipped).
  for (let i = 0; i < n; i++) ref[i] = clip(cfg.float ? f32[i] * 32768 : i16[i]);
  return { nFrames, i16, f32, ref };
}

function runImpl(impl: Impl, nativeDec: (ch: number) => Decoder, cfg: Cfg, inp: Input): Trace {
  const { ch } = cfg, nFrames = inp.nFrames;
  const tr: Trace = { lookahead: 0, lens: [], pkts: [], ranges: [], dtx: [], ctl: [], bytes: 0, snr: 0, decoded: new Float64Array(0) };
  const enc = impl.create(ch, cfg.bitrate, cfg.complexity, cfg.vbrc, cfg.dtx);
  const dec = nativeDec(ch);
  try {
    if (cfg.plc !== undefined) tr.ctl.push(enc.ctl(4, cfg.plc));
    if (cfg.bw !== undefined) tr.ctl.push(enc.ctl(5, cfg.bw));
    tr.lookahead = enc.lookahead();
    const { ctls, floatFrame } = schedule(cfg, nFrames);
    const decoded = new Float64Array(nFrames * FRAME * ch);
    const pcmD = new Int16Array(FRAME * ch);
    const n = FRAME * ch;
    for (let f = 0; f < nFrames; f++) {
      for (const [w, v] of ctls.get(f) ?? []) tr.ctl.push(enc.ctl(w, v));
      const len = enc.encode(floatFrame[f] ? inp.f32.subarray(f * n, (f + 1) * n) : inp.i16.subarray(f * n, (f + 1) * n));
      if (len < 0) throw new Error(`frame ${f}: encode returned ${len}`);
      const pkt = enc.packet(len);
      const range = enc.range();
      tr.lens.push(len); tr.pkts.push(pkt); tr.ranges.push(range); tr.dtx.push(enc.inDtx());
      tr.bytes += len;
      // CELT-only, 20 ms, one frame per packet; the stereo bit may be clear (low-rate stereo is coded mono).
      if (len < 1 || (pkt[0] & 0x80) === 0 || ((pkt[0] >> 3) & 3) !== 3 || (pkt[0] & 3) !== 0 || ((pkt[0] >> 2) & 1) > ch - 1) { // stereo input may be coded as a mono stream
        throw new Error(`frame ${f}: bad TOC 0x${(pkt[0] ?? 0).toString(16)} (len ${len})`);
      }
      const r = dec.decode(pkt, pcmD);
      if (r !== FRAME) throw new Error(`frame ${f}: native decoder returned ${r}`);
      // A 1-2 byte packet (DTX) carries no CELT frame, so the decoder runs PLC and reports range 0.
      if (len > 2 && dec.range() !== range) throw new Error(`frame ${f}: decoder final range ${dec.range()} != encoder ${range}`);
      decoded.set(pcmD, f * n);
    }
    tr.snr = snr(inp.ref, decoded, tr.lookahead * ch);
    tr.decoded = decoded;
  } catch (e) {
    tr.error = e instanceof Error ? e.message : String(e);
  } finally {
    dec.destroy();
    try { enc.destroy(); } catch { /* instance may be gone after a trap */ }
  }
  return tr;
}

function firstMismatch(a: Trace, b: Trace): string | undefined {
  if (a.lookahead !== b.lookahead) return `lookahead ${a.lookahead} != ${b.lookahead}`;
  if (a.ctl.length !== b.ctl.length || a.ctl.some((v, i) => v !== b.ctl[i])) return `ctl return codes differ`;
  for (let f = 0; f < a.lens.length; f++) {
    if (a.lens[f] !== b.lens[f] || a.pkts[f].some((v, i) => v !== b.pkts[f][i])) return `frame ${f}: packet differs (${a.lens[f]} B vs ${b.lens[f]} B)`;
    if (a.ranges[f] !== b.ranges[f]) return `frame ${f}: final range ${a.ranges[f]} != ${b.ranges[f]}`;
    if (a.dtx[f] !== b.dtx[f]) return `frame ${f}: in_dtx ${a.dtx[f]} != ${b.dtx[f]}`;
  }
  return undefined;
}

// ---------- tolerance gate against upstream scalar ----------
//
// The fork's SIMD kernels (and the x86/NEON ones of upstream) sum in lane order and may fuse multiply-adds, so
// their packets differ from the scalar C's in a share of the frames, from a few percent (NEON) to most of them
// (AVX2 FMA at high bitrates), without any effect on quality or size. The pairs gated against scalar therefore do
// not compare packets but the effects, which stayed stable across the upstream SIMD builds measured with
// scripts/variance.ts (aarch64 NEON, x86-64 AVX2): hard invariants (ctl codes, lookahead, plus the per-implementation
// checks above), signed mean deltas near zero, per-run bounds, and band-resolved log-spectral distance of the decoded
// streams (SNR is dominated by the loud low bands and cannot see a defect in the top ones). Packet divergence
// rate and re-convergence are reported only. scalar vs rtcd (upstream's own SIMD) runs through the same checks as a
// baseline: if it fails, the bounds are too tight for this host.
// A mean is gated as a bias: it fails only when it is both material (above its bound) and significant (more than
// SIGMAS standard errors from zero). Float-order noise is symmetric, so on a short or clean corpus a few flipped
// frames can move a mean without being a bias, while a systematic defect shows in every frame.
const GATE = {
  meanDSnr: 0.02,        // dB, mean (SNR_B - SNR_A) over runs
  runDSnr: 1,            // dB, |SNR_B - SNR_A| of any run
  meanDBytesPct: 0.01,   // %, mean relative size difference over runs
  runDBytesPct: 2,       // %, per run, with an absolute floor of runDBytesFloor bytes (a DTX/silence run is a few hundred bytes)
  runDBytesFloor: 4,
  bandBias: 0.02,        // dB, mean log-spectral distance B - A of any band, over all decoded frames
  bandAbs: 0.1,          // dB, mean |log-spectral distance| of any band, over all decoded frames
  dtxFrames: 0.005,      // share of frames whose in_dtx state differs
  sigmas: 4,
};

// The 21 CELT bands (eband5ms, 200 Hz units at 5 ms resolution), analysed with a Hann window over one 20 ms frame.
const NFFT = 1024;
const BAND_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 34, 40, 48, 60, 78, 100].map((e) => e * 200);
const NBANDS = BAND_EDGES.length - 1;
const bandAnalysis = (() => {
  const win = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / FRAME));
  const w2 = win.reduce((a, v) => a + v * v, 0);
  const bins = BAND_EDGES.slice(0, NBANDS).map((lo, b) => [Math.ceil(lo * NFFT / FS), Math.ceil(BAND_EDGES[b + 1] * NFFT / FS)]);
  // Floor: white noise of one 16-bit LSB (variance 1/12) in every bin, so that empty bands do not blow up the ratio.
  const floor = bins.map(([lo, hi]) => (hi - lo) * w2 / 12);
  const cos = Float64Array.from({ length: NFFT / 2 }, (_, i) => Math.cos(-2 * Math.PI * i / NFFT));
  const sin = Float64Array.from({ length: NFFT / 2 }, (_, i) => Math.sin(-2 * Math.PI * i / NFFT));
  const rev = new Uint32Array(NFFT);
  for (let i = 0, lg = Math.log2(NFFT); i < NFFT; i++) { let r = 0; for (let b = 0; b < lg; b++) if (i >> b & 1) r |= 1 << (lg - 1 - b); rev[i] = r; }
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const energies = (x: Float64Array, off: number, stride: number) => {
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME; i++) re[rev[i]] = x[off + i * stride] * win[i];
    for (let len = 2; len <= NFFT; len <<= 1) {
      const h = len >> 1, step = NFFT / len;
      for (let s = 0; s < NFFT; s += len) {
        for (let k = 0; k < h; k++) {
          const a = s + k, b = a + h, c = cos[k * step], d = sin[k * step];
          const tr = re[b] * c - im[b] * d, ti = re[b] * d + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    return Float64Array.from(bins, ([lo, hi]) => { let e = 0; for (let k = lo; k < hi; k++) e += re[k] * re[k] + im[k] * im[k]; return e; });
  };
  return { floor, energies };
})();

type Pool = {
  runs: number; runsDiv: number; frames: number; framesDiv: number; dtxFrames: number;
  nSnr: number; sumDSnr: number; sumSqDSnr: number; maxDSnr: number; nBytes: number; sumDBytes: number; sumSqDBytes: number; maxDBytes: number;
  // Log-spectral distance sums over differing decoded frame-channels (identical ones contribute 0); bandNAll counts all of them.
  bandAbs: number[]; bandSgn: number[]; bandSq: number[]; bandN: number; bandNAll: number;
  hard: string[]; snrFails: string[]; bytesFails: string[];
};
const newPool = (): Pool => ({
  runs: 0, runsDiv: 0, frames: 0, framesDiv: 0, dtxFrames: 0, nSnr: 0, sumDSnr: 0, sumSqDSnr: 0, maxDSnr: 0, nBytes: 0, sumDBytes: 0,
  sumSqDBytes: 0, maxDBytes: 0, bandAbs: new Array(NBANDS).fill(0), bandSgn: new Array(NBANDS).fill(0), bandSq: new Array(NBANDS).fill(0),
  bandN: 0, bandNAll: 0, hard: [], snrFails: [], bytesFails: [],
});

// Adds one run of B against A (the scalar reference) to the pools.
function gateRun(pools: Pool[], A: Trace, B: Trace, ch: number, label: string, nFrames: number) {
  const hard = A.lookahead !== B.lookahead ? `lookahead ${A.lookahead} != ${B.lookahead}`
    : A.ctl.length !== B.ctl.length || A.ctl.some((v, i) => v !== B.ctl[i]) ? 'ctl return codes differ' : undefined;
  let div = 0, dtx = 0;
  for (let f = 0; f < nFrames; f++) {
    if (A.lens[f] !== B.lens[f] || A.pkts[f].some((v, i) => v !== B.pkts[f][i])) div++;
    if (A.dtx[f] !== B.dtx[f]) dtx++;
  }
  const dSnr = isFinite(A.snr) && isFinite(B.snr) ? B.snr - A.snr : undefined;
  const dBytes = A.bytes > 0 ? 100 * (B.bytes - A.bytes) / A.bytes : 0;
  const bytesTol = Math.max(GATE.runDBytesPct / 100 * A.bytes, GATE.runDBytesFloor);
  // Band-resolved distance over every decoded frame that differs (decoder state keeps differing after a packet flip).
  const bandAbs = new Array(NBANDS).fill(0), bandSgn = new Array(NBANDS).fill(0), bandSq = new Array(NBANDS).fill(0);
  let bandN = 0;
  if (div || dtx) {
    const n = FRAME * ch;
    for (let f = 0; f < nFrames; f++) {
      for (let c = 0; c < ch; c++) {
        let same = true;
        for (let i = 0; i < FRAME && same; i++) same = A.decoded[f * n + i * ch + c] === B.decoded[f * n + i * ch + c];
        if (same) continue;
        const ea = bandAnalysis.energies(A.decoded, f * n + c, ch), eb = bandAnalysis.energies(B.decoded, f * n + c, ch);
        for (let b = 0; b < NBANDS; b++) {
          const d = 10 * Math.log10((eb[b] + bandAnalysis.floor[b]) / (ea[b] + bandAnalysis.floor[b]));
          bandAbs[b] += Math.abs(d); bandSgn[b] += d; bandSq[b] += d * d;
        }
        bandN++;
      }
    }
  }
  for (const p of pools) {
    p.runs++; p.frames += nFrames; p.framesDiv += div; p.dtxFrames += dtx;
    if (div) p.runsDiv++;
    if (hard) p.hard.push(`  ${label} ${hard}`);
    if (dSnr !== undefined) {
      p.nSnr++; p.sumDSnr += dSnr; p.sumSqDSnr += dSnr * dSnr; p.maxDSnr = Math.max(p.maxDSnr, Math.abs(dSnr));
      if (Math.abs(dSnr) > GATE.runDSnr) p.snrFails.push(`  ${label} SNR${B.snr.toFixed(2)} dB vs scalar ${A.snr.toFixed(2)} dB`);
    }
    p.nBytes++; p.sumDBytes += dBytes; p.sumSqDBytes += dBytes * dBytes; p.maxDBytes = Math.max(p.maxDBytes, Math.abs(dBytes));
    if (Math.abs(B.bytes - A.bytes) > bytesTol) p.bytesFails.push(`  ${label} bytes ${B.bytes} vs scalar ${A.bytes}`);
    for (let b = 0; b < NBANDS; b++) { p.bandAbs[b] += bandAbs[b]; p.bandSgn[b] += bandSgn[b]; p.bandSq[b] += bandSq[b]; }
    p.bandN += bandN; p.bandNAll += nFrames * ch;
  }
}

// Evaluates the checks of one pool; returns the number of failed checks.
function gateReport(title: string, p: Pool, count: boolean): number {
  // soft: reported, never counted as a failure. The band checks are soft in --quick (a few short windows): upstream's own
  // NEON build fails them at that sample size, where a handful of flipped frames dominates a band's mean.
  type Check = { name: string; v: number; bound: number; note: string; ok: boolean; soft: boolean };
  const checks: Check[] = [];
  const limit = (name: string, v: number, bound: number, note = '', soft = false) => checks.push({ name, v, bound, note, ok: v <= bound, soft });
  // Bias check on a mean: fails when |mean| > bound and |mean| > SIGMAS standard errors.
  const bias = (name: string, sum: number, sumSq: number, n: number, bound: number, note = '', soft = false) => {
    const m = sum / n, se = Math.sqrt(Math.max(0, sumSq / n - m * m) / n);
    checks.push({ name, v: Math.abs(m), bound, note: `${note}${note ? ', ' : ''}${GATE.sigmas} SE = ${(GATE.sigmas * se).toPrecision(2)}`,
      ok: !(Math.abs(m) > bound && Math.abs(m) > GATE.sigmas * se), soft });
  };
  bias('|mean ΔSNR| (dB)', p.sumDSnr, p.sumSqDSnr, p.nSnr, GATE.meanDSnr);
  limit('max run |ΔSNR| (dB)', p.maxDSnr, GATE.runDSnr, `${p.snrFails.length} runs over`);
  bias('|mean Δbytes| (%)', p.sumDBytes, p.sumSqDBytes, p.nBytes, GATE.meanDBytesPct);
  limit('runs over the Δbytes bound', p.bytesFails.length, 0, `max |Δ| ${p.maxDBytes.toFixed(3)} %, bound ${GATE.runDBytesPct} %`);
  limit('in_dtx frames differing (share)', p.dtxFrames / p.frames, GATE.dtxFrames);
  if (p.bandNAll) {
    // Per band over all decoded frame-channels: a defect in a band shows in every frame, a flipped decision in a few.
    const bands = Array.from({ length: NBANDS }, (_, b) => b);
    const wa = bands.reduce((m, b) => p.bandAbs[b] > p.bandAbs[m] ? b : m, 0);
    const z = (b: number) => Math.abs(p.bandSgn[b] / p.bandNAll) / (Math.sqrt(Math.max(0, p.bandSq[b] / p.bandNAll - (p.bandSgn[b] / p.bandNAll) ** 2) / p.bandNAll) || Infinity);
    const wb = bands.filter((b) => Math.abs(p.bandSgn[b] / p.bandNAll) > GATE.bandBias).reduce((m, b) => z(b) > z(m) ? b : m, -1);
    const bb = wb >= 0 ? wb : bands.reduce((m, b) => Math.abs(p.bandSgn[b]) > Math.abs(p.bandSgn[m]) ? b : m, 0);
    bias('worst band |mean LSD B-A| (dB)', p.bandSgn[bb], p.bandSq[bb], p.bandNAll, GATE.bandBias, `band ${bb} (${BAND_EDGES[bb]}-${BAND_EDGES[bb + 1]} Hz)`, quick);
    limit('worst band mean |LSD| (dB)', p.bandAbs[wa] / p.bandNAll, GATE.bandAbs, `band ${wa} (${BAND_EDGES[wa]}-${BAND_EDGES[wa + 1]} Hz)`, quick);
  }
  limit('ctl/lookahead mismatches', p.hard.length, 0);
  let failed = 0;
  console.log(`  ${title}: ${p.runs} runs, ${p.runsDiv} with a differing packet, ${(100 * p.framesDiv / p.frames).toFixed(2)} % of ${p.frames} frames; ` +
    `${p.bandN} of ${p.bandNAll} decoded frame-channels differ`);
  for (const { name, v, bound, note, ok, soft } of checks) {
    if (!ok && !soft) failed++;
    console.log(`    ${ok ? 'ok  ' : soft ? 'info' : 'FAIL'} ${name.padEnd(34)} ${v.toPrecision(3).padStart(9)} vs ${bound}${note ? `   (${note})` : ''}`);
  }
  if (failed && count) {
    for (const l of [...p.hard, ...p.snrFails, ...p.bytesFails].slice(0, 10)) console.log(l);
  }
  return failed;
}

// ---------- main ----------

const native = { scalar: loadNative('scalar'), rtcd: loadNative('rtcd') };
const impls = new Map<string, Impl>([['scalar', native.scalar.impl], ['rtcd', native.rtcd.impl]]);
const nativeDec = native.scalar.decoder;
// The fork's C built for wasm (build-cwasm.sh, needs wasi-sdk) is optional: without it the exact cwasm pairs are skipped
// and the tolerance gate against upstream scalar is what judges the minicelt builds.
for (const v of [2, 3]) {
  if (refsOnly || await Deno.stat(`${root}target/native/minicelt-cwasm${v}.wasm`).then(() => true, () => false)) {
    impls.set(`cwasm${v}`, await loadCWasm(v));
  } else console.log(`note: target/native/minicelt-cwasm${v}.wasm not built, skipping the exact cwasm${v} pairs`);
}
if (!refsOnly) {
  for (const [v, c] of [[2, false], [3, false], [2, true], [3, true]] as const) {
    const w = await loadMini(v, c);
    impls.set(w.name, w);
  }
}

// [A, B, exact]
const pairs: [string, string, boolean][] = refsOnly
  ? [['scalar', 'cwasm2', false], ['scalar', 'cwasm3', false], ['cwasm2', 'cwasm3', false], ['rtcd', 'cwasm2', false]]
  : [['cwasm2', 'wasm2', true], ['cwasm2', 'wasm2-checked', true], ['cwasm3', 'wasm3', true], ['cwasm3', 'wasm3-checked', true],
    ['scalar', 'wasm2', strictScalar], ['scalar', 'wasm2-checked', strictScalar], ['scalar', 'cwasm2', false],
    ['cwasm2', 'cwasm3', false], ['scalar', 'wasm3', false], ['rtcd', 'wasm2', false], ['rtcd', 'wasm3', false]];
// Gated against upstream scalar by tolerance (see GATE); scalar vs rtcd is the baseline of the bounds, not gated.
const gated: [string, string, boolean][] = refsOnly ? [] : [['scalar', 'wasm2', true], ['scalar', 'wasm2-checked', true],
  ['scalar', 'wasm3', true], ['scalar', 'wasm3-checked', true], ['scalar', 'rtcd', false]];
const gatePools = gated.map(() => ({ all: newPool(), ch: [newPool(), newPool()] }));
const used = [...new Set([...pairs, ...gated].flatMap(([a, b]) => [a, b]).filter((p) => impls.has(p)))];
const implErrors = new Map<string, string[]>(used.map((u) => [u, []]));

type Stat = { runs: number; exact: number; frames: number; bad: string[]; snrA: number; snrB: number; n: number; dSnr: number; dBytes: number; nBad: number };
const stats = pairs.map((): Stat => ({ runs: 0, exact: 0, frames: 0, bad: [], snrA: 0, snrB: 0, n: 0, dSnr: 0, dBytes: 0, nBad: 0 }));

const sigs = await signals();
const cfgs = configs();
// Runs: (cfg, signal) pairs. Each configuration uses a rotating subset of the signals (all with
// --all); every signal is covered. In --quick each run is a 3 s window at a rotating offset.
const perCfg = allSigs ? Infinity : quick ? 3 : 5;
const runs: { cfg: Cfg; sig: Sig; start: number; nFrames: number }[] = [];
cfgs.forEach((cfg, ci) => {
  const pool = sigs.filter((s) => cfg.ch === 2 || !s.stereoOnly);
  const k = Math.min(perCfg, pool.length);
  for (let j = 0; j < k; j++) {
    const sig = pool[(ci * 3 + j * Math.max(1, Math.floor(pool.length / k))) % pool.length];
    const total = Math.floor(sig.L.length / FRAME);
    const nFrames = quick ? Math.min(150, total) : total;
    const start = quick ? Math.floor((ci * 37 + j * 53) % (total - nFrames + 1)) : 0;
    runs.push({ cfg, sig, start, nFrames });
  }
});
if (filter) runs.splice(0, runs.length, ...runs.filter((r) => `${r.sig.name} [${r.cfg.name}]`.includes(filter)));
console.log(`native: ${native.scalar.version}; ${sigs.length} signals, ${cfgs.length} configs, ${runs.length} runs` +
  `${refsOnly ? ' (refs-only)' : ''}; implementations: ${used.join(', ')}`);

const t0 = performance.now();
let lastProgress = t0, framesTotal = 0;
for (const [ri, run] of runs.entries()) {
  const { cfg, sig } = run;
  const inp = prepare(sig, cfg, run.start, run.nFrames);
  const traces = new Map<string, Trace>();
  for (const name of used) {
    const impl = impls.get(name)!;
    const tr = runImpl(impl, nativeDec, cfg, inp);
    if (tr.error) await impl.reset(); // after a trap the pseudostack is left unbalanced
    traces.set(name, tr);
  }
  framesTotal += run.nFrames;
  for (const [name, tr] of traces) {
    if (tr.error) implErrors.get(name)!.push(`  ${sig.name} [${cfg.name}, ${run.nFrames} fr @${run.start}] ${tr.error}`);
  }
  gated.forEach(([a, b], gi) => {
    const A = traces.get(a), B = traces.get(b);
    if (!A || !B || A.error || B.error) return; // reported per implementation below
    const label = `${sig.name} [${cfg.name}, ${run.nFrames} fr @${run.start}]`;
    gateRun([gatePools[gi].all, gatePools[gi].ch[cfg.ch - 1]], A, B, cfg.ch, label, run.nFrames);
  });
  pairs.forEach(([a, b, exact], pi) => {
    const A = traces.get(a), B = traces.get(b);
    if (!A || !B) return;
    const st = stats[pi], label = `${sig.name} [${cfg.name}${quick || !allSigs ? `, ${run.nFrames} fr @${run.start}` : ''}]`;
    st.runs++;
    st.frames += run.nFrames;
    if (A.error || B.error) return; // reported per implementation below
    if (isFinite(B.snr)) { st.snrA += A.snr; st.snrB += B.snr; st.n++; }
    const mm = firstMismatch(A, B);
    if (!mm) { st.exact++; return; }
    st.nBad++;
    st.dSnr += B.snr - A.snr;
    st.dBytes += (B.bytes - A.bytes) / A.bytes;
    st.bad.push(`  ${label} ${mm}; SNR ${a} ${A.snr.toFixed(2)} dB, ${b} ${B.snr.toFixed(2)} dB; bytes ${A.bytes} vs ${B.bytes}`);
  });
  if (performance.now() - lastProgress > 10000) {
    lastProgress = performance.now();
    console.log(`  progress: ${ri + 1}/${runs.length} runs, ${framesTotal} frames, ${((lastProgress - t0) / 1000).toFixed(0)} s`);
  }
}

let failures = 0;
for (const [name, errs] of implErrors) {
  failures += errs.length;
  console.log(`${name}: ${errs.length} errors in ${runs.length} runs`);
  if (errs.length) console.log(errs.slice(0, 20).join('\n') + (errs.length > 20 ? `\n  ... ${errs.length - 20} more` : ''));
}
for (const [pi, [a, b, exact]] of pairs.entries()) {
  const st = stats[pi];
  if (!st.runs) continue;
  console.log(`${a} vs ${b}${exact ? '' : ' (informational)'}: ${st.exact}/${st.runs} runs bit-exact (${st.frames} frames), ` +
    `mean SNR ${(st.snrA / st.n).toFixed(2)} dB vs ${(st.snrB / st.n).toFixed(2)} dB`);
  if (st.bad.length) {
    if (exact) failures += st.bad.length;
    const show = exact ? 20 : 3;
    console.log(st.bad.slice(0, show).join('\n') + (st.bad.length > show ? `\n  ... ${st.bad.length - show} more` : ''));
    console.log(`  mean over mismatched runs: SNR ${b}-${a} ${(st.dSnr / st.nBad).toFixed(3)} dB, size ${(100 * st.dBytes / st.nBad).toFixed(3)} %`);
  }
}
if (gated.length) {
  console.log('\ntolerance gate against upstream scalar (bounds: see GATE):');
  for (const [gi, [a, b, count]] of gated.entries()) {
    console.log(`${a} vs ${b}${count ? '' : ' (baseline: upstream SIMD, not gated)'}`);
    const pools: [string, Pool][] = [['all', gatePools[gi].all], ['mono', gatePools[gi].ch[0]], ['stereo', gatePools[gi].ch[1]]];
    for (const [title, p] of pools) {
      const failed = gateReport(title, p, count);
      if (count) failures += failed;
      else if (failed) console.log(`    NOTE: upstream's own SIMD fails ${failed} check(s) on this host: the bounds are too tight for it`);
    }
  }
}
console.log(`${((performance.now() - t0) / 1000).toFixed(1)} s total`);
console.log(failures ? `FAILED: ${failures}` : 'ok');
Deno.exit(failures ? 1 : 0);
