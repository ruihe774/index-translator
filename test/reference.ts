// Straightforward scalar implementations used as test oracles.
// The decoder follows the specification text literally (float math);
// the encoder is a port of the reference qoa.h encoder.

export const SCALEFACTOR_TAB = Array.from({ length: 16 }, (_, i) => Math.round(Math.pow(i + 1, 2.75)));
const DEQUANT = [0.75, -0.75, 2.5, -2.5, 4.5, -4.5, 7, -7];

export function dequant(sfQuant: number, qr: number): number {
  const r = SCALEFACTOR_TAB[sfQuant] * DEQUANT[qr];
  return r < 0 ? Math.ceil(r - 0.5) : Math.floor(r + 0.5);
}

const clamp16 = (v: number) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);

export interface RefAudio {
  channels: number;
  sampleRate: number;
  samples: Int16Array;
}

// With `int32` the arithmetic wraps like the reference C implementation (int);
// otherwise it is exact (only differs for pathological, overflowing streams).
export function refDecode(data: Uint8Array, int32 = false): RefAudio {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0) !== 0x716f6166) throw new Error("magic");
  const out: number[] = [];
  let channels = 0;
  let sampleRate = 0;
  let p = 8;
  while (p < data.length) {
    const ch = dv.getUint8(p);
    const sr = dv.getUint32(p) & 0xffffff;
    const fs = dv.getUint16(p + 4);
    const fsize = dv.getUint16(p + 6);
    const frameEnd = p + fsize;
    channels = ch;
    sampleRate = sr;
    p += 8;
    const hist: number[][] = [];
    const wts: number[][] = [];
    for (let c = 0; c < ch; c++) {
      hist.push([0, 1, 2, 3].map((i) => dv.getInt16(p + i * 2)));
      wts.push([0, 1, 2, 3].map((i) => dv.getInt16(p + 8 + i * 2)));
      p += 16;
    }
    const base = out.length;
    for (let i = 0; i < fs * ch; i++) out.push(0);
    for (let s = 0; s < fs; s += 20) {
      for (let c = 0; c < ch; c++) {
        const slice = dv.getBigUint64(p);
        p += 8;
        const sf = Number(slice >> 60n);
        const len = Math.min(20, fs - s);
        for (let i = 0; i < len; i++) {
          const qr = Number((slice >> BigInt(57 - 3 * i)) & 7n);
          const r = dequant(sf, qr);
          const h = hist[c];
          const w = wts[c];
          let pred = 0;
          if (int32) {
            for (let n = 0; n < 4; n++) pred = (pred + Math.imul(h[n], w[n])) | 0;
            pred >>= 13;
          } else {
            for (let n = 0; n < 4; n++) pred += h[n] * w[n];
            pred = Math.floor(pred / 8192);
          }
          const smp = clamp16(int32 ? (pred + r) | 0 : pred + r);
          out[base + (s + i) * ch + c] = smp;
          const delta = r >> 4;
          for (let n = 0; n < 4; n++) {
            w[n] += h[n] < 0 ? -delta : delta;
            if (int32) w[n] |= 0;
          }
          h.shift();
          h.push(smp);
        }
      }
    }
    if (p !== frameEnd) throw new Error("frame size");
  }
  return { channels, sampleRate, samples: Int16Array.from(out) };
}

// --- port of the reference encoder (qoa.h) ---------------------------------

const RECIPROCAL_TAB = SCALEFACTOR_TAB.map((s) => Math.floor(((1 << 16) + s - 1) / s));
const QUANT_TAB = [7, 7, 7, 5, 5, 3, 3, 1, 0, 0, 2, 2, 4, 4, 6, 6, 6];
const DEQUANT_TAB = SCALEFACTOR_TAB.map((_, sf) => DEQUANT.map((_, q) => dequant(sf, q)));

function qoaDiv(v: number, sf: number): number {
  const reciprocal = RECIPROCAL_TAB[sf];
  let n = (Math.imul(v, reciprocal) + (1 << 15)) >> 16;
  n = n + (Math.sign(v) - Math.sign(n));
  return n;
}

