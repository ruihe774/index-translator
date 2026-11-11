// sat-3l-sm on a hand-written WebAssembly kernel (sat.wat) instead of ONNX Runtime. Only the pinned
// model.onnx is supported: the weights are read from fixed offsets (tensors.ts), not by parsing the file.
//
// `run` has the shape of sat.ts's RunModel: `rows × width` ids and mask in, one logit per token out. Each
// row is run on its own, cut at its last unmasked token (masked keys get -65504 before the softmax,
// which comes out as exactly 0, so the cut changes nothing for the tokens that are kept); the logits
// of the padding are left 0.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { MODEL_SIZE, TENSORS } from "./tensors";

/** Bun.hash (wyhash) of the bytes before the first weight: the graph, which names every op and tensor. */
export const HEADER_BYTES = 343532;
export const HEADER_HASH = 0xce62e25de97aa9bn; // bun tools/fingerprint.ts

interface Exports {
  forward(s: number): void;
  worker(tid: number): void;
  prepare(): void;
  IDS: WebAssembly.Global;
  MASK: WebAssembly.Global;
  LOGITS: WebAssembly.Global;
  SLOTS: WebAssembly.Global;
  CTRL: WebAssembly.Global;
  WEIGHTS: WebAssembly.Global;
  MAX_THREADS: WebAssembly.Global;
  MAX_SEQ: WebAssembly.Global;
}

const CTRL_QUIT = 20;
const CTRL_NTHREADS = 24;
const CTRL_GEN = 0;

export interface SatEngine {
  run(ids: BigInt64Array, mask: Float32Array, rows: number, width: number): Float32Array;
  close(): void;
}

export async function loadEngine(modelPath: string, threads: number, wasmPath = join(import.meta.dir, "sat.wasm")): Promise<SatEngine> {
  const module = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
  // Layout constants come from the module itself; instantiate once against a 1-page probe memory.
  const probe = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const consts = (await WebAssembly.instantiate(module, { env: { memory: probe } })).exports as unknown as Exports;
  const weightsAt = consts.WEIGHTS.value as number;
  const maxThreads = consts.MAX_THREADS.value as number;
  threads = Math.max(1, Math.min(threads, maxThreads));

  const places: number[] = [];
  let end = weightsAt;
  for (const [, bytes] of TENSORS) {
    places.push(end);
    end = (end + bytes + 63) & ~63;
  }
  const pages = Math.ceil(end / 65536);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const heap = new Uint8Array(memory.buffer);

  const fd = openSync(modelPath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size !== MODEL_SIZE) {
      throw new Error(`${modelPath}: ${size} bytes, expected the pinned sat-3l-sm export (${MODEL_SIZE})`);
    }
    // The graph goes through the scratch area first, to be fingerprinted.
    const header = heap.subarray(weightsAt - HEADER_BYTES, weightsAt);
    readFully(fd, header, 0);
    if (BigInt(Bun.hash(header)) !== HEADER_HASH) {
      throw new Error(`${modelPath}: not the pinned sat-3l-sm export (graph fingerprint differs)`);
    }
    TENSORS.forEach(([offset, bytes], i) => readFully(fd, heap.subarray(places[i]!, places[i]! + bytes), offset));
  } finally {
    closeSync(fd);
  }
  heap.fill(0, weightsAt - HEADER_BYTES, weightsAt);
  const ctrl = new Int32Array(memory.buffer, consts.CTRL.value as number, 16);
  new Int32Array(memory.buffer, consts.SLOTS.value as number, TENSORS.length).set(places);
  ctrl[CTRL_NTHREADS / 4] = threads;

  const workers: Worker[] = [];
  await Promise.all(
    Array.from({ length: threads - 1 }, (_, i) => {
      const w = new Worker(new URL("./thread.ts", import.meta.url).href);
      workers.push(w);
      return new Promise<void>((resolve, reject) => {
        w.onmessage = () => resolve();
        w.onerror = (e) => reject(e);
        w.postMessage({ module, memory, tid: i + 1 });
      });
    }),
  );

  const ex = (await WebAssembly.instantiate(module, { env: { memory } })).exports as unknown as Exports;
  ex.prepare();
  const ids = new Int32Array(memory.buffer, ex.IDS.value as number, 512);
  const mask = new Float32Array(memory.buffer, ex.MASK.value as number, 512);
  const logits = new Float32Array(memory.buffer, ex.LOGITS.value as number, 512);
  const maxSeq = ex.MAX_SEQ.value as number;

  return {
    run(inIds, inMask, rows, width) {
      if (width > maxSeq) {
        throw new Error(`sequences are at most ${maxSeq} tokens, got ${width}`);
      }
      const out = new Float32Array(rows * width);
      for (let r = 0; r < rows; r++) {
        const at = r * width;
        let s = width;
        while (s > 0 && inMask[at + s - 1] === 0) {
          s--;
        }
        if (s === 0) {
          continue;
        }
        for (let t = 0; t < s; t++) {
          ids[t] = Number(inIds[at + t]);
          mask[t] = inMask[at + t]!;
        }
        ex.forward(s);
        out.set(logits.subarray(0, s), at);
      }
      return out;
    },
    close() {
      Atomics.store(ctrl, CTRL_QUIT / 4, 1);
      Atomics.add(ctrl, CTRL_GEN / 4, 1);
      Atomics.notify(ctrl, CTRL_GEN / 4);
      for (const w of workers) {
        w.terminate();
      }
    },
  };
}

export function readFully(fd: number, into: Uint8Array, position: number): void {
  for (let done = 0; done < into.length;) {
    const n = readSync(fd, into, done, into.length - done, position + done);
    if (n <= 0) {
      throw new Error("model file ended early");
    }
    done += n;
  }
}
