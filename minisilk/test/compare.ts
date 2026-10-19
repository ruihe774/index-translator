// Differential test of the minisilk wasm builds against natively built upstream libopus.
//
//   scripts/test.sh silk [--quick] [audio files...]
//   (= scripts/build-native.sh && scripts/build.sh silk all both &&
//      deno run --allow-read --allow-ffi --allow-run minisilk/test/compare.ts [--quick] [audio files...])
//
// For every native library (target/native/minisilk-{scalar,rtcd}.so) x wasm build
// (target/minisilk-wasm{2,3}[-checked].wasm) x signal x configuration it encodes the same input with both
// encoders and compares packets, OPUS_GET_FINAL_RANGE and OPUS_GET_IN_DTX frame by frame. The native
// encoder and decoder run once per (library, signal, configuration); all wasm builds are compared against
// that trace. The native decoder's final range must equal the encoder's (the bitstream check from
// opus_demo). minisilk packets identical to the native ones need no decoding of their own; mismatching
// ones are decoded natively too. The decoded SNR of both streams is reported so a mismatch can be judged
// by its effect. Tasks run on a pool of workers (--jobs=N, default: all cores).
// The speech corpus is test/audio/*.wav (16 kHz mono 16-bit; see THIRD_PARTY_NOTICES.md).
// Audio files given as arguments replace it; files in other formats are decoded with ffmpeg.

const root = new URL('../..', import.meta.url).pathname;
const FRAME = 320;
const CAP = 1276;
// deno-lint-ignore no-explicit-any
const isWorker = typeof (globalThis as any).WorkerGlobalScope !== 'undefined';
// Workers get these from the main thread (see the init message).
let quick = Deno.args.includes('--quick');
let files = Deno.args.filter((a) => !a.startsWith('--'));

// ---------- native libopus ----------

function loadNative(name: string) {
  const lib = Deno.dlopen(`${root}target/native/minisilk-${name}.so`, {
    shim_enc_create: { parameters: ['i32', 'i32', 'i32', 'buffer'], result: 'pointer' },
    shim_enc_destroy: { parameters: ['pointer'], result: 'void' },
    shim_enc_set_bitrate: { parameters: ['pointer', 'i32'], result: 'i32' },
    shim_enc_set_complexity: { parameters: ['pointer', 'i32'], result: 'i32' },
    shim_enc_set_dtx: { parameters: ['pointer', 'i32'], result: 'i32' },
    shim_enc_set_packet_loss_perc: { parameters: ['pointer', 'i32'], result: 'i32' },
    shim_enc_lookahead: { parameters: ['pointer'], result: 'i32' },
    shim_enc_final_range: { parameters: ['pointer'], result: 'u32' },
    shim_enc_in_dtx: { parameters: ['pointer'], result: 'i32' },
    shim_encode: { parameters: ['pointer', 'buffer', 'buffer', 'i32'], result: 'i32' },
    shim_encode_float: { parameters: ['pointer', 'buffer', 'buffer', 'i32'], result: 'i32' },
    shim_dec_create: { parameters: ['buffer'], result: 'pointer' },
    shim_dec_destroy: { parameters: ['pointer'], result: 'void' },
    shim_decode: { parameters: ['pointer', 'buffer', 'i32', 'buffer'], result: 'i32' },
    shim_dec_final_range: { parameters: ['pointer'], result: 'u32' },
    shim_version: { parameters: [], result: 'pointer' },
  });
  return { name, s: lib.symbols, version: new Deno.UnsafePointerView(lib.symbols.shim_version()!).getCString() };
}
type Native = ReturnType<typeof loadNative>;

// ---------- minisilk wasm ----------

// `checked` builds keep debug_assert!s and overflow checks; a failing one traps.
async function loadWasm(variant: number, checked: boolean) {
  const name = `wasm${variant}${checked ? '-checked' : ''}`;
  const module = await WebAssembly.compile(await Deno.readFile(`${root}target/minisilk-${name}.wasm`));
  // deno-lint-ignore no-explicit-any
  const w = { name, checked, e: undefined as any, reset: async () => {} };
  // After a trap the pseudostack is left unbalanced, so the instance is replaced.
  w.reset = async () => { w.e = (await WebAssembly.instantiate(module, {})).exports; };
  await w.reset();
  return w;
}
type Wasm = Awaited<ReturnType<typeof loadWasm>>;

