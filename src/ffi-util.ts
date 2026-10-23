// Small pieces every bun:ffi binding in src/ shares: C strings, library file names, out-slots for
// pointers, and opening a library once per process.

import { type Pointer, suffix } from "bun:ffi";
import { join } from "node:path";

/** `s` as a NUL-terminated UTF-8 C string. The caller keeps it referenced for as long as C may read it. */
export const cstr = (s: string) => new TextEncoder().encode(`${s}\0`);

/**
 * The file name of the shared library `name`: `lib<name>.so` (or the platform's suffix) and `<name>.dll` on
 * Windows. `soVersion` is the SONAME's version that follows the suffix on Linux (`libsoxr.so.0`), ignored on Windows.
 */
export const libName = (name: string, soVersion?: number) =>
  process.platform === "win32"
    ? `${name}.${suffix}`
    : `lib${name}.${suffix}${soVersion === undefined ? "" : `.${soVersion}`}`;

/** The path of library `name` inside `dir`. */
export const libraryFile = (dir: string, name: string, soVersion?: number) => join(dir, libName(name, soVersion));

/** An out parameter for one pointer a library writes (`T **`). */
export const slot = () => new BigUint64Array(1);

/**
 * The pointer a call wrote to `out`. bun:ffi's `Pointer` is a JavaScript number, exact up to 2^53, and user-space
 * addresses are at most 57 bits on x86-64 with five-level paging and 48 bits on aarch64 or Windows, so in practice
 * they fit; an address that does not is an error, never a rounded pointer.
 */
export function pointerOf(out: BigUint64Array): Pointer {
  const value = out[0]!;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`the library returned an address (${value.toString(16)}) that a JavaScript number cannot hold`);
  }
  return Number(value) as Pointer;
}

/**
 * Opens a library once per process: `open(dir)` binds it with `bind(dir)` on the first call and answers the same
 * bindings afterwards. A second directory is an error (the loader would hand out the first library again), and
 * `loaded` is what is open now, if anything.
 */
export function once<L>(what: string, bind: (dir: string) => L) {
  let lib: L | undefined;
  let libDir = "";
  return {
    open(dir: string): L {
      if (lib && libDir !== dir) {
        throw new Error(`${what} is already loaded from ${libDir}`);
      }
      lib ??= bind(dir);
      libDir = dir;
      return lib;
    },
    get loaded(): L | undefined {
      return lib;
    },
  };
}
