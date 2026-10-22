// ONNX Runtime's C API through bun:ffi: just what the segmentation worker needs to run one model on
// the CPU. Every call blocks its thread, so this module is only used from src/segment-worker.ts.
//
// The library exports one function, `OrtGetApiBase`; everything else is a function pointer in the
// `OrtApi` struct it hands out for an API version. The struct only grows, so a function's slot never
// changes; the slots below were counted from `include/onnxruntime_c_api.h` of the pinned release
// (scripts/fetch_onnxruntime.ts), and a new pin means counting them again. A wrong slot calls the
// wrong function, so the version string is checked at load as well.

import { CFunction, dlopen, type FFIFunction, type Pointer, ptr, read, suffix, toArrayBuffer } from "bun:ffi";
import { join } from "node:path";

/** The API version of the pinned release's header; a library older than that refuses it. */
const ORT_API_VERSION = 31;

/** Index of each function in `struct OrtApi`. */
const SLOT = {
  GetErrorMessage: 2,
  CreateEnv: 3,
  CreateSession: 7,
  Run: 9,
  CreateSessionOptions: 10,
  DisableCpuMemArena: 19,
  SetIntraOpNumThreads: 24,
  SetInterOpNumThreads: 25,
  CreateTensorWithDataAsOrtValue: 49,
  GetTensorMutableData: 51,
  GetTensorShapeElementCount: 64,
  GetTensorTypeAndShape: 65,
  CreateCpuMemoryInfo: 69,
  ReleaseEnv: 92,
  ReleaseStatus: 93,
  ReleaseMemoryInfo: 94,
  ReleaseSession: 95,
  ReleaseValue: 96,
  ReleaseTensorTypeAndShapeInfo: 99,
  ReleaseSessionOptions: 100,
} as const;

/** `ONNXTensorElementDataType`. */
const FLOAT = 1;
const INT64 = 7;
/** `OrtLoggingLevel`: only errors go to stderr (each also comes back as a status). */
const LOG_ERROR = 3;
/** `OrtAllocatorType` and `OrtMemType` of plain CPU memory. */
const ARENA_ALLOCATOR = 1;
const MEM_TYPE_DEFAULT = 0;

export class OrtError extends Error {}

/** The shared library inside `dir`: the SONAME link on Linux, the DLL on Windows (by full path: System32 has another). */
export const libraryPath = (dir: string) =>
  join(dir, process.platform === "win32" ? `onnxruntime.${suffix}` : `libonnxruntime.${suffix}.1`);

/** A path as `ORTCHAR_T*`: UTF-16 on Windows, UTF-8 elsewhere; NUL-terminated. */
function ortPath(path: string): Uint8Array {
  if (process.platform === "win32") {
    return new Uint8Array(Buffer.from(`${path}\0`, "utf16le"));
  }
  return new TextEncoder().encode(`${path}\0`);
}

const cstr = (s: string) => new TextEncoder().encode(`${s}\0`);

/** A slot for one pointer the library writes, and what it wrote. */
const out = () => new BigUint64Array(1);
const pointerIn = (slot: BigUint64Array) => Number(slot[0]) as Pointer;

export interface Session {
  /** Logits of `ids` (int64) and `mask` (float32), both `rows × width`: one float per token, `rows × width` of them. */
  run(ids: BigInt64Array, mask: Float32Array, rows: number, width: number): Float32Array;
  close(): void;
}

export interface Runtime {
  readonly version: string;
  /** A session for a model with inputs `input_ids` and `attention_mask` and one output, `logits`. */
  open(modelPath: string, threads: number): Session;
  close(): void;
}

