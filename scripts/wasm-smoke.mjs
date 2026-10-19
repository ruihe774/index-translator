#!/usr/bin/env node
// Smoke test: loads both wasm variants, encodes a synthetic signal through the C-ABI
// exports and prints packet sizes and TOC bytes. Run scripts/build.sh first.
// It cannot decode; packet validity is covered by the Rust tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAME = 320;
const NFRAMES = 300;

function signal(n) {
  // Voiced-like harmonic signal with vibrato and an amplitude envelope; a silent gap
  // in the middle exercises DTX.
  const x = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    const t = (n * FRAME + i) / 16000;
    const silent = n >= 100 && n < 160;
    const env = silent ? 0 : 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.5 * t);
    const f0 = 120 + 20 * Math.sin(2 * Math.PI * 0.7 * t);
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h;
    x[i] = 0.2 * env * s;
  }
  return x;
}

for (const variant of [2, 3]) {
  const file = path.join(root, 'target', `minisilk-wasm${variant}.wasm`);
  const { instance } = await WebAssembly.instantiate(readFileSync(file), {});
  const e = instance.exports;
  const check = (name, r) => {
    if (r < 0) throw new Error(`${name} failed: ${r}`);
    return r;
  };
  check('init', e.minisilk_init(20000, 9, 1));
  check('set_packet_loss_perc', e.minisilk_set_packet_loss_perc(0));
  console.log(`== variant ${variant}: lookahead ${e.minisilk_lookahead()}`);
  const sizes = [];
  const tocs = new Map();
  let total = 0;
  let dtx = 0;
  for (let n = 0; n < NFRAMES; n++) {
    if (n === 200) check('set_bitrate', e.minisilk_set_bitrate(12000));
    const x = signal(n);
    let len;
    if (n % 2 === 0) {
      new Float32Array(e.memory.buffer, e.minisilk_input_ptr(), FRAME).set(x);
      len = check('encode', e.minisilk_encode());
    } else {
      const pcm = new Int16Array(e.memory.buffer, e.minisilk_input_i16_ptr(), FRAME);
      for (let i = 0; i < FRAME; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768)));
      len = check('encode_i16', e.minisilk_encode_i16());
    }
    const toc = new Uint8Array(e.memory.buffer, e.minisilk_output_ptr(), len)[0];
    sizes.push(len);
    tocs.set(toc, (tocs.get(toc) ?? 0) + 1);
    total += len;
    if (len === 1) dtx++;
  }
  console.log(`packet sizes: ${sizes.join(' ')}`);
  console.log(`TOCs: ${[...tocs].map(([t, c]) => `0x${t.toString(16).padStart(2, '0')} x${c}`).join(', ')}`);
  console.log(`total ${total} bytes, ${dtx} one-byte (DTX) packets`);
  if (dtx === 0) throw new Error('expected DTX packets during the silent gap');
}
