// sat-3l-sm on native/sat.zig (a port of src/sat.wat), driven through bun:ffi. Same contract as src/engine.ts:
// the pinned model.onnx only, read from fixed offsets (tensors.ts), and `run` with the shape of sat.ts's RunModel.
//
// The library allocates each weight tensor (sat_slot); this side reads the file straight into that memory.

import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { closeSync, fstatSync, openSync } from "node:fs";
import { join } from "node:path";

import { HEADER_BYTES, HEADER_HASH, readFully, type SatEngine } from "../src/engine";
import { MODEL_SIZE, TENSORS } from "../src/tensors";

const { ptr: P, u32, i32, u64, void: VOID, cstring } = FFIType;
const SYMBOLS = {
  sat_create: { args: [u32], returns: P },
  sat_slot: { args: [P, u32, u64], returns: P },
  sat_prepare: { args: [P], returns: i32 },
  sat_run: { args: [P, P, P, u32, u32, P], returns: i32 },
  sat_step: { args: [P, u32], returns: VOID },
  sat_ntasks: { args: [P, u32], returns: u32 },
  sat_config: { args: [], returns: cstring },
  sat_destroy: { args: [P], returns: VOID },
} as const;

export const DEFAULT_LIB = join(import.meta.dir, "out", "base", "libsat.so");

export interface NativeEngine extends SatEngine {
  /** The build's tunables (sat_config). */
  config: string;
  /** Runs one op of the current layer on the state of the last run (profiling). */
  step(op: number): void;
  ntasks(op: number): number;
}

export function loadNative(modelPath: string, threads: number, libPath = DEFAULT_LIB): NativeEngine {
  const lib = dlopen(libPath, SYMBOLS);
  const f = lib.symbols;
  const e = f.sat_create(threads);
  if (!e) throw new Error("sat_create: out of memory");

  const fd = openSync(modelPath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size !== MODEL_SIZE) {
      throw new Error(`${modelPath}: ${size} bytes, expected the pinned sat-3l-sm export (${MODEL_SIZE})`);
    }
    const header = new Uint8Array(HEADER_BYTES);
    readFully(fd, header, 0);
    if (BigInt(Bun.hash(header)) !== HEADER_HASH) {
      throw new Error(`${modelPath}: not the pinned sat-3l-sm export (graph fingerprint differs)`);
    }
    TENSORS.forEach(([offset, bytes], i) => {
      const at = f.sat_slot(e, i, bytes);
      if (!at) throw new Error("sat_slot: out of memory");
      readFully(fd, new Uint8Array(toArrayBuffer(at, 0, bytes)), offset);
    });
  } catch (err) {
    f.sat_destroy(e);
    throw err;
  } finally {
    closeSync(fd);
  }
  const rc = f.sat_prepare(e);
  if (rc !== 0) {
    f.sat_destroy(e);
    throw new Error(`sat_prepare: ${rc}`);
  }

  return {
    config: String(f.sat_config()),
    run(ids, mask, rows, width) {
      const out = new Float32Array(rows * width);
      if (out.length === 0) return out;
      if (f.sat_run(e, ptr(ids), ptr(mask), rows, width, ptr(out)) !== 0) {
        throw new Error(`sequences are at most 512 tokens, got ${width}`);
      }
      return out;
    },
    step: (op) => f.sat_step(e, op),
    ntasks: (op) => f.sat_ntasks(e, op),
    close() {
      f.sat_destroy(e);
      lib.close();
    },
  };
}

