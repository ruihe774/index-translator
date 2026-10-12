// Fetch the two libraries the web app's PDF support runs in the browser, into public/vendor/:
// pdf-inspector's WebAssembly build (page text as Markdown) and pdf.js (page thumbnails). Both are
// npm packages, downloaded from the registry by version and checksum; only the files the page
// loads are unpacked, plus the licenses. Nothing is installed with a package manager, and the
// page never loads them from the network: the server serves public/vendor/ like the rest of
// public/. Without them the app works and opening a PDF is refused with a message.
// Usage: bun scripts/fetch_web_libs.ts
//
// A library whose directory already holds the pinned version is left alone. Needs nothing besides Bun.

import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { download } from "./build_tools";

interface Library {
  /** Directory under public/vendor/. */
  dir: string;
  version: string;
  url: string;
  sha256: string;
  /** Where a file of the package goes, relative to `dir`; undefined leaves it out. */
  place: (path: string) => string | undefined;
  /** Files that must have come out, so a package whose layout changed fails here and not in the browser. */
  expect: string[];
}

export const LIBRARIES: Library[] = [
  {
    dir: "pdf-inspector",
    version: "1.25.2",
    url: "https://registry.npmjs.org/@firecrawl/pdf-inspector-wasm/-/pdf-inspector-wasm-1.25.2.tgz",
    sha256: "6b5b2306e933df497b3552f82651fd2ded2e03f9bb6b6e768102fd1074b00bc2",
    place: (path) =>
      ["pdf_inspector_wasm.js", "pdf_inspector_wasm_bg.wasm", "LICENSE"].includes(path) ? path : undefined,
    expect: ["pdf_inspector_wasm.js", "pdf_inspector_wasm_bg.wasm", "LICENSE"],
  },
  {
    dir: "pdfjs",
    version: "6.4.299",
    url: "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz",
    sha256: "86269b40170eb41740ea05ad2102d71d33de4f122b34eb2f478be0ea7779c415",
    // The legacy build: the other one is written for browsers newer than some in .browserslistrc.
    // cmaps/ and standard_fonts/ are what a PDF may leave out and name instead; wasm/ holds the
    // JPEG 2000, JBIG2 and colour decoders (not the scripting sandbox, which thumbnails never run).
    place: (path) => {
      if (path === "LICENSE") return path;
      const build = /^legacy\/build\/(pdf(?:\.worker)?\.min\.mjs)$/.exec(path);
      if (build) return build[1];
      if (/^(cmaps|standard_fonts|iccs)\/[^/]+$/.test(path)) return path;
      if (/^wasm\/[^/]+$/.test(path) && !path.startsWith("wasm/quickjs")) return path;
      return undefined;
    },
    expect: [
      "pdf.min.mjs",
      "pdf.worker.min.mjs",
      "LICENSE",
      "cmaps/LICENSE",
      "cmaps/UniGB-UCS2-H.bcmap",
      "standard_fonts/LICENSE_FOXIT",
      "standard_fonts/LICENSE_LIBERATION",
      "wasm/openjpeg.wasm",
      "wasm/jbig2.wasm",
      "wasm/qcms_bg.wasm",
      "iccs/CGATS001Compat-v2-micro.icc",
    ],
  },
];

/** Marks a directory as holding the whole of a pinned library; written last. */
const STAMP = "VERSION";

/**
 * The regular files of a gzipped tar archive (ustar, as npm packs it), by their path below the
 * archive's one top-level directory. Anything but files and directories is refused.
 */
export function untar(tgz: Uint8Array): Map<string, Uint8Array> {
  const tar = Bun.gunzipSync(tgz as Uint8Array<ArrayBuffer>);
  const text = new TextDecoder();
  const field = (at: number, length: number) => text.decode(tar.subarray(at, at + length)).split("\0")[0]!;
  const files = new Map<string, Uint8Array>();
  for (let at = 0; at + 512 <= tar.length; ) {
    const name = field(at, 100);
    if (name === "") break; // the end marker: empty blocks
    const size = Number.parseInt(field(at + 124, 12).trim(), 8);
    const type = field(at + 156, 1);
    const prefix = field(at + 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (Number.isNaN(size)) throw new Error(`unreadable size for ${path}`);
    if (type === "0" || type === "") {
      const inside = path.slice(path.indexOf("/") + 1);
      if (inside.split("/").some((part) => part === ".." || part === "")) throw new Error(`refusing path ${path}`);
      files.set(inside, tar.subarray(at + 512, at + 512 + size));
    } else if (type !== "5") {
      throw new Error(`unexpected entry type "${type}" for ${path}`);
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function fetchLibrary(lib: Library, vendor: string): Promise<void> {
  const dir = join(vendor, lib.dir);
  const stamp = `${lib.version} ${lib.sha256}\n`;
  const present = Bun.file(join(dir, STAMP));
  if ((await present.exists()) && (await present.text()) === stamp) {
    console.log(`ok ${lib.dir} ${lib.version} (already there)`);
    return;
  }
  const files = untar(await download(lib.url, lib.sha256));
  await rm(dir, { recursive: true, force: true });
  let count = 0;
  let bytes = 0;
  const written = new Set<string>();
  for (const [path, data] of files) {
    const to = lib.place(path);
    if (to === undefined) continue;
    await mkdir(dirname(join(dir, to)), { recursive: true });
    await Bun.write(join(dir, to), data);
    written.add(to);
    count++;
    bytes += data.length;
  }
  const missing = lib.expect.filter((path) => !written.has(path));
  if (missing.length > 0) throw new Error(`${lib.url} has no ${missing.join(", ")}`);
  await Bun.write(join(dir, STAMP), stamp);
  console.log(`ok ${lib.dir} ${lib.version} (${count} files, ${(bytes / 2 ** 20).toFixed(1)} MiB)`);
}

/** Throws, naming this script, unless every library is in `vendor` at its pinned version. */
export async function requireWebLibs(vendor: string): Promise<void> {
  for (const lib of LIBRARIES) {
    const stamp = Bun.file(join(vendor, lib.dir, STAMP));
    if (!(await stamp.exists()) || (await stamp.text()) !== `${lib.version} ${lib.sha256}\n`) {
      throw new Error(`${join(vendor, lib.dir)} is missing or not ${lib.version}; run: bun scripts/fetch_web_libs.ts`);
    }
  }
}

if (import.meta.main) {
  if (Bun.argv.length > 2) throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
  const vendor = resolve(import.meta.dir, "..", "public", "vendor");
  for (const lib of LIBRARIES) await fetchLibrary(lib, vendor);
}
