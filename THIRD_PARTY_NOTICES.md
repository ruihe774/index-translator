# Third-party notices

Index Translator is built on the software and models below. They keep their own licenses; this file
names them and says where the full texts are. The AppImage carries this file in
`usr/share/index-translator/` and prints it with `Index_Translator-x86_64.AppImage notices`.

## Software in the AppImage and in a source build

| Component | Used for | License | Full text |
|---|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) (libllama, libmtmd, the Vulkan and CPU backends), pinned in `scripts/build_llama.ts` | Running the translation models | MIT, Copyright (c) 2023-2026 The ggml authors | `vendor/llama.cpp/LICENSE` |
| [ggml](https://github.com/ggml-org/ggml), part of llama.cpp | Tensor library under llama.cpp | MIT, Copyright (c) 2023-2026 The ggml authors | `vendor/llama.cpp/LICENSE` |
| libmtmd (`libmtmd.so`), part of llama.cpp (`tools/mtmd`) | Image input: the image encoder of Index-Translate-9B | MIT, Copyright (c) 2023-2026 The ggml authors | `vendor/llama.cpp/LICENSE` |
| stb_image, miniaudio and hash functions (SHA-1, SHA-256, xxHash), in llama.cpp's source tree (`vendor/`) | Compiled into `libmtmd.so`; stb_image decodes the image | Each under its own license: public domain or MIT (stb_image, Sean Barrett), public domain or MIT-0 (miniaudio, David Reid), public domain (SHA-1, SHA-256), BSD 2-Clause (xxHash, Copyright (c) 2012-2021 Yann Collet); the texts are in llama.cpp's repository at the pinned commit | `vendor/stb/stb_image.h`, `vendor/miniaudio/miniaudio.h`, `vendor/hash/*/` there |
| [audio.cpp](https://github.com/0xShug0/audio.cpp) (`libaudiocpp.so`), pinned in `scripts/build_audiocpp.ts` | Reading aloud (IndexTTS-2.5) and voice separation (BS-RoFormer) | Apache-2.0, Copyright 2026 ShugoAI LLC | `vendor/audio.cpp/LICENSE` |
| ggml, audio.cpp's fork, linked statically into `libaudiocpp.so` | Tensor library under audio.cpp | MIT, Copyright (c) 2023-2026 The ggml authors | `vendor/audio.cpp/LICENSE.ggml` |
| cJSON, SentencePiece and the Abseil subset that comes with SentencePiece, in audio.cpp's source tree (`external/`) | Compiled into `libaudiocpp.so` | Each under its own license (MIT, Apache-2.0, Apache-2.0); the files are in audio.cpp's repository at the pinned commit | `external/*/LICENSE` there |
| [libsoxr](https://sourceforge.net/projects/soxr/) (the SoX Resampler Library, `libsoxr.so.0`; `soxr.dll` in the Windows installer), version and commit pinned in `scripts/build_soxr.ts`, built unchanged | Resampling for audio.cpp (the voice samples) and for the Opus encoder (the speech) | LGPL-2.1 or later, Copyright (c) 2007-18 robs; the PFFFT code in it is under a BSD-like license (Copyright (c) 2013 Julien Pommier, and 2004 University Corporation for Atmospheric Research for the FFTPACK parts), stated in its source file; it is a separate shared library that can be replaced by another build of the same version, and its source is the repository at the pinned commit (the same files as the release tarball `soxr-0.1.3-Source.tar.xz`) | `vendor/soxr/LICENCE` and `vendor/soxr/COPYING.LGPL` |
| minicelt (the `miniopus` branch of this app's repository, a Rust port of the CELT encoder of [libopus](https://opus-codec.org) built for WebAssembly, pinned by commit in `scripts/fetch_minicelt.ts`) | Encoding the speech stream as Opus; libsoxr also resamples the audio it takes | BSD-3-Clause, as a derivative of libopus (Copyright 2001-2023 Xiph.Org, Skype Limited, Octasic, Jean-Marc Valin, Timothy B. Terriberry, CSIRO, Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo, Mozilla, Amazon), with the royalty-free patent licenses named in the text | `vendor/minicelt/COPYING` |
| [turndown](https://github.com/mixmark-io/turndown) (its browser build, `dist/turndown.js` of the npm package), pinned in `scripts/fetch_turndown.ts` | Runs inside a web page the server opens: the page's HTML as Markdown | MIT, Copyright (c) 2017 Dom Christie | `vendor/turndown/LICENSE` |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) 1.31.0 (Microsoft's official release build, CPU only: `libonnxruntime.so.1.31.0`; `onnxruntime.dll` in the Windows installer), pinned in `scripts/fetch_onnxruntime.ts`, used unchanged | For upcoming sentence segmentation (the SaT model below); not used yet | MIT, Copyright (c) Microsoft Corporation; the release's own `ThirdPartyNotices.txt`, shipped alongside the library, lists the licenses of the components compiled into it | `vendor/onnxruntime/LICENSE` and `vendor/onnxruntime/ThirdPartyNotices.txt` |
| [Bun](https://bun.sh) (`usr/bin/bun` in the AppImage) | JavaScript runtime and HTTP server | MIT for Bun itself; the executable also contains statically linked components under their own licenses, among them JavaScriptCore (LGPL-2.0 or later) | <https://bun.com/docs/project/licensing> |

| [pdf-inspector](https://github.com/firecrawl/pdf-inspector), its WebAssembly build (`@firecrawl/pdf-inspector-wasm`), pinned in `scripts/fetch_web_libs.ts` | Runs in the browser: the text of a PDF page as Markdown | MIT, Copyright (c) 2026 Firecrawl; the binary embeds CMaps derived from Adobe's CMap resources (BSD 3-Clause, Copyright 1990-2009 Adobe Systems Incorporated) | `public/vendor/pdf-inspector/LICENSE` |
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`, the legacy build), pinned in `scripts/fetch_web_libs.ts` | Runs in the browser: the page thumbnails of a PDF | Apache-2.0, Copyright Mozilla Foundation | `public/vendor/pdfjs/LICENSE` |
| Data and decoders that come with pdf.js: Adobe's CMaps (`cmaps/`), the Foxit and Liberation fonts (`standard_fonts/`), the OpenJPEG, JBIG2 (PDFium) and qcms decoders compiled to WebAssembly (`wasm/`), an ICC profile (`iccs/`) | Used by pdf.js for PDFs that need them | Each under its own license: BSD 3-Clause (CMaps, Foxit fonts, JBIG2), the Liberation font license (GPL-2.0 with a font exception), BSD 2-Clause (OpenJPEG), MIT (qcms), CC0 (the profile), and Apache-2.0, BSD and MIT for Mozilla's glue code | The `LICENSE*` files in those four directories under `public/vendor/pdfjs/` |
| [undoc](https://github.com/iyulab/undoc), its WebAssembly build with only the docx format (the `undoc` branch of this app's repository, built by wasm-pack from [ruihe774/undoc@393af42](https://github.com/ruihe774/undoc/commit/393af42e3922fb1417e1465019e07530b35866ba), pinned by commit in `scripts/fetch_web_libs.ts`) | Runs in the browser: the text of a Word (.docx) document as Markdown | MIT, Copyright (c) 2025 iyulab; the binary links Rust crates, each under MIT or under MIT or Apache-2.0 at the user's choice (among them zip, quick-xml, cfb, serde_json and wasm-bindgen), whose texts come with each crate | `public/vendor/undoc/LICENSE` |
| qoa-wasm (the `qoa` branch of this app's repository, pinned by commit in `scripts/fetch_web_libs.ts`): an encoder and decoder for [QOA](https://qoaformat.org), the audio format designed by Dominic Szablewski | Runs on the server (encoding) and in the browser (decoding): the speech stream | Public domain (the Unlicense) | `public/vendor/qoa/LICENSE` |

`libaudiocpp.so` is built from audio.cpp's source with one change of ours,
`scripts/patches/audiocpp-abort.patch` in this app's repository: a function that lets the app stop
an utterance that is being generated.

The AppImage is packed with [appimagetool](https://github.com/AppImage/appimagetool) and the
[type2-runtime](https://github.com/AppImage/type2-runtime), whose code is embedded at the start of the
AppImage file; their notices are in those projects' repositories.

Not included in the AppImage and taken from the system: the C and C++ runtime libraries, `libgomp`,
the Vulkan loader and the GPU driver, `curl` (used by `fetch`), and the browser that opens web pages
for translation (Chrome, Chromium, Edge or Brave; the system WebKit on macOS).

The web app (`public/`) loads no fonts or scripts from the network. Its only third-party code is the
two PDF libraries, undoc and the QOA codec above, in `public/vendor/`: files of this app's own server, downloaded by
`scripts/fetch_web_libs.ts` (they are not in the repository) and packed into the AppImage.
`prompts/` holds the four NativeLong prompt templates of
[bilibili/Index-Translate](https://github.com/bilibili/Index-Translate) (Apache-2.0).

## Models and voices that `fetch` downloads

They are not in the AppImage and not in this repository. `fetch` prints the notice of each one it is
about to download and asks for `yes` first (the same text as here, in short).

### Index-Translate-9B and Index-NativeLong-9B (`index-translate-9b`, `index-nailong-9b`)

- Authors: IndexTeam (bilibili). Files: `Index-Translate-9B-GGUF`, `Index-Nailong-9B-GGUF` on Hugging Face.
  With `index-translate-9b` comes its image encoder (`Index-Translate-9B.mmproj-Q8_0.gguf`), a second
  file of the same repository, which lets the model read the text in an image.
- License: Apache-2.0 (as stated on both model cards).
- <https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF>, <https://huggingface.co/IndexTeam/Index-Nailong-9B-GGUF>

### IndexTTS-2.5 (`index-tts-2.5`)

- Authors: bilibili (IndexTeam). The file is audio.cpp's GGUF conversion (`audio-cpp/audio.cpp-gguf`,
  `IndexTTS2.5-GGUF`, Q8_0), a Derivative Work in the license's terms.
- License: **bilibili Model Use License Agreement**, not an Apache or MIT license. It is a limited,
  royalty-free license with these conditions, among others (the full text governs; the Chinese
  version prevails over the English one):
  - Anyone whose (or whose affiliates') products had more than 100 million monthly active users, or
    whose annual revenue exceeded RMB 1 billion, needs a separate license from bilibili.
  - The model and anything derived from it must not be used to improve another AI model, except
    IndexTTS-2 itself, its derivatives, or non-commercial AI models.
  - No use that violates the law where the output or the model is generated or used (false
    information, discriminatory content, privacy violations), and no use in high-risk scenarios such
    as medical diagnosis, autonomous driving, military applications, critical-infrastructure control,
    large-scale biometric surveillance or automated decision-making.
  - Whoever distributes the model must keep the copyright notices and a copy of the license, and
    bind recipients to it. A distributed derivative must say that its modifications are not endorsed
    by bilibili.
  - The model and its output are provided as is; you answer for what you make with them (including
    other people's rights in a voice you imitate). bilibili can revoke the license on breach.
  - Chinese law governs; disputes go to the Shanghai Arbitration Commission.
- Full text: <https://huggingface.co/IndexTeam/IndexTTS-2.5/blob/main/LICENSE>
- <https://huggingface.co/audio-cpp/audio.cpp-gguf/tree/main/IndexTTS2.5-GGUF>

### Example voices (downloaded with `index-tts-2.5`)

- Eleven speaker recordings (`voice_01.wav` …) from the IndexTTS-2 demo space,
  <https://huggingface.co/spaces/IndexTeam/IndexTTS-2-Demo>, whose card states Apache-2.0. Who the
  speakers are and what they agreed to is not stated there. A voice is imitated by the speech model,
  so use only voices you have the right to use; your own uploads are your responsibility.

### BS-RoFormer ep368 (`bs-roformer`)

- Voice separation model, audio.cpp's GGUF conversion (`audio-cpp/audio.cpp-gguf`,
  `BS-RoFormer-ep368-GGUF`, Q8_0).
- License: Apache-2.0 according to audio.cpp's list of model licenses; the source of the checkpoint
  is undocumented there.
- <https://huggingface.co/audio-cpp/audio.cpp-gguf/tree/main/BS-RoFormer-ep368-GGUF>,
  <https://github.com/0xShug0/audio.cpp/blob/main/docs/model_licenses.md>

### SaT 3L-SM (`sat-3l-sm`)

- Sentence segmentation model (where reading aloud cuts a text into utterances): `segment-any-text/sat-3l-sm` of
  [wtpsplit](https://github.com/segment-any-text/wtpsplit), as an 8-bit ONNX export by jiangzhuo9357
  (`jiangzhuo9357/sat-3l-sm-onnx`, `model.onnx`), with `tokenizer.json`, which is the tokenizer of
  `FacebookAI/xlm-roberta-base`, unmodified. Both files are downloaded into `models/sat-3l-sm/`.
- License: MIT (the weights; wtpsplit's code, Copyright (c) 2024 Benjamin Minixhofer, Markus Frohmann,
  Igor Sterner; the repository carries wtpsplit's `LICENSE`; and xlm-roberta-base, whose tokenizer it is).
- <https://huggingface.co/jiangzhuo9357/sat-3l-sm-onnx>, <https://huggingface.co/segment-any-text/sat-3l-sm>,
  <https://huggingface.co/FacebookAI/xlm-roberta-base>

## Keeping this file true

Changing a pin in `scripts/build_llama.ts`, `scripts/build_audiocpp.ts`, `scripts/build_soxr.ts`, `scripts/build_appimage.ts`,
`scripts/fetch_web_libs.ts`, `scripts/fetch_onnxruntime.ts` or `scripts/fetch_models.ts`, or adding a model, a library or a download, means checking its license and
updating this file and `NOTICES` in `scripts/fetch_models.ts`.
