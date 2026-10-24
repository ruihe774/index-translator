// Loads the TypeScript modules that scripts/build_scriptc.ts compiled to WebAssembly (scriptc, see
// scriptc/README.md), and says whether such a module still matches the sources it was built from.
// A module is a WASI reactor: its exports take numbers, and a string or bytes as a pointer and a length
// in its memory. `instantiate` hides that, so the exports of the profile are plain functions.

import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { WASI } from "node:wasi";

/** The repository's root. The paths of tracked inputs are relative to it, with `/`. */
export const ROOT = resolve(import.meta.dir, "..");

/** Where the entry modules and the profiles are (`<name>.entry.ts`, `<name>.json`, `<name>.adapter.ts`). */
export const SOURCES = join(ROOT, "scriptc");

/** Where the built modules are (`<name>.wasm`); not in the repository. */
export const MODULES = join(ROOT, "vendor", "scriptc", "modules");

type Scalar = "f64" | "bool" | "u8" | "u32" | "i32" | "i64" | "u64";
type Buffer = "string" | "bytes";

/** The part of scriptc's library profile that the loader reads. */
export interface Profile {
  name: string;
  entry: string;
  abi: { init_symbol: string };
  exports: { export: string; symbol: string; params: (Scalar | Buffer)[]; returns: Scalar | Buffer | "void" }[];
}

/** What a module was built from, kept beside it in `<name>.inputs.json`. */
export interface Inputs {
  compiler: string;
  target: string;
  /** SHA-256 of every file that the build read, by its path from `ROOT`. */
  files: Record<string, string>;
}

export type Exports = Record<string, (...args: never[]) => unknown>;

export const profilePath = (name: string) => join(SOURCES, `${name}.json`);
export const modulePath = (name: string) => join(MODULES, `${name}.wasm`);
export const inputsPath = (name: string) => join(MODULES, `${name}.inputs.json`);

export function readProfile(name: string): Profile {
  return JSON.parse(readFileSync(profilePath(name), "utf8")) as Profile;
}

/** The path of `file` as tracked: from `ROOT`, with `/` on every platform. */
export function trackedPath(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

export function sha256File(file: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
}

/** The inputs recorded for the compiled module `name`, or undefined when it or its record is missing or unreadable. */
export function trackedInputs(name: string): Inputs | undefined {
  try {
    readFileSync(modulePath(name)); // a record without its module is of no use
    return JSON.parse(readFileSync(inputsPath(name), "utf8")) as Inputs;
  } catch {
    return undefined;
  }
}

/** The tracked files that differ from what the module was built from: changed, or no longer there. */
export function staleInputs(inputs: Inputs): string[] {
  return Object.entries(inputs.files)
    .filter(([path, sha256]) => {
      try {
        return sha256File(join(ROOT, path)) !== sha256;
      } catch {
        return true;
      }
    })
    .map(([path]) => path);
}

/** Why the module `name` cannot be used: the tracked files that changed since it was built, or that it has no record. */
export function isStale(name: string): string[] {
  const inputs = trackedInputs(name);
  return inputs ? staleInputs(inputs) : [`${trackedPath(inputsPath(name))} (missing)`];
}

/** The export that a WASI reactor is initialized by. */
const REACTOR_INITIALIZE = "_initialize";

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

/** The modules loaded so far, for a test to tell that it ran on them. */
export const loaded = new Set<string>();

/** Loads `<MODULES>/<name>.wasm`, which is built for `<SOURCES>/<name>.json`. */
export async function load(name: string): Promise<Exports> {
  loaded.add(name);
  return instantiate(readFileSync(modulePath(name)), readProfile(name));
}

/** Instantiates a module and returns one function for each export of its profile. */
export async function instantiate(wasm: Uint8Array, profile: Profile): Promise<Exports> {
  const wasi = new WASI({ version: "preview1" });
  const bound: { memory?: WebAssembly.Memory } = {};
  const { instance } = await WebAssembly.instantiate(wasm, {
    wasi_snapshot_preview1: wasi.wasiImport,
    scriptc: {
      panic(ptr: number, length: number) {
        throw new Error(`scriptc panic: ${utf8d.decode(new Uint8Array(bound.memory!.buffer, ptr, length))}`);
      },
    },
  });
  const ex = instance.exports as Record<string, (...args: number[]) => number> & {
    memory: WebAssembly.Memory;
    scriptc_alloc(size: number): number;
    scriptc_free(ptr: number): void;
  };
  const { memory } = ex;
  bound.memory = memory;
  // Bun's WASI has no initialize(), unlike Node's: bind the memory and run the reactor's initializer by hand.
  (wasi as unknown as { setMemory(memory: WebAssembly.Memory): void }).setMemory(memory);
  ex[REACTOR_INITIALIZE]!();
  ex[profile.abi.init_symbol]!();

  const api: Exports = {};
  for (const e of profile.exports) {
    const fn = ex[e.symbol]!;
    const buffered = e.returns === "bytes" || e.returns === "string";
    api[e.export] = (...args: unknown[]) => {
      const allocs: number[] = [];
      const flat: unknown[] = [];
      try {
        args.forEach((arg, i) => {
          const type = e.params[i];
          if (type === "bytes" || type === "string") {
            const data = type === "string" ? utf8.encode(arg as string) : (arg as Uint8Array);
            const ptr = ex.scriptc_alloc(Math.max(data.length, 1));
            allocs.push(ptr);
            new Uint8Array(memory.buffer).set(data, ptr);
            flat.push(ptr, data.length);
          } else {
            flat.push(type === "bool" ? Number(arg) : arg);
          }
        });
        // A string or bytes result comes through two slots that the caller provides: its pointer and its length.
        let slots = 0;
        if (buffered) {
          slots = ex.scriptc_alloc(8);
          allocs.push(slots);
          flat.push(slots, slots + 4);
        }
        const result = (fn as (...a: unknown[]) => unknown)(...flat);
        if (!buffered) {
          return e.returns === "bool" ? result !== 0 : e.returns === "void" ? undefined : result;
        }
        const view = new DataView(memory.buffer);
        const out = new Uint8Array(memory.buffer, view.getUint32(slots, true), view.getUint32(slots + 4, true));
        // The result is in the module's arena, which the next call resets: copy it out.
        return e.returns === "string" ? utf8d.decode(out) : out.slice();
      } finally {
        for (const ptr of allocs) {
          ex.scriptc_free(ptr);
        }
      }
    };
  }
  return api;
}
