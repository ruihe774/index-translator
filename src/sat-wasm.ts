// SaT (sat-3l-sm) on sat.wasm, a forward pass of the pinned model written by hand in WebAssembly
// (scripts/fetch_sat_wasm.ts), with a pool of threads on its shared memory. Only the pinned `model.onnx`
// runs: the weights are read from fixed offsets (src/sat-tensors.ts), not by parsing the file, so the
// file's size and a hash of its graph are checked first. Used from src/segment-worker.ts only: `run`
// blocks its thread.
//
// `run` is sat.ts's RunModel. Each row runs on its own, cut at its last unmasked token (masked keys get
// -65504 before the softmax, which comes out as exactly 0, so the cut changes nothing for the tokens
// kept); the logits of the padding are left 0.

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import type { RunModel } from "./sat";
import { MODEL_SIZE, TENSORS } from "./sat-tensors";
import { startWorker } from "./worker-rpc";

/** The module inside `dir` (`vendor/sat-wasm`). */
export const wasmPath = (dir: string) => join(dir, "sat.wasm");

/** Bun.hash (wyhash) of the bytes before the first weight: the graph, which names every op and tensor. */
const HEADER_BYTES = 343_532;
const HEADER_HASH = 0xc_e6_2e_25_de_97_aa_9bn;

interface Exports {
  forward(s: number): void;
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

/** Byte offsets in the control block at `CTRL`. */
const CTRL_GEN = 0;
const CTRL_QUIT = 20;
const CTRL_NTHREADS = 24;

export interface SatEngine {
  run: RunModel;
  close(): void;
}

/**
 * Compiles sat.wasm from `dir`, reads the model into its memory and starts `threads - 1` workers beside
 * this thread. Synchronous: the pool does not wait for a worker that has not started yet (this thread
 * takes the tasks it leaves), so the workers join as they come up.
 */
export function loadSatEngine(dir: string, modelPath: string, threads: number): SatEngine {
  const module = new WebAssembly.Module(readFileSync(wasmPath(dir)));
  // The layout comes from the module itself: instantiated once on a one-page memory to read it.
  const probe = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const layout = new WebAssembly.Instance(module, { env: { memory: probe } }).exports as unknown as Exports;
  const weightsAt = layout.WEIGHTS.value as number;
  threads = Math.max(1, Math.min(threads, layout.MAX_THREADS.value as number));

  // Each tensor at a 64-byte boundary after the last.
  const places: number[] = [];
  let end = weightsAt;
  for (const [, bytes] of TENSORS) {
    places.push(end);
    end = (end + bytes + 63) & ~63;
  }
  const pages = Math.ceil(end / 65_536);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const heap = new Uint8Array(memory.buffer);

  const fd = openSync(modelPath, "r");
  try {
    const { size } = fstatSync(fd);
    if (size !== MODEL_SIZE) {
      throw new Error(`${modelPath}: ${size} bytes, expected the pinned sat-3l-sm export (${MODEL_SIZE})`);
    }
    // The graph goes through the scratch area below the weights, to be fingerprinted.
    const header = heap.subarray(weightsAt - HEADER_BYTES, weightsAt);
    readFully(fd, header, 0);
    if (Bun.hash(header) !== HEADER_HASH) {
      throw new Error(`${modelPath}: not the pinned sat-3l-sm export (its graph differs)`);
    }
    header.fill(0);
    TENSORS.forEach(([offset, bytes], i) => {
      const at = places[i]!;
      readFully(fd, heap.subarray(at, at + bytes), offset);
    });
  } finally {
    closeSync(fd);
  }
  const ctrl = new Int32Array(memory.buffer, layout.CTRL.value as number, 16);
  new Int32Array(memory.buffer, layout.SLOTS.value as number, TENSORS.length).set(places);
  ctrl[CTRL_NTHREADS / 4] = threads;

  const ex = new WebAssembly.Instance(module, { env: { memory } }).exports as unknown as Exports;
  // Rewrites the weights into the layout the kernels read; before any worker runs a task.
  ex.prepare();

  const workers = Array.from({ length: threads - 1 }, (_, i) => {
    const worker = startWorker("sat-wasm-thread.ts");
    // A worker that fails leaves its tasks to the others: slower, not wrong.
    worker.onerror = (e) => console.error(`[segment] sat.wasm thread ${i + 1}: ${e.message}`);
    worker.postMessage({ module, memory, tid: i + 1 });
    return worker;
  });

  const maxSeq = ex.MAX_SEQ.value as number;
  const ids = new Int32Array(memory.buffer, ex.IDS.value as number, maxSeq);
  const mask = new Float32Array(memory.buffer, ex.MASK.value as number, maxSeq);
  const logits = new Float32Array(memory.buffer, ex.LOGITS.value as number, maxSeq);
  let closed = false;

  return {
    run(inIds, inMask, rows, width) {
      if (closed) {
        throw new Error("the segmentation engine is closed");
      }
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
      if (closed) {
        return;
      }
      closed = true;
      // Wakes the workers sleeping on GEN, which then see QUIT and return.
      Atomics.store(ctrl, CTRL_QUIT / 4, 1);
      Atomics.add(ctrl, CTRL_GEN / 4, 1);
      Atomics.notify(ctrl, CTRL_GEN / 4);
      for (const worker of workers) {
        worker.terminate();
      }
    },
  };
}

function readFully(fd: number, into: Uint8Array, position: number): void {
  for (let done = 0; done < into.length;) {
    const n = readSync(fd, into, done, into.length - done, position + done);
    if (n <= 0) {
      throw new Error("the model file ended early");
    }
    done += n;
  }
}
