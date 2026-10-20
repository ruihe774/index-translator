// Measures the pseudostack high-water mark (stack::peak(), exported as minicelt_stack_peak() by the
// `stack-peak` feature) and the depth of the wasm shadow stack (the Rust call stack, at the bottom of
// linear memory, growing down from STACK_TOP) over a sweep of configurations.
//
//   MINICELT_SHADOW_STACK=16384 cargo build --release -p minicelt-wasm --features stack-peak \
//     --config 'target.wasm32-unknown-unknown.rustflags=["-Ctarget-feature=+simd128"]' --target-dir target/stack-peak
//   deno run --allow-read minicelt/test/stack_peak.ts target/stack-peak/wasm32-unknown-unknown/release/minicelt_wasm.wasm [more.wasm ...]
//
// (Add `--profile checked` for the checked build, which lands in .../checked/. For WASM 3.0 use
// -Ctarget-feature=+simd128,+relaxed-simd,+extended-const,+tail-call.) The sweep is mono/stereo x
// complexity {0,2,3,4,5,7,8,9,10} x bitrate {500 .. 750000, OPUS_AUTO} x constrained VBR on/off x
// packet loss 0/20 x bandwidth {auto, NB, WB, FB} (2592 configurations, DTX on), alternating i16/f32
// input, over the speech corpus (test/audio, upsampled x3 by repetition), noise, a tone with clicks
// and a DTX pattern. The pseudostack must be built larger than the peak (an overflow panics): the
// default GLOBAL_STACK_SIZE is enough.

const root = new URL('../..', import.meta.url).pathname;
const FRAME = 960;
const STACK_TOP = Number(Deno.env.get('STACK_TOP') ?? 16384); // MINICELT_SHADOW_STACK of the measuring build

let seed = 11;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

function readWav(path: string): Float64Array {
  const b = Deno.readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 12; o + 8 <= b.length; o += 8 + v.getUint32(o + 4, true) + (v.getUint32(o + 4, true) & 1)) {
    const size = v.getUint32(o + 4, true);
    if (String.fromCharCode(...b.subarray(o, o + 4)) === 'data') {
      const n = size >> 1;
      return Float64Array.from({ length: 3 * n }, (_, i) => v.getInt16(o + 8 + 2 * Math.floor(i / 3), true));
    }
  }
  throw new Error(`no data chunk in ${path}`);
}

type Sig = { L: Float64Array; R: Float64Array };
const sigs: Sig[] = [];
for (const e of [...Deno.readDirSync(`${root}test/audio`)].filter((e) => e.name.endsWith('.wav')).sort((a, b) => a.name < b.name ? -1 : 1).slice(0, 4)) {
  const x = readWav(`${root}test/audio/${e.name}`);
  sigs.push({ L: x, R: x.map((_, i) => i > 9 ? -0.8 * x[i - 9] : 0) });
}
const n = 96000;
const gen = (f: (i: number) => number) => Float64Array.from({ length: n }, (_, i) => f(i));
sigs.push({ L: gen(() => (rnd() - .5) * 30000), R: gen(() => (rnd() - .5) * 30000) });
sigs.push({
  L: gen((i) => 12000 * Math.sin(i * 0.02) + (i % 9600 < 60 ? 20000 * (rnd() - .5) : 0)),
  R: gen((i) => 12000 * Math.sin(i * 0.02) + (i % 7000 < 40 ? 20000 * (rnd() - .5) : 0)),
});
sigs.push({
  L: gen((i) => Math.floor(i / 24000) % 2 ? 0 : 5000 * Math.sin(i * 0.03) * rnd()),
  R: gen((i) => Math.floor(i / 24000) % 2 ? 0 : 3000 * Math.sin(i * 0.05) * rnd()),
});

const bitrates = [500, 6000, 16000, 24000, 64000, 128000, 510000, 750000, -1000];
let overall = 0, worst = '';
for (const path of Deno.args) {
  const module = await WebAssembly.compile(await Deno.readFile(path));
  let peak = 0, depth = 0, configs = 0;
  for (const ch of [1, 2]) for (const cx of [0, 2, 3, 4, 5, 7, 8, 9, 10]) for (const br of bitrates) {
    for (const vbrc of [0, 1]) for (const plc of [0, 20]) for (const bw of [-1000, 1101, 1103, 1105]) {
      // deno-lint-ignore no-explicit-any
      const e = (await WebAssembly.instantiate(module, {})).exports as any;
      // Paint the shadow stack region; the lowest changed byte afterwards is the deepest stack use.
      new Uint8Array(e.memory.buffer, 0, STACK_TOP).fill(0xa5);
      e.minicelt_init(ch, br, cx, vbrc, 1);
      e.minicelt_set_packet_loss_perc(plc);
      e.minicelt_set_bandwidth(bw);
      const sg = sigs[configs % sigs.length];
      const float = configs % 2 === 1;
      const off = Math.floor(rnd() * 30) * FRAME;
      for (let f = 0; f < 36; f++) {
        const base = off + f * FRAME;
        const s = (c: number, i: number) => (c ? sg.R : sg.L)[(base + i) % sg.L.length];
        if (float) {
          const p = new Float32Array(e.memory.buffer, e.minicelt_input_ptr(), FRAME * ch);
          for (let i = 0; i < FRAME; i++) for (let c = 0; c < ch; c++) p[i * ch + c] = s(c, i) / 32768;
          e.minicelt_encode();
        } else {
          const p = new Int16Array(e.memory.buffer, e.minicelt_input_i16_ptr(), FRAME * ch);
          for (let i = 0; i < FRAME; i++) for (let c = 0; c < ch; c++) p[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(s(c, i))));
          e.minicelt_encode_i16();
        }
      }
      configs++;
      const mem = new Uint8Array(e.memory.buffer, 0, STACK_TOP);
      let low = 0;
      while (low < STACK_TOP && mem[low] === 0xa5) low++;
      depth = Math.max(depth, STACK_TOP - low);
      const pk = e.minicelt_stack_peak();
      if (pk > peak) { peak = pk; worst = `${path}: ${ch}ch complexity ${cx} bitrate ${br} vbrc ${vbrc} loss ${plc} bandwidth ${bw} ${float ? 'f32' : 'i16'}`; }
    }
  }
  console.log(`${path}: ${configs} configs, pseudostack peak ${peak} bytes, shadow stack depth ${depth} bytes`);
  overall = Math.max(overall, peak);
}
console.log(`overall peak ${overall} bytes (${worst})`);
