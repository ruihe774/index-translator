import { test } from "node:test";
import assert from "node:assert/strict";
import { Qoa, QoaError, qoaEncodedSize } from "../src/qoa.ts";
import { readFileSync } from "node:fs";
import { SCALEFACTOR_TAB, dequant, refDecode, refEncode } from "./reference.ts";

const qoa = await Qoa.create();
const dist = (name: string) => readFileSync(new URL(`../dist/${name}`, import.meta.url));

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

type Signal = "music" | "noise" | "square" | "silence" | "extreme";

function signal(kind: Signal, n: number, ch: number, seed = 1): Int16Array {
  const r = rng(seed);
  const out = new Int16Array(n * ch);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      let v = 0;
      switch (kind) {
        case "music":
          v = 7000 * Math.sin(i * 0.021 * (c + 1)) * Math.sin(i * 0.0003) +
            4000 * Math.sin(i * 0.0063 + c) + 900 * (r() - 0.5);
          break;
        case "noise":
          v = (r() - 0.5) * 60000;
          break;
        case "square":
          v = ((i >> (3 + c)) & 1) ? 32767 : -32768;
          break;
        case "silence":
          v = 0;
          break;
        case "extreme":
          v = r() < 0.5 ? -32768 : 32767;
          break;
      }
      out[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
  return out;
}

function snr(a: Int16Array, b: Int16Array): number {
  let s = 0;
  let e = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * a[i];
    e += (a[i] - b[i]) ** 2;
  }
  return e === 0 ? Infinity : 10 * Math.log10(s / e);
}

test("dequantization table follows the spec formula", () => {
  assert.deepEqual(SCALEFACTOR_TAB, [1, 7, 21, 45, 84, 138, 211, 304, 421, 562, 731, 928, 1157, 1419, 1715, 2048]);
  // One single-slice frame per (scalefactor, residual): zero LMS state makes
  // the first output sample equal to the dequantized residual.
  for (let sf = 0; sf < 16; sf++)
    for (let qr = 0; qr < 8; qr++) {
      const f = new Uint8Array(8 + 8 + 16 + 8);
      const dv = new DataView(f.buffer);
      dv.setUint32(0, 0x716f6166);
      dv.setUint32(4, 1);
      dv.setUint32(8, (1 << 24) | 44100);
      dv.setUint16(12, 1);
      dv.setUint16(14, 8 + 16 + 8);
      dv.setBigUint64(32, (BigInt(sf) << 60n) | (BigInt(qr) << 57n));
      assert.equal(qoa.decode(f).samples[0], dequant(sf, qr), `sf=${sf} qr=${qr}`);
    }
});

test("decoder matches the reference decoder on random streams", () => {
  const r = rng(42);
  for (let iter = 0; iter < 200; iter++) {
    const ch = iter % 25 === 0 ? 31 : 1 + Math.floor(r() * 8);
    const frames = 1 + Math.floor(r() * 3);
    const parts: Uint8Array[] = [];
    let total = 0;
    const sr = 1 + Math.floor(r() * 0xffffff);
    for (let f = 0; f < frames; f++) {
      const fs = f < frames - 1 ? 5120 : 1 + Math.floor(r() * 5120);
      total += fs;
      const slices = Math.ceil(fs / 20);
      const size = 8 + 16 * ch + slices * ch * 8;
      const b = new Uint8Array(size);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, (ch << 24) | sr);
      dv.setUint16(4, fs);
      dv.setUint16(6, size);
      for (let c = 0; c < ch; c++) {
        for (let k = 0; k < 4; k++) dv.setInt16(8 + c * 16 + k * 2, Math.floor((r() - 0.5) * 65536));
        for (let k = 0; k < 4; k++) dv.setInt16(16 + c * 16 + k * 2, Math.floor((r() - 0.5) * 65536));
      }
      for (let o = 8 + 16 * ch; o < size; o++) b[o] = Math.floor(r() * 256);
      parts.push(b);
    }
    const file = new Uint8Array(8 + parts.reduce((a, p) => a + p.length, 0));
    new DataView(file.buffer).setUint32(0, 0x716f6166);
    new DataView(file.buffer).setUint32(4, iter % 2 ? total : 0);
    let o = 8;
    for (const p of parts) {
      file.set(p, o);
      o += p.length;
    }
    const want = refDecode(file, true);
    const got = qoa.decode(file);
    assert.equal(got.channels, ch);
    assert.equal(got.samples.length, total * ch);
    assert.deepEqual(got.samples, want.samples, `iteration ${iter}`);
  }
});

