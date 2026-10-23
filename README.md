# pdf-inspector-wasm

The WebAssembly build of [pdf-inspector](https://github.com/firecrawl/pdf-inspector), the `wasm` crate, as
`wasm-pack` generated it. index-translator uses it in the browser to read a PDF page's text as Markdown
(`scripts/fetch_web_libs.ts` on `main` fetches these files by commit and checksum).

Built from [ruihe774/pdf-inspector@6402ae1](https://github.com/ruihe774/pdf-inspector/commit/6402ae13641fa07a25336568aec948796c6b5bc5)
(branch `perf/wasm-opt-level-2`, on upstream 1.25.2 plus two changes not yet upstream):

- `PdfDocument`: opens a PDF once and processes pages from the parsed document (`new PdfDocument(bytes)`,
  `pageCount`, `processPages({ pages })`, `free()`), where `processPdf` parses the file again on every call;
- the wasm build at `opt-level = 2` with wasm-pack's default wasm-opt pass, without `strip`.

```sh
wasm-pack build wasm --target web --scope firecrawl --release
```

with wasm-pack 0.15.0 (its wasm-bindgen and wasm-opt) and rustc 1.98.0 (the repository's pin). Nothing here
is edited by hand except this README; `LICENSE` is pdf-inspector's. `--target web`: an ES module that is
used without a bundler and whose `default` export instantiates the binary. `simd128` is not enabled: it made
no measurable difference.

## Usage

```js
import init, { PdfDocument } from "./pdf_inspector_wasm.js";

await init({ module_or_path: "./pdf_inspector_wasm_bg.wasm" });
const doc = new PdfDocument(new Uint8Array(await file.arrayBuffer()));
const { markdown, pagesNeedingOcr } = doc.processPages({ pages: [3] });
doc.free();
```

`processPdf(bytes, options)` is still exported and behaves as in 1.25.2.
