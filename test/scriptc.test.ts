// The modules compiled to WebAssembly (scriptc/README.md). The others of the suite run on them when they are
// built and match their sources; this says that they are, where CI built them and sets SCRIPTC_EXPECT_WASM.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import { OggOpusMuxer } from "../src/ogg-opus";
import { isStale, loaded, SOURCES, trackedInputs } from "../src/scriptc-runtime";

const names = readdirSync(SOURCES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length));

describe("the compiled modules", () => {
  test.skipIf(!process.env.SCRIPTC_EXPECT_WASM)("are loaded in place of their TypeScript", () => {
    expect(names).toContain("ogg-opus");
    for (const name of names) {
      expect(isStale(name)).toStrictEqual([]);
    }
    expect(new OggOpusMuxer({ channels: 1, sampleRate: 48_000, preSkip: 0 }).header().length).toBeGreaterThan(0);
    expect([...loaded].toSorted()).toStrictEqual(names.toSorted());
  });

  test.each(names)("%s tracks the files that it was built from, when it is built", (name) => {
    const inputs = trackedInputs(name);
    if (inputs) {
      expect(Object.keys(inputs.files)).toContain(`scriptc/${name}.json`);
      expect(Object.keys(inputs.files)).toContain(`src/${name}.ts`);
      expect(Object.values(inputs.files).every((sha256) => /^[0-9a-f]{64}$/.test(sha256))).toBe(true);
    }
  });
});
