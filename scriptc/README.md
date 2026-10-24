# Modules compiled with scriptc

Some pure-logic modules of `src/` can be compiled from TypeScript to WebAssembly with
[scriptc](https://github.com/vercel-labs/scriptc) and run faster (the Ogg Opus muxer, 20000 packets one call each:
35 ms against 44 ms; every call copies its bytes in and out, so a coarser interface gains more). The
TypeScript stays the source of truth and is always there; the compiled module is an optimization that is used
only when it was built from the very files there are now.

| File                 | What it is                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `<name>.json`        | scriptc's library profile: the entry module, and the signature of each export            |
| `<name>.entry.ts`    | The entry: imports `src/<name>.ts` and exports functions that fit a profile (numbers, strings, bytes) |
| `<name>.adapter.ts`  | What `src/<name>.ts` is replaced by when its module is loaded: the same exports, over the entry's |

- `bun scripts/fetch_scriptc.ts` fetches scriptc, its wasm32-wasi runtime and Zig 0.16 into `vendor/scriptc/`
  (Linux on x86-64 only).
- `bun scripts/build_scriptc.ts [--force] [name...]` builds `vendor/scriptc/modules/<name>.wasm`, and
  `<name>.inputs.json` beside it: the SHA-256 of every file that the build read.
- `src/scriptc-plugin.ts`, preloaded by `bunfig.toml`, answers the import of `src/<name>.ts` with the adapter
  when `<name>.inputs.json` matches the files on disk, and with the TypeScript when the module is missing or stale.
  `SCRIPTC_WASM=0` always loads the TypeScript; `bun run test:coverage` sets it, as coverage is measured on the source.

A module has its own instance, so the modules it imports do not share variables with the same files loaded as
TypeScript: compile only modules without state that others share. An error that leaves a module ends its instance, so
the entry catches what the code throws and the adapter throws it again.

Adding a module: write the three files, `bun scripts/build_scriptc.ts <name>`, and make sure
`SCRIPTC_WASM=0 bun test` and `bun test` pass alike.