// ---------- signals ----------

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

// Same model as testutil::SpeechGen: glottal sawtooth with vibrato through two formant resonators.
function speechGen(n: number, seed: number, gain = 3000): Float64Array {
  const rng = new Rng(seed);
  const out = new Float64Array(n);
  let ph = 0, y0 = 0, y1 = 0, z0 = 0, z1 = 0;
  const fs = 16000;
  const a1 = 2 * 0.97 * Math.cos(2 * Math.PI * 700 / fs), a2 = -0.97 * 0.97;
  const b1 = 2 * 0.95 * Math.cos(2 * Math.PI * 1800 / fs), b2 = -0.95 * 0.95;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    ph += (110 + 25 * Math.sin(2 * Math.PI * 0.7 * t)) / fs;
    if (ph >= 1) ph -= 1;
    const x = (ph < 0.5 ? ph * 2 : ph * 2 - 2) * 0.6 + 0.01 * (rng.next() * 2 - 1);
    const y = x + a1 * y0 + a2 * y1; y1 = y0; y0 = y;
    const z = y * 0.3 + b1 * z0 + b2 * z1; z1 = z0; z0 = z;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.5 * t);
    out[i] = Math.max(-32000, Math.min(32000, (0.25 * y + 0.1 * z) * env * gain));
  }
  return out;
}