interface Lms {
  h: Int32Array;
  w: Int32Array;
}

export function refEncode(samples: Int16Array, channels: number, sampleRate: number): Uint8Array {
  const n = samples.length / channels;
  const frames = Math.ceil(n / 5120);
  const slicesTotal = Math.ceil(n / 20);
  const out = new Uint8Array(8 + frames * (8 + 16 * channels) + slicesTotal * channels * 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x716f6166);
  dv.setUint32(4, n);
  let p = 8;
  const lms: Lms[] = [];
  const prevSf: number[] = [];
  for (let c = 0; c < channels; c++) {
    lms.push({ h: new Int32Array(4), w: Int32Array.from([0, 0, -(1 << 13), 1 << 14]) });
    prevSf.push(0);
  }
  for (let fs = 0; fs < n; fs += 5120) {
    const flen = Math.min(5120, n - fs);
    const slices = Math.ceil(flen / 20);
    const fsize = 8 + 16 * channels + slices * channels * 8;
    dv.setUint32(p, (channels << 24) | sampleRate);
    dv.setUint16(p + 4, flen);
    dv.setUint16(p + 6, fsize);
    p += 8;
    for (let c = 0; c < channels; c++) {
      for (let i = 0; i < 4; i++) dv.setInt16(p + i * 2, lms[c].h[i]);
      for (let i = 0; i < 4; i++) dv.setInt16(p + 8 + i * 2, lms[c].w[i]);
      p += 16;
    }
    for (let si = 0; si < flen; si += 20) {
      for (let c = 0; c < channels; c++) {
        const sliceLen = Math.min(20, flen - si);
        let bestRank = Infinity;
        let bestSlice = 0n;
        let bestLms: Lms = lms[c];
        let bestSf = 0;
        for (let sfi = 0; sfi < 16; sfi++) {
          const sf = (sfi + prevSf[c]) % 16;
          const l: Lms = { h: lms[c].h.slice(), w: lms[c].w.slice() };
          let slice = BigInt(sf);
          let rank = 0;
          let complete = true;
          for (let i = 0; i < sliceLen; i++) {
            const sample = samples[(fs + si + i) * channels + c];
            let pred = 0;
            for (let k = 0; k < 4; k++) pred = (pred + Math.imul(l.h[k], l.w[k])) | 0;
            pred >>= 13;
            const residual = sample - pred;
            const scaled = qoaDiv(residual, sf);
            const clamped = Math.max(-8, Math.min(8, scaled));
            const quantized = QUANT_TAB[clamped + 8];
            const deq = DEQUANT_TAB[sf][quantized];
            const rec = clamp16(pred + deq);
            // int arithmetic as in C; error * error is computed exactly here
            // (qoa.h squares in int, which overflows for |error| > 46340)
            let pen = ((Math.imul(l.w[0], l.w[0]) + Math.imul(l.w[1], l.w[1]) +
              Math.imul(l.w[2], l.w[2]) + Math.imul(l.w[3], l.w[3])) | 0) >> 18;
            pen -= 0x8ff;
            if (pen < 0) pen = 0;
            const err = sample - rec;
            rank += err * err + pen * pen;
            if (rank > bestRank) {
              complete = false;
              break;
            }
            const delta = deq >> 4;
            for (let k = 0; k < 4; k++) l.w[k] += l.h[k] < 0 ? -delta : delta;
            l.h.copyWithin(0, 1);
            l.h[3] = rec;
            slice = (slice << 3n) | BigInt(quantized);
          }
          if (complete && rank < bestRank) {
            bestRank = rank;
            bestSlice = slice;
            bestLms = l;
            bestSf = sf;
          }
        }
        prevSf[c] = bestSf;
        lms[c] = bestLms;
        bestSlice <<= BigInt((20 - sliceLen) * 3);
        dv.setBigUint64(p, bestSlice);
        p += 8;
      }
    }
  }
  return out;
}
