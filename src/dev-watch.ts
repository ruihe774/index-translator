// Development only: files that run in the engine worker or are loaded through bun:ffi are not in the
// server's import graph, so `bun --watch` would not restart for them. Importing them as text puts them
// in the graph without running them. Loaded by src/server.ts when DEV_RELOAD=1.

// TypeScript types these as modules; at runtime Bun hands back the file's text.
// @ts-expect-error
import ffi from "./llama-ffi.ts" with { type: "text" }; // eslint-disable-line import/default -- text import
// @ts-expect-error
import shim from "./llama-shim.c" with { type: "text" };
// @ts-expect-error
import worker from "./llama-worker.ts" with { type: "text" }; // eslint-disable-line import/default -- text import

export const watched: number[] = [worker.length, ffi.length, shim.length];
