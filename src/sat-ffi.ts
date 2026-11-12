// SaT (sat-3l-sm) on libsat, the forward pass of the pinned model in Zig (src/sat-engine.zig, built by
// scripts/zigbuild_sat_engine.ts), through bun:ffi. The library runs its own pool of threads. Only the pinned
// `model.onnx` runs: the weights are read from fixed offsets (src/sat-tensors.ts), not by parsing the file, so the
// file's size and a hash of its graph are checked first. Used from src/segment-worker.ts only: `run` blocks its
// thread.
//
// `run` is sat.ts's RunModel. Each row runs on its own, cut at its last unmasked token (masked keys get
// -65504 before the softmax, which comes out as exactly 0, so the cut changes nothing for the tokens
// kept); the logits of the padding are left 0.

import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import { libraryFile, once } from "./ffi-util";
import type { RunModel } from "./sat";
import { MODEL_SIZE, TENSORS } from "./sat-tensors";

/** The library inside `dir` (`vendor/sat`). */
export const satLibraryPath = (dir: string) => libraryFile(dir, "sat");

/** Bun.hash (wyhash) of the bytes before the first weight: the graph, which names every op and tensor. */
const HEADER_BYTES = 343_532;
const HEADER_HASH = 0xc_e6_2e_25_de_97_aa_9bn;

const { ptr: P, u32, i32, u64, cstring } = FFIType;
const SYMBOLS = {
  sat_create: { args: [u32], returns: P },
  sat_slot: { args: [P, u32, u64], returns: P },
  sat_prepare: { args: [P], returns: i32 },
  sat_run: { args: [P, P, P, u32, u32, P], returns: i32 },
  sat_config: { args: [], returns: cstring },
  sat_destroy: { args: [P], returns: FFIType.void },
} as const;

/** The longest sequence the engine's buffers hold. */
const MAX_SEQ = 512;

function bind(path: string) {
  if (!existsSync(path)) {
    throw new Error(`libsat not found at ${path}; run: bun scripts/zigbuild_sat_engine.ts`);
  }
  return dlopen(path, SYMBOLS);
}

const library = once("libsat", (dir) => bind(satLibraryPath(dir)));

/** The version file of the build in `dir` and the tunables the library was built with, for a log line. */
export function satEngineVersion(dir: string): string {
  const lib = library.open(dir);
  return `libsat ${readFileSync(join(dir, "VERSION"), "utf8").trim()}, ${String(lib.symbols.sat_config())}`;
}

export interface SatEngine {
  run: RunModel;
  close(): void;
}

/**
 * Opens libsat from `dir`, reads the model into memory the library allocated and starts `threads - 1` threads beside
 * the caller's. Synchronous.
 */
export function loadSatEngine(dir: string, modelPath: string, threads: number): SatEngine {
  return start(library.open(dir), modelPath, threads);
}

/** `loadSatEngine` on the library file `path`, any number of them in one process (scripts/sat_tune.ts's variants). */
export function loadSatEngineAt(path: string, modelPath: string, threads: number): SatEngine {
  return start(bind(path), modelPath, threads);
}

function start(lib: ReturnType<typeof bind>, modelPath: string, threads: number): SatEngine {
  const f = lib.symbols;
  const engine = f.sat_create(Math.max(1, threads));
  if (!engine) {
    throw new Error("libsat: out of memory");
  }
  const fd = openSync(modelPath, "r");
  try {
    const { size } = fstatSync(fd);
    if (size !== MODEL_SIZE) {
      throw new Error(`${modelPath}: ${size} bytes, expected the pinned sat-3l-sm export (${MODEL_SIZE})`);
    }
    const header = new Uint8Array(HEADER_BYTES);
    readFully(fd, header, 0);
    if (Bun.hash(header) !== HEADER_HASH) {
      throw new Error(`${modelPath}: not the pinned sat-3l-sm export (its graph differs)`);
    }
    TENSORS.forEach(([offset, bytes], i) => {
      const at = f.sat_slot(engine, i, bytes);
      if (!at) {
        throw new Error("libsat: out of memory");
      }
      readFully(fd, new Uint8Array(toArrayBuffer(at, 0, bytes)), offset);
    });
    // Rewrites the weights into the layout the kernels read and starts the threads.
    const status = f.sat_prepare(engine);
    if (status !== 0) {
      throw new Error(`libsat: sat_prepare failed (${status})`);
    }
  } catch (e) {
    f.sat_destroy(engine);
    throw e;
  } finally {
    closeSync(fd);
  }

  let closed = false;
  return {
    run(ids, mask, rows, width) {
      if (closed) {
        throw new Error("the segmentation engine is closed");
      }
      if (width > MAX_SEQ) {
        throw new Error(`sequences are at most ${MAX_SEQ} tokens, got ${width}`);
      }
      const out = new Float32Array(rows * width);
      if (out.length > 0 && f.sat_run(engine, ptr(ids), ptr(mask), rows, width, ptr(out)) !== 0) {
        throw new Error("libsat: sat_run failed");
      }
      return out;
    },
    close() {
      if (!closed) {
        closed = true;
        f.sat_destroy(engine);
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
