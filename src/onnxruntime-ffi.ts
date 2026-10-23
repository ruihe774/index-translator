// ONNX Runtime's C API through bun:ffi: just what the segmentation worker needs to run its models on
// the CPU. Every call blocks its thread, so this module is only used from src/segment-worker.ts.
//
// The library exports one function, `OrtGetApiBase`; everything else is a function pointer in the
// `OrtApi` struct it hands out for an API version. The struct only grows, so a function's slot never
// changes; the slots below were counted from `include/onnxruntime_c_api.h` of the pinned release
// (scripts/fetch_onnxruntime.ts), and a new pin means counting them again. A wrong slot calls the
// wrong function, so the version string is checked at load as well.

import { CFunction, dlopen, type FFIFunction, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";

import { cstr, libraryFile, pointerOf, slot } from "./ffi-util";

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

class OrtError extends Error {}

/** The shared library inside `dir`: the SONAME link on Linux, the DLL on Windows (by full path: System32 has another). */
export const libraryPath = (dir: string) => libraryFile(dir, "onnxruntime", 1);

/** A path as `ORTCHAR_T*`: UTF-16 on Windows, UTF-8 elsewhere; NUL-terminated. */
function ortPath(path: string): Uint8Array {
  if (process.platform === "win32") {
    return new Uint8Array(Buffer.from(`${path}\0`, "utf16le"));
  }
  return new TextEncoder().encode(`${path}\0`);
}

/** An input tensor: int64 or float32, by its array's type. */
type Input = BigInt64Array | Float32Array;

export interface Session {
  /**
   * The output for `inputs`, each `rows × width` and in the order `open` named them: `perToken` floats
   * for every one of the `rows × width` positions.
   */
  run(inputs: Input[], rows: number, width: number, perToken: number): Float32Array;
  close(): void;
}

/** The names of a model's inputs, in the order `run` is given them, and of the one output it reads. */
interface Signature {
  inputs: string[];
  output: string;
}

export interface Runtime {
  readonly version: string;
  open(modelPath: string, threads: number, signature: Signature): Session;
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

  const scratch = slot();
  // The environment and the log id it was created with live together: whatever the library keeps of the
  // id must stay valid for as long as `env` is used (every session `open` creates names it).
  const logId = cstr("index-translator");
  check(f.CreateEnv(LOG_ERROR, ptr(logId), ptr(scratch)), "CreateEnv");
  const env = { handle: pointerOf(scratch), logId };
  check(f.CreateCpuMemoryInfo(ARENA_ALLOCATOR, MEM_TYPE_DEFAULT, ptr(scratch)), "CreateCpuMemoryInfo");
  const memory = pointerOf(scratch);

  /** An OrtValue over `data`, which must outlive it. */
  function tensor(data: Input, dims: BigInt64Array): Pointer {
    const value = slot();
    const type = data instanceof BigInt64Array ? INT64 : FLOAT;
    check(
      f.CreateTensorWithDataAsOrtValue(memory, ptr(data), data.byteLength, ptr(dims), dims.length, type, ptr(value)),
      "CreateTensorWithDataAsOrtValue",
    );
    return pointerOf(value);
  }

  /** The `size` floats of the output tensor `output`, copied; its element count must be exactly `size`. */
  function readOutput(output: Pointer, size: number, describe: string): Float32Array {
    check(f.GetTensorTypeAndShape(output, ptr(scratch)), "GetTensorTypeAndShape");
    const info = pointerOf(scratch);
    const count = slot();
    try {
      check(f.GetTensorShapeElementCount(info, ptr(count)), "GetTensorShapeElementCount");
    } finally {
      f.ReleaseTensorTypeAndShapeInfo(info);
    }
    // Read exactly what the library holds: a model with another output shape is an error, not a stray read.
    if (Number(count[0]) !== size) {
      throw new OrtError(`the model answered ${count[0]} values for ${describe}`);
    }
    check(f.GetTensorMutableData(output, ptr(scratch)), "GetTensorMutableData");
    return new Float32Array(toArrayBuffer(pointerOf(scratch), 0, size * 4).slice(0));
  }

  return {
    version,
    open(modelPath, threads, signature) {
      // The names `Run` reads, and the tables of pointers to them. One object holds both, and `run` uses
      // it, so the strings live as long as the pointers to them (a table alone would let them be collected).
      const names = (() => {
        const strings = [...signature.inputs, signature.output].map(cstr);
        const table = (of: Uint8Array[]) => BigUint64Array.from(of.map((s) => BigInt(ptr(s))));
        return { strings, inputs: table(strings.slice(0, -1)), outputs: table(strings.slice(-1)) };
      })();
      check(f.CreateSessionOptions(ptr(scratch)), "CreateSessionOptions");
      const options = pointerOf(scratch);
      let session: Pointer;
      try {
        check(f.SetIntraOpNumThreads(options, threads), "SetIntraOpNumThreads");
        // One graph, run one node at a time: no second pool beside the intra-op threads.
        check(f.SetInterOpNumThreads(options, 1), "SetInterOpNumThreads");
        // The arena keeps the largest batch's memory for good (a gigabyte); without it memory follows the work.
        check(f.DisableCpuMemArena(options), "DisableCpuMemArena");
        check(f.CreateSession(env.handle, ptr(ortPath(modelPath)), options, ptr(scratch)), "CreateSession");
        session = pointerOf(scratch);
      } finally {
        f.ReleaseSessionOptions(options);
      }
      return {
        run(data, rows, width, perToken) {
          if (data.length !== names.inputs.length || data.some((d) => d.length !== rows * width)) {
            throw new OrtError(
              `inputs of ${data.map((d) => d.length).join(", ")} values are not ${names.inputs.length} of ${rows} × ${width}`,
            );
          }
          const dims = BigInt64Array.of(BigInt(rows), BigInt(width));
          const size = rows * width * perToken;
          const inputs = data.map((d) => tensor(d, dims));
          const outputs = slot();
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
            const output = pointerOf(outputs);
            try {
              return readOutput(output, size, `${rows * width} tokens × ${perToken}`);
            } finally {
              f.ReleaseValue(output);
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
  };
}
