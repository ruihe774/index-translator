# undoc-wasm (docx only)

The WebAssembly build of [undoc](https://github.com/iyulab/undoc), the `undoc-wasm` crate, as
`wasm-pack` generated it, with only the `docx` format compiled in. index-translator uses it in the
browser to read a Word document's text as Markdown (`scripts/fetch_web_libs.ts` on `main` fetches
these files by commit and checksum).

Built from [iyulab/undoc@3a9dbbb](https://github.com/iyulab/undoc/commit/3a9dbbb911b30e944323402d30278e0629444885)
(upstream main, `undoc-wasm` 0.27.0):

```sh
CARGO_PROFILE_RELEASE_OPT_LEVEL=2 \
  wasm-pack build undoc-wasm --release --target web -- --no-default-features --features docx
```

with wasm-pack 0.15.0 (its wasm-bindgen and wasm-opt) and rustc 1.99.1. `opt-level=2` instead of the
workspace's 3 (5% smaller, same speed), and no `simd128`: measured on a 1.4 MB document, the SIMD build
was 3–5% slower. rustc's default wasm32 features (sign-ext, nontrapping-fptoint, multivalue,
reference-types, bulk-memory, mutable-globals) are WebAssembly 2.0 without SIMD, which the runtime must
support. Nothing here is edited by
hand except this README; `LICENSE` is undoc's. `--target web`: an ES module that is used without a
bundler and whose `default` export instantiates the binary. ZIP entries are inflated by the crate
itself.

## Usage

```js
import init, { parse } from "./undoc_wasm.js";

await init({ module_or_path: "./undoc_wasm_bg.wasm" });
const doc = parse(new Uint8Array(await file.arrayBuffer())); // throws an Error carrying `kind`
const markdown = doc.toMarkdown();
doc.free();
```
