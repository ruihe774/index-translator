// Fetch the libraries the web app runs in the browser, into public/vendor/: for PDF support, pdf.js
// (page thumbnails), an npm package downloaded from the registry by version and checksum, of which
// only the files the page loads are unpacked, plus the license; and, each a few files of a git commit,
// pdf-inspector's WebAssembly build (page text as Markdown), undoc's (a Word document's text as
// Markdown) and the QOA codec of the speech stream. Nothing is
// installed with a package manager, and the page never loads them from the network: the server
// serves public/vendor/ like the rest of public/. Without the PDF libraries or undoc opening a PDF
// or a Word document is refused with a message; without the codec speech arrives as WAV.
// Usage: bun scripts/fetch_web_libs.ts
//
// A library whose directory already holds the pinned version is left alone. Needs nothing besides Bun.

import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { download, readStamp, untar, writeStamp } from "./fetch_tools";

export interface Library {
  /** Directory under public/vendor/ (vendor/ for the server's own, scripts/fetch_turndown.ts). */
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
    dir: "pdfjs",
    version: "6.4.299",
    url: "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz",
    sha256: "86269b40170eb41740ea05ad2102d71d33de4f122b34eb2f478be0ea7779c415",
    // The legacy build: the other one is written for browsers newer than some in .browserslistrc.
    // cmaps/ and standard_fonts/ are what a PDF may leave out and name instead; wasm/ holds the
    // JPEG 2000, JBIG2 and colour decoders (not the scripting sandbox, which thumbnails never run).
    // Of the standard fonts only Symbol and ZapfDingbats: pdf.js never substitutes a system font
    // for those two, while Courier, Times and Helvetica fall back to the system's.
    place: (path) => {
      if (path === "LICENSE") {
        return path;
      }
      const build = /^legacy\/build\/(pdf(?:\.worker)?\.min\.mjs)$/.exec(path);
      if (build) {
        return build[1];
      }
      if (/^(cmaps|iccs)\/[^/]+$/.test(path)) {
        return path;
      }
      if (/^standard_fonts\/(FoxitSymbol\.pfb|FoxitDingbats\.pfb|LICENSE_FOXIT)$/.test(path)) {
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
      "standard_fonts/FoxitSymbol.pfb",
      "standard_fonts/FoxitDingbats.pfb",
      "wasm/openjpeg.wasm",
      "wasm/jbig2.wasm",
      "wasm/qcms_bg.wasm",
      "iccs/CGATS001Compat-v2-micro.icc",
    ],
  },
];

