// Fetch the libraries the web app runs in the browser, into public/vendor/: for PDF support,
// pdf-inspector's WebAssembly build (page text as Markdown) and pdf.js (page thumbnails), both npm
// packages downloaded from the registry by version and checksum, of which only the files the page
// loads are unpacked, plus the licenses; and the QOA codec of the speech stream, three files of a
// git commit. Nothing is installed with a package manager, and the page never loads them from the
// network: the server serves public/vendor/ like the rest of public/. Without the PDF libraries
// opening a PDF is refused with a message; without the codec speech arrives as WAV.
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
      if (path === "LICENSE") {
        return path;
      }
      const build = /^legacy\/build\/(pdf(?:\.worker)?\.min\.mjs)$/.exec(path);
      if (build) {
        return build[1];
      }
      if (/^(cmaps|standard_fonts|iccs)\/[^/]+$/.test(path)) {
        return path;
      }
      if (/^wasm\/[^/]+$/.test(path) && !path.startsWith("wasm/quickjs")) {
        return path;
      }
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

/** A library that is a few files of a git commit, downloaded one by one (a commit's raw files never change; its archive's bytes may). */
interface FileLibrary {
  /** Directory under public/vendor/. */
  dir: string;
  /** The commit; every URL names it. */
  version: string;
  files: {
    /** Where the file goes, relative to `dir`. */
    to: string;
    url: string;
    sha256: string;
  }[];
}

const QOA_COMMIT = "b35f802c62759e4c30594a609cc98377a8c014e3";
const QOA_RAW = `https://raw.githubusercontent.com/ruihe774/index-translator/${QOA_COMMIT}`;

/**
 * qoa-wasm (the `qoa` branch of this project's repository): the QOA audio codec the speech stream
 * uses, with its WebAssembly embedded in qoa_wasm.ts as base64 (dist/ is not needed). Its modules
 * import each other as `.ts`, which the server answers as JavaScript, so the files are used as they are.
 */
export const FILE_LIBRARIES: FileLibrary[] = [
  {
    dir: "qoa",
    version: QOA_COMMIT,
    files: [
      {
        to: "qoa.ts",
        url: `${QOA_RAW}/src/qoa.ts`,
        sha256: "43ca450102618e760b3bc4e12dbf00e22ed75c297c97496360b3530fd7c45489",
      },
      {
        to: "qoa_wasm.ts",
        url: `${QOA_RAW}/src/qoa_wasm.ts`,
        sha256: "7cec47e5115753214b88e966004ea9a1666fec654351129e3e66d9f8080211b3",
      },
      {
        to: "LICENSE",
        url: `${QOA_RAW}/LICENSE`,
        sha256: "6b0382b16279f26ff69014300541967a356a666eb0b91b422f6862f6b7dad17e",
      },
    ],
  },
];

/** Marks a directory as holding the whole of a pinned library; written last. */
const STAMP = "VERSION";

/** What the stamp of a library says: its version and the checksums of what was downloaded. */
const stampOf = (lib: Library | FileLibrary) =>
  `${lib.version} ${"files" in lib ? lib.files.map((f) => f.sha256).join(" ") : lib.sha256}\n`;

/**
 * The regular files of a gzipped tar archive (ustar, as npm packs it), by their path below the
 * archive's one top-level directory. Anything but files and directories is refused.
 */
export function untar(tgz: Uint8Array): Map<string, Uint8Array> {
  const tar = Bun.gunzipSync(tgz as Uint8Array<ArrayBuffer>);
  const text = new TextDecoder();
  const field = (at: number, length: number) => text.decode(tar.subarray(at, at + length)).split("\0")[0]!;
  const files = new Map<string, Uint8Array>();
  for (let at = 0; at + 512 <= tar.length;) {
    const name = field(at, 100);
    if (name === "") {
      break;
    } // the end marker: empty blocks
    const size = Number.parseInt(field(at + 124, 12).trim(), 8);
    const type = field(at + 156, 1);
    const prefix = field(at + 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (Number.isNaN(size)) {
      throw new TypeError(`unreadable size for ${path}`);
    }
    if (type === "0" || type === "") {
      const inside = path.slice(path.indexOf("/") + 1);
      if (inside.split("/").some((part) => part === ".." || part === "")) {
        throw new Error(`refusing path ${path}`);
      }
      files.set(inside, tar.subarray(at + 512, at + 512 + size));
    } else if (type !== "5") {
      throw new Error(`unexpected entry type "${type}" for ${path}`);
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function isPresent(lib: Library | FileLibrary, vendor: string): Promise<boolean> {
  const present = Bun.file(join(vendor, lib.dir, STAMP));
  return (await present.exists()) && (await present.text()) === stampOf(lib);
}

async function fetchFileLibrary(lib: FileLibrary, vendor: string): Promise<void> {
  const dir = join(vendor, lib.dir);
  if (await isPresent(lib, vendor)) {
    console.log(`ok ${lib.dir} ${lib.version.slice(0, 7)} (already there)`);
    return;
  }
  // Everything is downloaded and checked before the directory is touched.
  const texts = await Promise.all(
    lib.files.map(async (f) => new TextDecoder().decode(await download(f.url, f.sha256))),
  );
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let bytes = 0;
  for (const [i, f] of lib.files.entries()) {
    await Bun.write(join(dir, f.to), texts[i]!);
    bytes += texts[i]!.length;
  }
  await Bun.write(join(dir, STAMP), stampOf(lib));
  console.log(`ok ${lib.dir} ${lib.version.slice(0, 7)} (${lib.files.length} files, ${(bytes / 1024).toFixed(0)} KiB)`);
}

async function fetchLibrary(lib: Library, vendor: string): Promise<void> {
  const dir = join(vendor, lib.dir);
  if (await isPresent(lib, vendor)) {
    console.log(`ok ${lib.dir} ${lib.version} (already there)`);
    return;
  }
  const stamp = stampOf(lib);
  const files = untar(await download(lib.url, lib.sha256));
  await rm(dir, { recursive: true, force: true });
  let count = 0;
  let bytes = 0;
  const written = new Set<string>();
  for (const [path, data] of files) {
    const to = lib.place(path);
    if (to === undefined) {
      continue;
    }
    await mkdir(dirname(join(dir, to)), { recursive: true });
    await Bun.write(join(dir, to), data);
    written.add(to);
    count++;
    bytes += data.length;
  }
  const missing = lib.expect.filter((path) => !written.has(path));
  if (missing.length > 0) {
    throw new Error(`${lib.url} has no ${missing.join(", ")}`);
  }
  await Bun.write(join(dir, STAMP), stamp);
  console.log(`ok ${lib.dir} ${lib.version} (${count} files, ${(bytes / 2 ** 20).toFixed(1)} MiB)`);
}

/** Throws, naming this script, unless every library is in `vendor` at its pinned version. */
export async function requireWebLibs(vendor: string): Promise<void> {
  for (const lib of [...LIBRARIES, ...FILE_LIBRARIES]) {
    if (!(await isPresent(lib, vendor))) {
      throw new Error(`${join(vendor, lib.dir)} is missing or not ${lib.version}; run: bun scripts/fetch_web_libs.ts`);
    }
  }
}

if (import.meta.main) {
  if (Bun.argv.length > 2) {
    throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
  }
  const vendor = resolve(import.meta.dir, "..", "public", "vendor");
  for (const lib of LIBRARIES) {
    await fetchLibrary(lib, vendor);
  }
  for (const lib of FILE_LIBRARIES) {
    await fetchFileLibrary(lib, vendor);
  }
}