const lengths = [1, 2, 19, 20, 21, 39, 41, 5119, 5120, 5121, 10240 + 7];
for (const kind of ["music", "noise", "square", "silence", "extreme"] as Signal[]) {
  test(`encoder matches the reference encoder (${kind})`, () => {
    for (const n of lengths)
      for (const ch of [1, 2, 3, 6]) {
        if (n > 5121 && ch > 2) continue;
        const pcm = signal(kind, n, ch, n * 31 + ch);
        const got = qoa.encode(pcm, ch, 48000);
        const want = refEncode(pcm, ch, 48000);
        assert.equal(got.length, qoaEncodedSize(n, ch));
        assert.equal(got.length, want.length);
        assert.deepEqual(got, want, `n=${n} ch=${ch}`);
        const dec = qoa.decode(got);
        assert.deepEqual(dec.samples, refDecode(got).samples, "decoders agree");
        assert.deepEqual(dec.samples, refDecode(got, true).samples, "decoders agree (int32)");
      }
  });
}

test("headers and LMS state are well formed", () => {
  const ch = 2;
  const n = 5120 * 2 + 77;
  const file = qoa.encode(signal("extreme", n, ch), ch, 16777215);
  const dv = new DataView(file.buffer, file.byteOffset);
  assert.equal(dv.getUint32(0), 0x716f6166);
  assert.equal(dv.getUint32(4), n);
  let o = 8;
  const sizes: number[] = [];
  while (o < file.length) {
    assert.equal(dv.getUint8(o), ch);
    assert.equal(dv.getUint32(o) & 0xffffff, 16777215);
    sizes.push(dv.getUint16(o + 4));
    o += dv.getUint16(o + 6);
  }
  assert.equal(o, file.length);
  assert.deepEqual(sizes, [5120, 5120, 77]);
  // first frame starts from the initial LMS state
  assert.deepEqual([0, 1, 2, 3].map((k) => dv.getInt16(8 + 8 + 8 + k * 2)), [0, 0, -8192, 16384]);
});

test("streaming flag and incremental encoder", () => {
  const ch = 2;
  const n = 5120 * 3 + 999;
  const pcm = signal("music", n, ch, 9);
  const whole = qoa.encode(pcm, ch, 44100, { streaming: true });
  assert.equal(new DataView(whole.buffer, whole.byteOffset).getUint32(4), 0);
  assert.deepEqual(qoa.decode(whole).samples, qoa.decode(qoa.encode(pcm, ch, 44100)).samples);

  const r = rng(5);
  const enc = qoa.createEncoder(ch, 44100);
  const chunks: Uint8Array[] = [];
  let i = 0;
  while (i < n) {
    const k = Math.min(n - i, Math.floor(r() * 9000));
    chunks.push(enc.write(pcm.subarray(i * ch, (i + k) * ch)));
    // other work on the same instance must not disturb the encoder's state
    qoa.encode(signal("noise", 333, 3), 3, 8000);
    i += k;
  }
  chunks.push(enc.end());
  const streamed = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    streamed.set(c, o);
    o += c.length;
  }
  assert.deepEqual(streamed, whole);
  assert.throws(() => enc.write(new Int16Array(2)), QoaError);
  assert.throws(() => qoa.createEncoder(1, 8000).end(), QoaError);
});