/** A library that is a few files of a git commit, downloaded one by one (a commit's raw files never change; its archive's bytes may). */
export interface FileLibrary {
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

const QOA_COMMIT = "3c85bd84595d56cb13bef779add463246e0908b7";
const QOA_RAW = `https://raw.githubusercontent.com/ruihe774/index-translator/${QOA_COMMIT}`;
const UNDOC_COMMIT = "bfe9907f3c9f32020e8502e93ae3f72bdf1fc0e9";
const UNDOC_RAW = `https://raw.githubusercontent.com/ruihe774/index-translator/${UNDOC_COMMIT}`;
const PDF_INSPECTOR_COMMIT = "832ad1f7b1fd80514aa12a91693c6e0c0a110fb2";
const PDF_INSPECTOR_RAW = `https://raw.githubusercontent.com/ruihe774/index-translator/${PDF_INSPECTOR_COMMIT}`;

/** Libraries kept as files on branches of this project's repository, each pinned by commit. */
export const FILE_LIBRARIES: FileLibrary[] = [
  /**
   * pdf-inspector-wasm (the `pdf-inspector` branch: wasm-pack's output for ruihe774/pdf-inspector's
   * `perf/wasm-opt-level-2`, upstream 1.25.2 plus `PdfDocument`, which parses a file once): a PDF
   * page's text as Markdown. Back to the npm package once upstream has both changes.
   */
  {
    dir: "pdf-inspector",
    version: PDF_INSPECTOR_COMMIT,
    files: [
      {
        to: "pdf_inspector_wasm.js",
        url: `${PDF_INSPECTOR_RAW}/pdf_inspector_wasm.js`,
        sha256: "3e492838887fb09048de134c21528f94fda01b638518bb6c007b2733f796ba0e",
      },
      {
        to: "pdf_inspector_wasm_bg.wasm",
        url: `${PDF_INSPECTOR_RAW}/pdf_inspector_wasm_bg.wasm`,
        sha256: "6c51f5cc4dc777eecce727fcbe38b406b1a7d28affa0cb634e2123671ec17efc",
      },
      {
        to: "LICENSE",
        url: `${PDF_INSPECTOR_RAW}/LICENSE`,
        sha256: "d31b40739ab8c626c561c6aa2900deb2af74e40d6b4522373d3e340417df4331",
      },
    ],
  },
  /**
   * qoa-wasm (the `qoa` branch): the QOA audio codec the speech stream uses. src/qoa.ts fetches its two
   * WebAssembly builds from `../dist/` relative to itself, so the files keep the repository's layout.
   * The server answers `.ts` as JavaScript, so they are used as they are.
   */
  {
    dir: "qoa",
    version: QOA_COMMIT,
    files: [
      {
        to: "src/qoa.ts",
        url: `${QOA_RAW}/src/qoa.ts`,
        sha256: "c0a681fb533b2426bfaf2fd5fbba50efa10d11bc2cf68c36330bdc98be40308d",
      },
      {
        to: "dist/qoa.wasm",
        url: `${QOA_RAW}/dist/qoa.wasm`,
        sha256: "02fae25eecaa72631bf4557f275d09ea9b7dafc289ea83fefd0884a3200f4cc9",
      },
      {
        to: "dist/qoa-simd.wasm",
        url: `${QOA_RAW}/dist/qoa-simd.wasm`,
        sha256: "98f669d58a70b7d93642e6e979257f781f43fc4cccf6d060506dcb1a219adc4e",
      },
      {
        to: "LICENSE",
        url: `${QOA_RAW}/LICENSE`,
        sha256: "6b0382b16279f26ff69014300541967a356a666eb0b91b422f6862f6b7dad17e",
      },
    ],
  },
  /**
   * undoc-wasm (the `undoc` branch: wasm-pack's output for upstream undoc, docx only, with simd128):
   * a Word document's text as Markdown.
   */
  {
    dir: "undoc",
    version: UNDOC_COMMIT,
    files: [
      {
        to: "undoc_wasm.js",
        url: `${UNDOC_RAW}/undoc_wasm.js`,
        sha256: "b93987bc0c9af79e4e379d3a17f877cd4127f8a8f337dac88cf590b4eb6ea350",
      },
      {
        to: "undoc_wasm_bg.wasm",
        url: `${UNDOC_RAW}/undoc_wasm_bg.wasm`,
        sha256: "2bf79fb0110554e20ec4331b79bb8e9094358b62ff7ec01df52891a180796258",
      },
      {
        to: "LICENSE",
        url: `${UNDOC_RAW}/LICENSE`,
        sha256: "d3f35f6b7df9b36287e75e9811881b24288726f2af92213c7fb5a965478f0496",
      },
    ],
  },
];

/** What the stamp of a library says: its version and the checksums of what was downloaded. */
const stampOf = (lib: Library | FileLibrary) =>
  `${lib.version} ${"files" in lib ? lib.files.map((f) => f.sha256).join(" ") : lib.sha256}\n`;

export async function isPresent(lib: Library | FileLibrary, vendor: string): Promise<boolean> {
  return (await readStamp(join(vendor, lib.dir))) === stampOf(lib);
}

export async function fetchFileLibrary(lib: FileLibrary, vendor: string): Promise<void> {
  const dir = join(vendor, lib.dir);
  if (await isPresent(lib, vendor)) {
    console.log(`ok ${lib.dir} ${lib.version.slice(0, 7)} (already there)`);
    return;
  }
  // Everything is downloaded and checked before the directory is touched.
  const contents = await Promise.all(lib.files.map((f) => download(f.url, f.sha256)));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let bytes = 0;
  for (const [i, f] of lib.files.entries()) {
    await mkdir(dirname(join(dir, f.to)), { recursive: true });
    await Bun.write(join(dir, f.to), contents[i]!);
    bytes += contents[i]!.length;
  }
  await writeStamp(dir, stampOf(lib));
  console.log(`ok ${lib.dir} ${lib.version.slice(0, 7)} (${lib.files.length} files, ${(bytes / 1024).toFixed(0)} KiB)`);
}

export async function fetchLibrary(lib: Library, vendor: string): Promise<void> {
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
  await writeStamp(dir, stamp);
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