function noise(n: number, seed: number, amp: number) {
  const rng = new Rng(seed);
  return Float64Array.from({ length: n }, () => amp * (rng.next() * 2 - 1));
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

function concat(parts: Float64Array[]) {
  const out = new Float64Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const silence = (n: number) => new Float64Array(n);

async function signals(): Promise<{ name: string; x: Float64Array }[]> {
  const sec = 16000;
  const sigs: { name: string; x: Float64Array }[] = [];
  const speechFiles = files.length ? files : [...Deno.readDirSync(`${root}test/audio`)]
    .filter((e) => e.name.endsWith('.wav')).map((e) => `${root}test/audio/${e.name}`).sort();
  if (!speechFiles.length) throw new Error('no speech files');
  // Real speech with pauses (digital silence and low noise) between utterances, for VAD and
  // DTX; the corpus is used at its own level and again 14 dB quieter.
  const parts: Float64Array[] = [];
  const speech = await Promise.all(speechFiles.map(readAudio));
  for (const gain of [1, 0.2]) {
    for (const [i, x] of speech.entries()) {
      parts.push(x.map((v) => v * gain), i % 2 ? silence(sec / 2) : noise(sec / 2, 900 + i, 30));
    }
  }
  sigs.push({ name: `speech(${speechFiles.length} files)`, x: concat(parts) });
  sigs.push({ name: 'synth-voiced', x: concat([speechGen(4 * sec, 1), silence(2 * sec), speechGen(3 * sec, 2, 9000), noise(sec, 3, 40), speechGen(2 * sec, 4, 300)]) });
  sigs.push({ name: 'noise-levels', x: concat([noise(sec, 5, 20000), noise(sec, 6, 2000), noise(sec, 7, 200), noise(sec, 8, 20), noise(sec, 9, 2), silence(sec)]) });
  sigs.push({ name: 'chirp', x: Float64Array.from({ length: 4 * sec }, (_, i) => 12000 * Math.sin(2 * Math.PI * (50 * i / sec + 950 * (i / sec) ** 2))) });
  // Clipped square wave and isolated full-scale clicks: saturation and transient paths.
  sigs.push({ name: 'square+clicks', x: Float64Array.from({ length: 3 * sec }, (_, i) => i < 1.5 * sec ? (Math.floor(i / 73) % 2 ? 32767 : -32768) : (i % 4001 === 0 ? 32767 : i % 4001 === 7 ? -32768 : 0)) });
  // Pure tones and DC: high prediction gain / max-gain limiting paths.
  sigs.push({ name: 'tones+dc', x: concat([Float64Array.from({ length: 2 * sec }, (_, i) => 16000 * Math.sin(2 * Math.PI * 440 * i / sec)), Float64Array.from({ length: sec }, (_, i) => 1000 * Math.sin(2 * Math.PI * 3999 * i / sec)), new Float64Array(sec).fill(5000)]) });
  return sigs;
}

// ---------- configurations ----------

type Cfg = { name: string; bitrate: number; complexity: number; dtx: number; float: boolean; hot?: boolean; dynamic?: number };

function configs(): Cfg[] {
  const cfgs: Cfg[] = [];
  const bitrates = quick ? [6000, 12000, 24000, -1000] : [6000, 8000, 10000, 12000, 16000, 20000, 24000, 32000, 40000, 64000, -1000, -1];
  const complexities = quick ? [0, 2, 5, 10] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  let i = 0;
  for (const bitrate of bitrates) {
    for (const complexity of complexities) {
      const dtx = i & 1, float = ((i >> 1) & 1) === 1;
      cfgs.push({ name: `b${bitrate} c${complexity} dtx${dtx} ${float ? 'f32' : 'i16'}`, bitrate, complexity, dtx, float });
      i++;
    }
  }
  // Float input beyond +-1.0 (opus_encode_float accepts it).
  cfgs.push({ name: 'hot f32 x2.5', bitrate: 24000, complexity: 10, dtx: 0, float: true, hot: true });
  // Random ctl changes every few frames (bitrate, complexity, DTX, packet loss %).
  for (let s = 0; s < (quick ? 2 : 8); s++) {
    cfgs.push({ name: `dynamic#${s}`, bitrate: 16000, complexity: 9, dtx: s & 1, float: (s & 2) !== 0, dynamic: 1000 + s });
  }
  return cfgs;
}

// ---------- one run ----------

type Result = { frames: number; mismatch?: string; bytesNative: number; bytesMini: number; snrNative: number; snrMini: number };

function snr(ref: Float64Array, dec: Float64Array, delay: number) {
  let s = 0, e = 0;
  for (let i = 0; i + delay < dec.length && i < ref.length; i++) {
    const r = Math.max(-32768, Math.min(32767, ref[i]));
    s += r * r;
    e += (r - dec[i + delay]) ** 2;
  }
  return s === 0 ? Infinity : 10 * Math.log10(s / Math.max(e, 1e-9));
}

// What the native encoder and decoder did for one (signal, configuration); shared by all wasm builds.
type Trace = {
  frames: number; lookahead: number; pkts: Uint8Array[]; ranges: number[]; dtx: number[]; ctl: number[];
  bytes: number; decoded: Float64Array; snr: number;
};

const chk = (what: string, r: number) => { if (r < 0) throw new Error(`${what}: ${r}`); return r; };

// The ctl changes of a `dynamic` configuration; the sequence depends only on the seed, so the native and
// wasm runs draw the same one.
function* ctlEvents(cfg: Cfg, nFrames: number) {
  const rng = cfg.dynamic ? new Rng(cfg.dynamic) : undefined;
  for (let f = 0; f < nFrames; f++) {
    if (rng && f % 5 === 0 && rng.next() < 0.5) {
      const which = rng.int(0, 4);
      const v = [() => rng.pick([5000, 6000, 9000, 14000, 20000, 30000, 50000, -1000, -1]), () => rng.int(0, 11), () => rng.int(0, 2), () => rng.pick([0, 1, 5, 10, 25, 50, 100])][which]();
      yield { f, which, v };
    }
  }
}

function fillInput(cfg: Cfg, x: Float64Array, f: number, pcmI: Int16Array, pcmF: Float32Array) {
  const scale = cfg.hot ? 2.5 : 1;
  if (cfg.float) for (let i = 0; i < FRAME; i++) pcmF[i] = Math.fround(x[f * FRAME + i] / 32768 * scale);
  else for (let i = 0; i < FRAME; i++) pcmI[i] = Math.max(-32768, Math.min(32767, Math.round(x[f * FRAME + i])));
}

const refOf = (x: Float64Array, cfg: Cfg, nFrames: number) => {
  const scale = cfg.hot ? 2.5 : 1;
  return Float64Array.from(x.subarray(0, nFrames * FRAME), (v) => v * scale);
};

// Decodes packets natively, checking the final range against the encoder's.
function decodeAll(n: Native['s'], pkts: Uint8Array[], ranges: number[], who: string) {
  const err = new Int32Array(1);
  const dec = n.shim_dec_create(err);
  const out = new Float64Array(pkts.length * FRAME);
  const pcmD = new Int16Array(FRAME);
  try {
    for (let f = 0; f < pkts.length; f++) {
      const pkt = pkts[f];
      const r = n.shim_decode(dec, pkt, pkt.length, pcmD);
      if (r !== FRAME) throw new Error(`${who} frame ${f}: native decoder returned ${r}`);
      const dr = n.shim_dec_final_range(dec);
      // A 1-2 byte packet (DTX) carries no SILK frame, so the decoder runs PLC and reports range 0.
      if (pkt.length > 2 && dr !== ranges[f]) throw new Error(`${who} frame ${f}: decoder final range ${dr} != encoder ${ranges[f]}`);
      for (let i = 0; i < FRAME; i++) out[f * FRAME + i] = pcmD[i];
    }
  } finally {
    n.shim_dec_destroy(dec);
  }
  return out;
}

function nativeTrace(nat: Native, x: Float64Array, cfg: Cfg): Trace {
  const n = nat.s;
  const err = new Int32Array(1);
  const enc = n.shim_enc_create(cfg.bitrate, cfg.complexity, cfg.dtx, err);
  if (!enc) throw new Error(`native create: ${err[0]}`);
  try {
    const nFrames = Math.floor(x.length / FRAME);
    const outN = new Uint8Array(CAP);
    const pcmI = new Int16Array(FRAME), pcmF = new Float32Array(FRAME);
    const t: Trace = { frames: nFrames, lookahead: n.shim_enc_lookahead(enc), pkts: [], ranges: [], dtx: [], ctl: [], bytes: 0, decoded: new Float64Array(0), snr: 0 };
    const events = ctlEvents(cfg, nFrames);
    let ev = events.next();
    for (let f = 0; f < nFrames; f++) {
      if (!ev.done && ev.value.f === f) {
        const { which, v } = ev.value;
        t.ctl.push([n.shim_enc_set_bitrate, n.shim_enc_set_complexity, n.shim_enc_set_dtx, n.shim_enc_set_packet_loss_perc][which](enc, v));
        ev = events.next();
      }
      fillInput(cfg, x, f, pcmI, pcmF);
      const len = cfg.float ? chk('native encode_float', n.shim_encode_float(enc, pcmF, outN, CAP)) : chk('native encode', n.shim_encode(enc, pcmI, outN, CAP));
      t.pkts.push(outN.slice(0, len));
      t.ranges.push(n.shim_enc_final_range(enc));
      t.dtx.push(n.shim_enc_in_dtx(enc));
      t.bytes += len;
    }
    t.decoded = decodeAll(n, t.pkts, t.ranges, 'native');
    t.snr = snr(refOf(x, cfg, nFrames), t.decoded, t.lookahead); // the decoder adds no delay of its own (verified: SNR peaks at the lookahead)
    return t;
  } finally {
    n.shim_enc_destroy(enc);
  }
}

function wasmRun(nat: Native, w: Wasm, x: Float64Array, cfg: Cfg, t: Trace): Result {
  const e = w.e;
  chk('minisilk_init', e.minisilk_init(cfg.bitrate, cfg.complexity, cfg.dtx));
  if (t.lookahead !== e.minisilk_lookahead()) throw new Error('lookahead differs');
  const nFrames = t.frames;
  const res: Result = { frames: nFrames, bytesNative: t.bytes, bytesMini: 0, snrNative: t.snr, snrMini: 0 };
  const pkts: Uint8Array[] = [], ranges: number[] = [];
  const events = ctlEvents(cfg, nFrames);
  let ev = events.next(), ci = 0;
  for (let f = 0; f < nFrames; f++) {
    if (!ev.done && ev.value.f === f) {
      const { which, v } = ev.value;
      const rm = [e.minisilk_set_bitrate, e.minisilk_set_complexity, e.minisilk_set_dtx, e.minisilk_set_packet_loss_perc][which](v);
      const rn = t.ctl[ci++];
      if (rn !== rm) throw new Error(`ctl ${which}=${v}: native ${rn} minisilk ${rm}`);
      ev = events.next();
    }
    let lenM: number;
    if (cfg.float) {
      const pcmF = new Float32Array(e.memory.buffer, e.minisilk_input_ptr(), FRAME);
      fillInput(cfg, x, f, new Int16Array(FRAME), pcmF);
      lenM = chk('minisilk_encode', e.minisilk_encode());
    } else {
      const pcmI = new Int16Array(e.memory.buffer, e.minisilk_input_i16_ptr(), FRAME);
      fillInput(cfg, x, f, pcmI, new Float32Array(FRAME));
      lenM = chk('minisilk_encode_i16', e.minisilk_encode_i16());
    }
    const pktN = t.pkts[f];
    const pktM = new Uint8Array(e.memory.buffer, e.minisilk_output_ptr(), lenM).slice();
    const rangeM = e.minisilk_final_range() >>> 0;
    if (!res.mismatch) {
      if (pktN.length !== lenM || pktN.some((b, i) => b !== pktM[i])) res.mismatch = `frame ${f}: packet differs (native ${pktN.length} B, minisilk ${lenM} B)`;
      else if (t.ranges[f] !== rangeM) res.mismatch = `frame ${f}: final range ${t.ranges[f]} != ${rangeM}`;
      else if (t.dtx[f] !== e.minisilk_in_dtx()) res.mismatch = `frame ${f}: in_dtx differs`;
    }
    if ((pktM[0] & 0xfc) !== 0x48) throw new Error(`frame ${f}: minisilk TOC 0x${pktM[0].toString(16)}`);
    res.bytesMini += lenM;
    pkts.push(pktM);
    ranges.push(rangeM);
  }
  if (!res.mismatch) {
    res.snrMini = t.snr; // identical packets decode identically
  } else {
    const decodedM = decodeAll(nat.s, pkts, ranges, 'minisilk');
    res.snrMini = snr(refOf(x, cfg, nFrames), decodedM, t.lookahead);
  }
  return res;
}

// ---------- tasks ----------

// A task is one (native library, signal, configuration): the native trace plus every wasm build compared
// against it. The strict scalar library is checked with all four wasm builds, rtcd with the release ones.
type Outcome = { err: string } | { r: Result };
type Done = { nat: number; sig: number; cfg: number; outcomes: Outcome[] };
const NATIVES = ['scalar', 'rtcd'];
const WASMS: [number, boolean][] = [[2, false], [3, false], [2, true], [3, true]];
const wasmsFor = (nat: number) => WASMS.map((_, i) => i).filter((i) => nat === 0 || !WASMS[i][1]);
const errText = (err: unknown) => err instanceof Error ? err.message : String(err);

if (isWorker) {
  const natives = NATIVES.map(loadNative);
  const wasms = await Promise.all(WASMS.map(([v, c]) => loadWasm(v, c)));
  let sigs: Awaited<ReturnType<typeof signals>>, cfgs: Cfg[];
  // deno-lint-ignore no-explicit-any
  const ws = self as any;
  const post = (m: unknown) => ws.postMessage(m);
  ws.onmessage = async (m: MessageEvent) => {
    if (m.data.init) {
      quick = m.data.quick;
      files = m.data.files;
      sigs = await signals();
      cfgs = configs();
      post({ ready: true });
      return;
    }
    const { nat, sig, cfg } = m.data;
    const x = sigs[sig].x, c = cfgs[cfg];
    const outcomes: Outcome[] = [];
    let t: Trace | undefined, traceErr = '';
    try {
      t = nativeTrace(natives[nat], x, c);
    } catch (err) {
      traceErr = errText(err);
    }
    for (const wi of wasmsFor(nat)) {
      if (!t) { outcomes.push({ err: traceErr }); continue; }
      try {
        outcomes.push({ r: wasmRun(natives[nat], wasms[wi], x, c, t) });
      } catch (err) {
        // Traps (failed debug_assert!/overflow check, or a panic), native decoder rejections.
        outcomes.push({ err: errText(err) });
        await wasms[wi].reset();
      }
    }
    post({ nat, sig, cfg, outcomes } satisfies Done);
  };
  post({ loaded: true });
} else {
  await main();
}

// ---------- main ----------

async function main() {
  const natives = NATIVES.map(loadNative);
  const wasmNames = WASMS.map(([v, c]) => `wasm${v}${c ? '-checked' : ''}`);
  const sigs = await signals();
  const cfgs = configs();
  console.log(`native: ${natives[0].version}; ${sigs.length} signals x ${cfgs.length} configs` +
    ` (${sigs.map((s) => `${s.name} ${(s.x.length / 16000).toFixed(1)} s`).join(', ')})`);

  // Every build must match the scalar native build bit-exactly (the wasm SIMD kernels are exact
  // ports of the scalar C). The rtcd build's SSE/AVX2 float kernels sum in a different order, so
  // it is compared, with the release builds only, for stream validity and coding quality.
  const jobsArg = Deno.args.find((a) => a.startsWith('--jobs='));
  const jobs = Math.max(1, jobsArg ? Number(jobsArg.slice(7)) : navigator.hardwareConcurrency || 1);
  const tasks: { nat: number; sig: number; cfg: number }[] = [];
  // Longest signals first, for load balance.
  const sigOrder = sigs.map((_, i) => i).sort((a, b) => sigs[b].x.length - sigs[a].x.length);
  for (const sig of sigOrder) for (let cfg = 0; cfg < cfgs.length; cfg++) for (let nat = 0; nat < NATIVES.length; nat++) tasks.push({ nat, sig, cfg });
  const done = new Map<string, Outcome[]>();
  const t0 = performance.now();
  let next = 0, lastProgress = t0;
  await new Promise<void>((resolve, reject) => {
    let finished = 0;
    const nWorkers = Math.min(jobs, tasks.length);
    for (let k = 0; k < nWorkers; k++) {
      const wk = new Worker(import.meta.url, { type: 'module' });
      const feed = () => {
        if (next < tasks.length) wk.postMessage(tasks[next++]);
        else { wk.terminate(); if (++finished === nWorkers) resolve(); }
      };
      wk.onerror = (e) => { e.preventDefault(); reject(new Error(`worker: ${e.message}`)); };
      wk.onmessage = (m) => {
        if (m.data.loaded) wk.postMessage({ init: true, quick, files });
        else if (m.data.ready) feed();
        else {
          const d = m.data as Done;
          done.set(`${d.nat}|${d.sig}|${d.cfg}`, d.outcomes);
          if (performance.now() - lastProgress > 30000) {
            lastProgress = performance.now();
            console.log(`  progress: ${done.size}/${tasks.length} tasks, ${((lastProgress - t0) / 1000).toFixed(0)} s`);
          }
          feed();
        }
      };
    }
  });

  let failures = 0;
  for (const [ni, nat] of natives.entries()) {
    const strict = nat.name === 'scalar';
    for (const [pos, wi] of wasmsFor(ni).entries()) {
      let runs = 0, exact = 0, frames = 0;
      const bad: string[] = [], errors: string[] = [];
      let dSnr = 0, dBytes = 0, nBad = 0, snrSum = 0, snrN = 0;
      for (const [si, sig] of sigs.entries()) {
        for (const [ci, cfg] of cfgs.entries()) {
          runs++;
          const o = done.get(`${ni}|${si}|${ci}`)![pos];
          if ('err' in o) {
            errors.push(`  ${sig.name} [${cfg.name}] ${o.err}`);
            continue;
          }
          const r = o.r;
          frames += r.frames;
          if (isFinite(r.snrMini)) { snrSum += r.snrMini; snrN++; }
          if (!r.mismatch) { exact++; continue; }
          nBad++;
          dSnr += r.snrMini - r.snrNative;
          dBytes += (r.bytesMini - r.bytesNative) / r.bytesNative;
          bad.push(`  ${sig.name} [${cfg.name}] ${r.mismatch}; SNR native ${r.snrNative.toFixed(2)} dB, minisilk ${r.snrMini.toFixed(2)} dB; bytes ${r.bytesNative} vs ${r.bytesMini}`);
        }
      }
      console.log(`${nat.name.padEnd(6)} vs ${wasmNames[wi].padEnd(13)}: ${exact}/${runs} runs bit-exact (${frames} frames), ` +
        `${errors.length} errors; mean SNR ${(snrSum / snrN).toFixed(2)} dB`);
      failures += errors.length;
      if (errors.length) console.log(errors.slice(0, 20).join('\n') + (errors.length > 20 ? `\n  ... ${errors.length - 20} more` : ''));
      if (bad.length) {
        if (strict) failures += bad.length;
        const show = strict ? 20 : 3;
        console.log(bad.slice(0, show).join('\n') + (bad.length > show ? `\n  ... ${bad.length - show} more` : ''));
        console.log(`  mean over mismatched runs: SNR minisilk-native ${(dSnr / nBad).toFixed(3)} dB, size ${(100 * dBytes / nBad).toFixed(3)} %` +
          (strict ? '' : ' (informational)'));
      }
    }
  }
  console.log(`${((performance.now() - t0) / 1000).toFixed(1)} s total on ${jobs} workers`);
  console.log(failures ? `FAILED: ${failures}` : 'ok');
  Deno.exit(failures ? 1 : 0);
}