test("decodeFrames handles format changes within a stream", () => {
  const a = qoa.encode(signal("music", 6000, 1), 1, 22050, { streaming: true });
  const b = qoa.encode(signal("music", 300, 3), 3, 48000, { streaming: true });
  const joined = new Uint8Array(a.length + b.length - 8);
  joined.set(a);
  joined.set(b.subarray(8), a.length);
  assert.throws(() => qoa.decode(joined), /decodeFrames/);
  const frames = qoa.decodeFrames(joined);
  assert.deepEqual(frames.map((f) => [f.channels, f.sampleRate, f.samples.length]), [
    [1, 22050, 5120],
    [1, 22050, 880],
    [3, 48000, 900],
  ]);
  assert.deepEqual(frames[2].samples, qoa.decode(b).samples);
});

test("malformed input is rejected", () => {
  const good = qoa.encode(signal("music", 100, 2), 2, 44100);
  assert.throws(() => qoa.decode(good.subarray(0, 4)), /too short/);
  const bad = good.slice();
  bad[0] = 0x51;
  assert.throws(() => qoa.decode(bad), /magic/);
  assert.throws(() => qoa.decode(good.subarray(0, 8)), /no frames/);
  assert.throws(() => qoa.decode(good.subarray(0, 12)), /truncated frame header/);
  assert.throws(() => qoa.decode(good.subarray(0, good.length - 1)), /truncated frame/);
  const size = good.slice();
  size[15]++;
  assert.throws(() => qoa.decode(size), /frame size/);
  const zero = good.slice();
  zero[8] = 0;
  assert.throws(() => qoa.decode(zero), /invalid frame header/);
  const count = good.slice();
  count[7]++;
  assert.throws(() => qoa.decode(count), /announces/);
});

test("invalid encoder arguments are rejected", () => {
  assert.throws(() => qoa.encode(new Int16Array(0), 1, 44100), QoaError);
  assert.throws(() => qoa.encode(new Int16Array(3), 2, 44100), QoaError);
  assert.throws(() => qoa.encode(new Int16Array(32), 32, 44100), QoaError);
  assert.throws(() => qoa.encode(new Int16Array(2), 1, 0), QoaError);
  assert.throws(() => qoa.encode(new Int16Array(2), 1, 16777216), QoaError);
  assert.throws(() => qoa.encode(new Int16Array(2), 1.5, 8000), QoaError);
});

test("31 channels round trip", () => {
  const pcm = signal("music", 2345, 31, 3);
  const enc = qoa.encode(pcm, 31, 8000);
  assert.deepEqual(enc, refEncode(pcm, 31, 8000));
  const dec = qoa.decode(enc);
  assert.equal(dec.channels, 31);
  assert.ok(snr(pcm, dec.samples) > 25);
});

test("SIMD fallback build and sync instantiation behave identically", async () => {
  const pcm = signal("noise", 7000, 2, 77);
  const relaxed = Qoa.createSync(dist("qoa.wasm"));
  const simd = await Qoa.create(dist("qoa-simd.wasm"));
  const mod = new WebAssembly.Module(dist("qoa-simd.wasm"));
  const fromModule = await Qoa.create(mod);
  const fromUrl = await Qoa.create(new URL("../dist/qoa-simd.wasm", import.meta.url));
  assert.equal(qoa.backend, "relaxed-simd");
  const e1 = relaxed.encode(pcm, 2, 44100);
  assert.deepEqual(simd.encode(pcm, 2, 44100), e1);
  assert.deepEqual(fromModule.encode(pcm, 2, 44100), e1);
  assert.deepEqual(fromUrl.encode(pcm, 2, 44100), e1);
  assert.deepEqual(simd.decode(e1).samples, relaxed.decode(e1).samples);
});

test("large input grows memory", () => {
  const n = 44100 * 30;
  const pcm = signal("music", n, 2, 11);
  const enc = qoa.encode(pcm, 2, 44100);
  const dec = qoa.decode(enc);
  assert.equal(dec.samples.length, pcm.length);
  assert.ok(snr(pcm, dec.samples) > 30);
});
