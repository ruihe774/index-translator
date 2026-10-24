// A Bun plugin (preloaded by bunfig.toml) that loads a module of src/ as WebAssembly, when it was compiled
// from the TypeScript there is now. `import { OggOpusMuxer } from "./ogg-opus"` still names the
// .ts file; if scripts/build_scriptc.ts built `scriptc/ogg-opus.json` into a module and none of its
// inputs has changed since (scriptc-runtime.ts: `trackedInputs`), the import gets the adapter,
// scriptc/ogg-opus.adapter.ts, over that module. Otherwise Bun loads the TypeScript as it always did.
// SCRIPTC_WASM=0 in the environment keeps the TypeScript regardless (coverage is measured on it).
//
// The module is its own instance, so what it imports has its own variables, not the ones of the same
// files in the TypeScript: only modules without state shared with others are compiled.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { plugin } from "bun";

import { inputsPath, isStale, profilePath, ROOT, SOURCES } from "./scriptc-runtime";

const SRC = join(ROOT, "src");

const warned = new Set<string>();

plugin({
  name: "scriptc",
  setup(build) {
    if (process.env.SCRIPTC_WASM === "0") {
      return;
    }
    // A plugin must return the contents of every file it is asked for: the TypeScript's, unless there is a module.
    build.onLoad({ filter: /[\\/]src[\\/][^\\/]+\.ts$/ }, ({ path }) => {
      const name = basename(path, ".ts");
      if (dirname(path) === SRC && existsSync(profilePath(name)) && existsSync(inputsPath(name))) {
        const stale = isStale(name);
        if (stale.length === 0) {
          return { loader: "ts", contents: `export * from ${JSON.stringify(join(SOURCES, `${name}.adapter.ts`))};` };
        }
        if (!warned.has(name)) {
          warned.add(name);
          console.warn(`scriptc: ${name}.wasm is stale (${stale.join(", ")}); using the TypeScript`);
        }
      }
      return { loader: "ts", contents: readFileSync(path, "utf8") };
    });
  },
});
