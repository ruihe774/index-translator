// scripts/fetch_web_libs.ts without the network: the archive reader, and which files of each
// package are kept.

import { describe, expect, test } from "bun:test";

import { FILE_LIBRARIES, LIBRARIES, untar } from "../scripts/fetch_web_libs";

/** A ustar archive, gzipped, as npm packs one: a 512-byte header and the padded content per entry. */
function tgz(entries: { name: string; prefix?: string; type?: string; content?: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const content = encoder.encode(e.content ?? "");
    const header = new Uint8Array(512);
    header.set(encoder.encode(e.name), 0);
    header.set(encoder.encode(`${content.length.toString(8).padStart(11, "0")}\0`), 124);
    header.set(encoder.encode(e.type ?? "0"), 156);
    header.set(encoder.encode("ustar"), 257);
    header.set(encoder.encode(e.prefix ?? ""), 345);
    const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
    padded.set(content);
    blocks.push(header, padded);
  }
  blocks.push(new Uint8Array(1024));
  return Bun.gzipSync(Buffer.concat(blocks));
}

const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);

describe("untar", () => {
  test("gives the files by their path below the top-level directory", () => {
    const files = untar(
      tgz([
        { name: "package/", type: "5" },
        { name: "package/LICENSE", content: "MIT" },
        { name: "package/build/pdf.mjs", content: "x".repeat(700) },
        { name: "worker.mjs", prefix: "package/legacy/build", content: "w" },
        { name: "package/empty" },
      ]),
    );
    expect([...files.keys()]).toStrictEqual(["LICENSE", "build/pdf.mjs", "legacy/build/worker.mjs", "empty"]);
    expect(text(files.get("LICENSE"))).toBe("MIT");
    expect(files.get("build/pdf.mjs")).toHaveLength(700);
    expect(text(files.get("legacy/build/worker.mjs"))).toBe("w");
    expect(files.get("empty")).toHaveLength(0);
  });

  test("refuses paths that leave the directory and entries that are not files", () => {
    expect(() => untar(tgz([{ name: "package/../../etc/passwd", content: "x" }]))).toThrow("refusing path");
    expect(() => untar(tgz([{ name: "package/link", type: "2" }]))).toThrow("unexpected entry type");
  });
});

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
  const qoa = FILE_LIBRARIES.find((l) => l.dir === "qoa")!;

  test("every file is pinned to the commit by checksum, and the license is among them", () => {
    expect(qoa.version).toMatch(/^[0-9a-f]{40}$/);
    for (const file of qoa.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.url).toContain(`/${qoa.version}/`);
    }
    expect(qoa.files.map((f) => f.to)).toStrictEqual(["qoa.ts", "qoa_wasm.ts", "LICENSE"]);
  });
});