export function loadRuntime(dir: string): Runtime {
  const lib = dlopen(libraryPath(dir), { OrtGetApiBase: { args: [], returns: "ptr" } });
  const base = lib.symbols.OrtGetApiBase();
  if (!base) {
    throw new OrtError("OrtGetApiBase returned nothing");
  }
  /** The function at `at` (a pointer read from a struct), with the C signature `T` the header gives it. */
  const call = <T>(at: number, args: FFIFunction["args"], returns: FFIFunction["returns"] = "ptr"): T =>
    CFunction({ ptr: at as Pointer, args, returns }) as unknown as T;

  // struct OrtApiBase { const OrtApi* (*GetApi)(uint32_t); const char* (*GetVersionString)(void); }
  const getApi = call<(version: number) => Pointer | null>(read.ptr(base, 0), ["u32"]);
  // A `cstring` return arrives as a JavaScript string.
  const version = call<() => string>(read.ptr(base, 8), [], "cstring")();
  const api = getApi(ORT_API_VERSION);
  if (!api) {
    throw new OrtError(`ONNX Runtime ${version} does not offer API version ${ORT_API_VERSION}`);
  }
  /** An `OrtApi` function; the ones returning `OrtStatus*` give null on success. */
  const fn = <T>(name: keyof typeof SLOT, args: FFIFunction["args"], returns: FFIFunction["returns"] = "ptr") =>
    call<T>(read.ptr(api, SLOT[name] * 8), args, returns);
  type Status = Pointer | null;
  type Release = (handle: Pointer) => void;
  const f = {
    GetErrorMessage: fn<(status: Pointer) => string>("GetErrorMessage", ["ptr"], "cstring"),
    ReleaseStatus: fn<Release>("ReleaseStatus", ["ptr"], "void"),
    CreateEnv: fn<(level: number, logId: Pointer, env: Pointer) => Status>("CreateEnv", ["i32", "ptr", "ptr"]),
    CreateSessionOptions: fn<(options: Pointer) => Status>("CreateSessionOptions", ["ptr"]),
    DisableCpuMemArena: fn<(options: Pointer) => Status>("DisableCpuMemArena", ["ptr"]),
    SetIntraOpNumThreads: fn<(options: Pointer, n: number) => Status>("SetIntraOpNumThreads", ["ptr", "i32"]),
    SetInterOpNumThreads: fn<(options: Pointer, n: number) => Status>("SetInterOpNumThreads", ["ptr", "i32"]),
    CreateSession: fn<(env: Pointer, path: Pointer, options: Pointer, session: Pointer) => Status>("CreateSession", [
      "ptr",
      "ptr",
      "ptr",
      "ptr",
    ]),
    CreateCpuMemoryInfo: fn<(allocator: number, memType: number, info: Pointer) => Status>("CreateCpuMemoryInfo", [
      "i32",
      "i32",
      "ptr",
    ]),
    CreateTensorWithDataAsOrtValue: fn<
      (
        info: Pointer,
        data: Pointer,
        bytes: number,
        shape: Pointer,
        dims: number,
        type: number,
        value: Pointer,
      ) => Status
    >("CreateTensorWithDataAsOrtValue", ["ptr", "ptr", "u64", "ptr", "u64", "i32", "ptr"]),
    Run: fn<
      (
        session: Pointer,
        runOptions: null,
        inputNames: Pointer,
        inputs: Pointer,
        inputCount: number,
        outputNames: Pointer,
        outputCount: number,
        outputs: Pointer,
      ) => Status
    >("Run", ["ptr", "ptr", "ptr", "ptr", "u64", "ptr", "u64", "ptr"]),
    GetTensorTypeAndShape: fn<(value: Pointer, info: Pointer) => Status>("GetTensorTypeAndShape", ["ptr", "ptr"]),
    GetTensorShapeElementCount: fn<(info: Pointer, count: Pointer) => Status>("GetTensorShapeElementCount", [
      "ptr",
      "ptr",
    ]),
    GetTensorMutableData: fn<(value: Pointer, data: Pointer) => Status>("GetTensorMutableData", ["ptr", "ptr"]),
    ReleaseEnv: fn<Release>("ReleaseEnv", ["ptr"], "void"),
    ReleaseMemoryInfo: fn<Release>("ReleaseMemoryInfo", ["ptr"], "void"),
    ReleaseSession: fn<Release>("ReleaseSession", ["ptr"], "void"),
    ReleaseValue: fn<Release>("ReleaseValue", ["ptr"], "void"),
    ReleaseTensorTypeAndShapeInfo: fn<Release>("ReleaseTensorTypeAndShapeInfo", ["ptr"], "void"),
    ReleaseSessionOptions: fn<Release>("ReleaseSessionOptions", ["ptr"], "void"),
  };

  /** Every status-returning call: null is success, anything else an error to read and free. */
  function check(status: Status, what: string): void {
    if (!status) {
      return;
    }
    const message = f.GetErrorMessage(status);
    f.ReleaseStatus(status);
    throw new OrtError(`${what}: ${message}`);
  }

  const slot = out();
  check(f.CreateEnv(LOG_ERROR, ptr(cstr("index-translator")), ptr(slot)), "CreateEnv");
  const env = pointerIn(slot);
  check(f.CreateCpuMemoryInfo(ARENA_ALLOCATOR, MEM_TYPE_DEFAULT, ptr(slot)), "CreateCpuMemoryInfo");
  const memory = pointerIn(slot);
  // The names `Run` reads, and the tables of pointers to them. One object holds both, and `run` uses
  // it, so the strings live as long as the pointers to them (a table alone would let them be collected).
  const names = (() => {
    const strings = [cstr("input_ids"), cstr("attention_mask"), cstr("logits")];
    const table = (of: Uint8Array[]) => BigUint64Array.from(of.map((s) => BigInt(ptr(s))));
    return { strings, inputs: table(strings.slice(0, 2)), outputs: table(strings.slice(2)) };
  })();

  /** An OrtValue over `data`, which must outlive it. */
  function tensor(data: BigInt64Array | Float32Array, type: number, dims: BigInt64Array): Pointer {
    const value = out();
    check(
      f.CreateTensorWithDataAsOrtValue(memory, ptr(data), data.byteLength, ptr(dims), dims.length, type, ptr(value)),
      "CreateTensorWithDataAsOrtValue",
    );
    return pointerIn(value);
  }

  return {
    version,
    open(modelPath, threads) {
      check(f.CreateSessionOptions(ptr(slot)), "CreateSessionOptions");
      const options = pointerIn(slot);
      let session: Pointer;
      try {
        check(f.SetIntraOpNumThreads(options, threads), "SetIntraOpNumThreads");
        // One graph, run one node at a time: no second pool beside the intra-op threads.
        check(f.SetInterOpNumThreads(options, 1), "SetInterOpNumThreads");
        // The arena keeps the largest batch's memory for good (a gigabyte); without it memory follows the work.
        check(f.DisableCpuMemArena(options), "DisableCpuMemArena");
        check(f.CreateSession(env, ptr(ortPath(modelPath)), options, ptr(slot)), "CreateSession");
        session = pointerIn(slot);
      } finally {
        f.ReleaseSessionOptions(options);
      }
      return {
        run(ids, mask, rows, width) {
          if (ids.length !== rows * width || mask.length !== rows * width) {
            throw new OrtError(`inputs of ${ids.length} and ${mask.length} values are not ${rows} × ${width}`);
          }
          const dims = BigInt64Array.of(BigInt(rows), BigInt(width));
          const inputs = [tensor(ids, INT64, dims), tensor(mask, FLOAT, dims)];
          const outputs = new BigUint64Array(1);
          try {
            check(
              f.Run(
                session,
                null,
                ptr(names.inputs),
                ptr(BigUint64Array.from(inputs.map(BigInt))),
                names.inputs.length,
                ptr(names.outputs),
                names.outputs.length,
                ptr(outputs),
              ),
              "Run",
            );
            const logits = pointerIn(outputs);
            try {
              check(f.GetTensorTypeAndShape(logits, ptr(slot)), "GetTensorTypeAndShape");
              const info = pointerIn(slot);
              const count = out();
              try {
                check(f.GetTensorShapeElementCount(info, ptr(count)), "GetTensorShapeElementCount");
              } finally {
                f.ReleaseTensorTypeAndShapeInfo(info);
              }
              // Read exactly what the library holds: a model with another output shape is an error, not a stray read.
              if (Number(count[0]) !== rows * width) {
                throw new OrtError(`the model answered ${count[0]} logits for ${rows * width} tokens`);
              }
              check(f.GetTensorMutableData(logits, ptr(slot)), "GetTensorMutableData");
              return new Float32Array(toArrayBuffer(pointerIn(slot), 0, rows * width * 4).slice(0));
            } finally {
              f.ReleaseValue(logits);
            }
          } finally {
            for (const value of inputs) {
              f.ReleaseValue(value);
            }
          }
        },
        close() {
          f.ReleaseSession(session);
        },
      };
    },
    close() {
      f.ReleaseMemoryInfo(memory);
      f.ReleaseEnv(env);
      lib.close();
    },
  };
}
