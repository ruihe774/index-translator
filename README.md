# undoc-wasm (docx only)

The WebAssembly build of [undoc](https://github.com/iyulab/undoc), the `undoc-wasm` crate, as
`wasm-pack` generated it, with only the `docx` format compiled in. index-translator uses it in the
browser to read a Word document's text as Markdown (`scripts/fetch_web_libs.ts` on `main` fetches
these files by commit and checksum).

Built from [ruihe774/undoc@393af42](https://github.com/ruihe774/undoc/commit/393af42e3922fb1417e1465019e07530b35866ba),
which inflates ZIP entries with the host's `DecompressionStream` instead of a decompressor compiled
into the binary:

```sh
wasm-pack build undoc-wasm --release --target web --no-default-features --features docx
```

with wasm-pack 0.15.0 (its wasm-bindgen and wasm-opt) and rustc 1.98.1. Nothing here is edited by
hand except this README; `LICENSE` is undoc's. `--target web`: an ES module that is used without a
bundler and whose `default` export instantiates the binary (`snippets/` holds the
`DecompressionStream` glue it imports).

## Usage

```js
import init, { parse } from "./undoc_wasm.js";

await init({ module_or_path: "./undoc_wasm_bg.wasm" });
const doc = await parse(new Uint8Array(await file.arrayBuffer())); // rejects with an Error carrying `kind`
const markdown = doc.toMarkdown();
doc.free();
```

The runtime must provide `DecompressionStream` (`deflate-raw`): current browsers, Node.js 18+, Bun.
