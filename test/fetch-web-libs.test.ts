// scripts/fetch_web_libs.ts without the network: which files of each
// package are kept.

import { describe, expect, test } from "bun:test";

import { FILE_LIBRARIES, LIBRARIES } from "../scripts/fetch_web_libs";

describe("the pinned libraries", () => {
  const lib = (dir: string) => LIBRARIES.find((l) => l.dir === dir)!;

  test("pdf.js: the legacy build, the data a PDF may refer to, no sandbox, no sources", () => {
    const { place } = lib("pdfjs");
    expect(place("legacy/build/pdf.min.mjs")).toBe("pdf.min.mjs");
    expect(place("legacy/build/pdf.worker.min.mjs")).toBe("pdf.worker.min.mjs");
    expect(place("cmaps/UniJIS-UCS2-H.bcmap")).toBe("cmaps/UniJIS-UCS2-H.bcmap");
    expect(place("wasm/openjpeg.wasm")).toBe("wasm/openjpeg.wasm");
    expect(place("wasm/LICENSE_OPENJPEG")).toBe("wasm/LICENSE_OPENJPEG");
    for (const left of [
      "build/pdf.min.mjs",
      "legacy/build/pdf.mjs",
      "legacy/build/pdf.mjs.map",
      "legacy/build/pdf.sandbox.min.mjs",
      "wasm/quickjs-eval.wasm",
      "web/pdf_viewer.mjs",
      "package.json",
    ]) {
      expect(place(left)).toBeUndefined();
    }
  });

  test("every file a library is expected to give is one it places, and the pins are whole", () => {
    for (const l of LIBRARIES) {
      expect(l.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(l.url).toContain(l.version);
      expect(l.expect).toContain("LICENSE");
    }
    expect(lib("pdf-inspector").place("pdf_inspector_wasm_bg.wasm")).toBe("pdf_inspector_wasm_bg.wasm");
    expect(lib("pdf-inspector").place("pdf_inspector_wasm.d.ts")).toBeUndefined();
  });
});

describe("the pinned files of a commit", () => {
  const files = (dir: string) => FILE_LIBRARIES.find((l) => l.dir === dir)!.files.map((f) => f.to);

  test("every file is pinned to the commit by checksum, and the license is among them", () => {
    for (const lib of FILE_LIBRARIES) {
      expect(lib.version).toMatch(/^[0-9a-f]{40}$/);
      for (const file of lib.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.url).toContain(`/${lib.version}/`);
      }
      expect(lib.files.map((f) => f.to)).toContain("LICENSE");
    }
    expect(files("qoa")).toStrictEqual(["src/qoa.ts", "dist/qoa.wasm", "dist/qoa-simd.wasm", "LICENSE"]);
    expect(files("undoc")).toStrictEqual([
      "undoc_wasm.js",
      "undoc_wasm_bg.wasm",
      "snippets/undoc-wasm-0162723ffca917e4/inline0.js",
      "LICENSE",
    ]);
  });
});
