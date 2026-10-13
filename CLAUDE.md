# CLAUDE.md

Local translation app. One Bun process serves the REST/SSE API and the static web app, and runs
llama.cpp in-process (libllama through `bun:ffi`, Vulkan) on a worker thread that holds one model
at a time; the chat model also translates the text in an image (libmtmd, same build and thread). Reading aloud (IndexTTS-2.5) runs in the same process: audio.cpp's C API (libaudiocpp,
built from source) through `bun:ffi` on a second worker thread, which also runs BS-RoFormer (voice
separation) on uploaded voice samples. User docs: README.md. On Windows read `WINDOWS.md` first.

## Commands

Use Bun canary (`bun --revision` must end in `-canary…`; `lint:ts` needs its builtins). In a cloud session where it is not installed, install it first: `curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/canary/bun-linux-x64.zip && unzip -qo /tmp/bun.zip -d /tmp/bun && install -m755 /tmp/bun/bun-linux-x64/bun ~/.bun/bin/bun`.

Run `bun install` before `lint:ts`, `lint:css` or `e2e` when `node_modules` is missing or stale
(`bun --install` does not fetch dev tools for `bun run` scripts).

- Run: `bun src/server.ts` (`--help` lists every setting). Dev: `bun run dev` (`bun --watch`, `DEV_RELOAD=1` reloads pages, `OPEN_BROWSER=0`)
- Test: `bun test` (mock engine, no GPU). E2E/a11y: `bun run e2e` (Playwright, mock engine; `e2e/README.md`; `bunx playwright install chromium` or `CHROMIUM_PATH`)
- Lint and typecheck: `bun run lint:ts` (`bun lint --type-aware --type-check`: builtin linter and builtin type checker, no `tsc`; each file is checked with its nearest `tsconfig.json`, so `e2e/` and `public/` have their own). Config under `[lint]` in `bunfig.toml`. Errors stay at zero; `no-explicit-any` warnings tolerated. Suppress with `// eslint-disable-next-line <rule> -- <why>` (a `: <why>` suffix suppresses nothing)
- Format: `bun run format:write` / `format:check` (`.prettierrc`, 120 columns; Markdown and `public/index.html` are hand-formatted)
- CSS support: `bun run lint:css`. Markdown conformance: `bun scripts/commonmark.ts`. Long documents: `MODEL=index-nailong-9b bun scripts/longtext.ts http://127.0.0.1:3000`
- There is deliberately no `check`, `lint` or `format` script in `package.json`: each would shadow the builtin. The Playwright config is `e2e/playwright.config.ts` (`bun run e2e` passes it with `-c`).

Setup (Linux and Windows):
- `bun scripts/build_llama.ts`: libllama, libmtmd (`LLAMA_BUILD_MTMD`, no video), Vulkan, CPU variants, `libllama-shim.so` into `vendor/llama.cpp` (`--native`, `--keep`, `--shim` only recompiles `src/llama-shim.c`)
- `bun scripts/build_audiocpp.ts`: `vendor/audio.cpp/libaudiocpp.so` from the pinned commit plus `scripts/patches/audiocpp-abort.patch` (AVX2 unless `--native`)
- `bun scripts/fetch_models.ts`: models (about 17.9 GiB) and example voices; `--model <id>`, `HF_ENDPOINT`
- `bun scripts/fetch_web_libs.ts`: `public/vendor/` (not in git): PDF libraries and QOA codec; needed by `e2e`, the QOA tests and packaging, optional for running
- `bun scripts/build_appimage.ts`, `bun scripts/build_installer.ts` (needs both engines built; `WINDOWS.md`)

No npm runtime dependencies on the server; no build step for the web app.

## Layout

- `src/`: `server.ts` entry; `app.ts` routes, model selection, SSE; `config.ts`; `static.ts` (`.ts` in `public/` transpiled on request, cached in memory); `queue.ts`; `preflight.ts` + `llama-probe.ts`; `models.ts`; `prompt.ts`; `prompts/` the NativeLong templates
- `src/image.ts`: an uploaded image through `Bun.Image` to the PNG the engine is given
- Engine pairs, server side + worker: `llama.ts` / `llama-worker.ts` (`llama-ffi.ts` bindings to libllama and libmtmd, `llama-shim.c` struct calls, compiled by `build_llama.ts`); `speech.ts` / `speech-worker.ts` (`audiocpp-ffi.ts` bindings to `vendor/audio.cpp/include/audiocpp.h`, no C shim); `qoa-stream.ts`; `wav.ts`
- `public/`: web app. `state.ts` + `render.ts` hold the state behind the always-shown controls and the one synchronous `render()` (callers move focus right after `setState`); `elements/` light-DOM custom elements enhancing `index.html`; `css/` one file per feature, `style.css` only the layer order and `@import`s
- `e2e/mock-server.ts`: real app on the `test/helpers/mock-engine.ts` mocks, scriptable via a control port. Fixtures: `test/fixtures/essays.en.txt` (long input), `sample.pdf` (rebuilt by `uv run test/fixtures/make_sample_pdf.py`)
- `docs/openapi.yaml` is served at `/api/v1/openapi.yaml`

## Invariants

- The backend never picks a model from the text; the client does (`public/select-model.ts`). `LONG_THRESHOLD_LETTERS = 11_000` there is the switch point (the chat model loses paragraphs beyond about 11–16K letters); keep docs in sync.
- A model swap frees the loaded model and loads the other; repeated requests for the loaded model do not reload it.
- libllama is only called from its worker thread, and every call blocks it. A generation returns to the worker's event loop after each decode, which is when `/tokenize` and cancellations are handled.
- The prompt is written by `chatPrompt` (`src/llama-ffi.ts`), not the Jinja template: ChatML, content trimmed, empty think block, token-identical to the template with `enable_thinking=false`. A model whose template is not ChatML fails to load.
- **Image input** (`image` on `POST /translate`, chat model only):
  - Every upload, a PNG too, is decoded by `Bun.Image` and re-encoded as an uncompressed PNG (`prepareImage`, before the queue); only JPEG, PNG and WebP, 8 MiB, 50 million pixels, scaled to 16 million when larger (the encoder scales to about 4 million itself). `Bun.Image` has no raw or BMP output and libmtmd's stb_image has no WebP, hence PNG in between. The engine only ever decodes PNGs that Bun wrote.
  - The shim decodes the PNG with libmtmd's own stb_image (`stbi_load_from_memory`, exported by the library without a header) instead of `mtmd_helper_bitmap_init_from_buf`, which drops alpha: `Bun.Image` cannot flatten, and dark text on transparency would become black on black. Transparency becomes white.
  - The prompt is `buildImagePrompt` (the `--image` branch of translate.py), then the image: `imageChatPrompt` splits `chatPrompt` there and `mtmd_tokenize_from_parts` puts the image between `<|vision_start|>` and `<|vision_end|>`, as the template does. No media marker, so one in the text is text.
  - The model is M-RoPE: an image takes `max(rows, columns)` positions, not its token count. After an image prompt the worker decodes with explicit positions (`shim_decode_at`, `Model.nextPos`); `llama_batch_get_one` would continue one past the image's first position.
  - The mmproj GGUF (`ModelSpec.mmproj`, fetched with the model) is loaded by the first image and freed with the model. A missing file is `503 image_unavailable`, checked on the server thread per request. About 0.65 GiB VRAM, 1.1 GiB after a full-size image (4,096 image tokens, about 4 s to evaluate, in one call that cannot be stopped).
  - Counting an image's tokens means preparing it, so that count goes through the worker's chain (the caller holds the queue slot) and `/tokenize` refuses images. The image is posted to the worker twice (count, generate).
- Generation is greedy from an empty context. One at a time; up to `MAX_QUEUE` wait FIFO, beyond that `429 queue_full`. Closing the client connection cancels it, except for an SSE request with `resumable: true`: that job (numbered events kept in memory, `src/app.ts` `Job`) runs on for `RESUME_GRACE_MS` with no reader, can be read again by `GET /translations/{id}/events` (`Last-Event-ID`) and is cancelled by `DELETE /translations/{id}`; finished ones are kept 10 minutes.
- `MAX_INPUT_TOKENS + 64 < CTX_SIZE`, else startup fails. Output is capped at 4 × prompt tokens + 512 unless `max_output_tokens` is set.
- No authentication: keep `HOST` on loopback or behind a proxy; `ALLOWED_ORIGINS` / `ALLOWED_HOSTS` control browser and proxy access. An entry that could never match, or matches everything, fails startup.
- `src/server.ts` runs `preflight` before loading anything and exits 1 with one message when the machine cannot run the translator: libraries do not open, no CPU backend, no Vulkan GPU while `GPU_LAYERS` is not `0` (CPU-type devices such as lavapipe do not count), or the default model's file is missing, in that order. The libraries are opened in a separate process so a crashing driver is reported, not suffered. `startApp` does not check; tests and e2e use the mocks.
- Both engines share the process: a crash in either takes the server down, and any exit releases the VRAM.
- libaudiocpp is only called from the speech worker, started by the first `POST /speech` (never at startup). That request loads the model; it is freed after `SPEECH_IDLE_UNLOAD` seconds idle. A failed load is retried by the next request.
- libaudiocpp must link its ggml statically and export only `audiocpp_*` (what `build_audiocpp.ts` builds). audio.cpp's ggml is a fork with the same SONAME `libggml.so.0` as llama.cpp's; shared ggml binds to the loaded libllama and dies with an undefined symbol.
- Aborting an utterance: audio.cpp has no abort, so our patch adds `audiocpp_set_abort_flag` (an int checked before every decoding step, diffusion step and the vocoder; non-zero makes the run fail). Each `synthesize` message carries its own 4-byte `SharedArrayBuffer`, set by the server thread on client abort; the worker answers `aborted`. The request is answered at once but keeps its queue slot until that answer (`Speech.synthesize`'s `done`), so the next utterance never starts beside one still stopping. An utterance whose client left before it was posted is never sent; one posted but not started is skipped by the worker. Not stoppable: conditioning before the first step, a model load, a separation.
- Uploaded voice samples are separated by BS-RoFormer (`POST /voices` → worker `separate`) when a `.gguf` is in `SEPARATION_MODEL_DIR`; otherwise kept as uploaded. The speech and separation models are never loaded together: the worker frees speech, separates, frees the separator; the next utterance reloads speech. `separating` is the gate: an unposted utterance waits and re-checks `loaded` after every wait; already posted ones run first. The model takes only 44.1 kHz, so the worker resamples; the stored voice is the vocals (16-bit, 44.1 kHz) through `normalizeLoudness` (`src/wav.ts`). Failure is `SeparationError` (`502 speech_error`, sample not kept), never a fallback to the unseparated sample. Not run on `VOICES_DIR` files.
- Speech has its own single-slot queue (`MAX_QUEUE` waiting) and never holds the translation queue; both may use the GPU at once.
- `POST /speech`: one request, one utterance, at most 1,000 characters, only `zh`, `en`, `ja`, `es`, `ar` (others come out as noise). The voice id must be one `voices()` lists, never used to build a path otherwise. Markdown handling and sentence splitting are the client's (`public/speech-text.ts`), whose language list must match `SPEECH_LANGUAGES` in `src/speech.ts`.

## Configuration

Every setting is an environment variable with a lowercase-dashed flag that wins (`PORT` / `--port`);
defaults in `src/config.ts`, whose `SETTING_NAMES` lists them, so a new one goes there too. Unknown
arguments fail startup. Non-obvious ones:

- `ALLOWED_ORIGINS`: `scheme://host[:port]` or `scheme://*.host[:port]` (subdomains only); no bare `*`, no path (`src/access.ts`)
- `ALLOWED_HOSTS`: extra `Host` names, needed when `HOST` is `0.0.0.0` or `::`; `name`, `*.name`, IPs; `name:port` pins the port
- `GPU_LAYERS`: `all`, a count, or `0` for CPU. `SPEECH=0`: reading aloud unavailable, libaudiocpp never loaded. `SPEECH_IDLE_UNLOAD=0`: never unload. `SPEECH_BACKEND=cpu` is far slower than real time
- `SPEECH_MODEL_DIR` / `SEPARATION_MODEL_DIR` default under `MODELS_DIR` and hold the one GGUF each; no separation model means no separation. `VOICES_DIR` holds one `*.wav` per voice, read on every `GET /voices`. `LLAMA_DIR` and `AUDIO_DIR` hold the libraries from one build
- `DEV_RELOAD=1` serves `/__dev/reload` (`src/dev-reload.ts`, `dev-watch.ts`)

## API

Spec: `docs/openapi.yaml`; update it, `test/api-contract.test.ts` and `test/openapi.test.ts` with any API change.

- `POST /api/v1/translate`: JSON, or SSE with `stream: true`. `text`, or `image` (base64 or a `data:` URL; `text` then optional and only a hint, `genre` refused); the image does not count towards the 4 MiB body limit (`parseBody`); `413 image_too_large`, `503 image_unavailable`. `POST /tokenize`: counts and budget, never queues or swaps, `503` while no model is ready, no images. `GET /models` (`image` per model and the image limits), `/languages`, `/health`
- `POST /speech`: `{ text, lang, voice?, speed? }` → WAV (22.05 kHz mono), or with `Accept: audio/qoa` (named, not `*/*`) a QOA stream, WAV when the codec is not installed; `503 speech_unavailable`, `502 speech_error`. Speed is `duration_factor` = 1/speed, range 0.5 to 2
- `GET /voices`: speech state, voices, limits. `POST /voices`: WAV upload (8 MiB, at most 16 kept; 1 to 60 s, 8 to 192 kHz, `validateSample` in `src/speech.ts`)

## Models

- `index-translate-9b` (chat): any language; glossary, constraints, genre; images through its mmproj (Q8_0).
- `index-nailong-9b` (NativeLong document): `zh-en`, `en-zh`, `zh-ja`, `ja-zh` only; `source_lang` required; glossary, constraints, genre rejected.

Both Q6_K, about 9.3 GiB VRAM and 70 tokens/s. Speech adds about 5 GiB VRAM after the first utterance. The
separation model's GGUF embeds only a legacy spec, hence `AUDIOCPP_DEPLOYMENT_BUILD=ON` (the load logs a
warning that the compiled catalog is used).

Limits: audio.cpp does not normalize digits in Japanese (`speech-text.ts` writes them in kanji) or
Arabic (garbled, unhandled); German produced noise. NativeLong zh→en loses paragraph markers at full
length (cause unknown), so the client verifies markers for zh→en document output. Chat en→zh loses or
repeats paragraphs by about 16K letters (model property; "translate everything" constraints loop).

## Notes for changes

- UI changes keep `A11Y-ACCEPTANCE.md` (WCAG 2.2 AA) true and `e2e/a11y.spec.ts` green. CSS may use only what `.browserslistrc` supports. Not yet reviewed there: Markdown output, source preview, views, Clear, sync scrolling, Open/Close and the PDF strip.
- The web app must keep working with the server's error codes (`public/errors.ts`) and the paragraph-loss check (`public/paragraphs.ts`, in the source's own unit).
- README.md is for user-visible behaviour only.

### Web app

- **Markdown**: output renders as Markdown only when the *source* passes `looksLikeMarkdown`. The parser is pure and prefix-stable (a block never changes once a later complete line starts another), which `MarkdownStream` relies on to rebuild only the open tail. Elements are built with the DOM API, never `innerHTML`; links limited to `http(s):` and `mailto:`. Copy and the paragraph check use the raw text. Top-level rendered elements carry `data-line`. Parser changes keep `bun scripts/commonmark.ts` passing and `docs/markdown-conformance.md` in step.
- **Link check** (`links.ts`, `checkLinks` in `markdown-dom.ts`): after a finished translation of a Markdown source, an output link target not in the source is disabled, one not in the paired block (`alignBlocks`) is marked as a mismatch. Applied after the last `output.finish()` and re-applied when the view is rebuilt. Clicking any output link opens a modal `<dialog>` (`link-dialog.ts`); unchecked or mismatched links show a warning with "Open anyway"; `window.open` uses `noopener,noreferrer`.
- **Layout**: text box, source preview and translation share one height (`--pane-height`) so switching Raw/Preview shifts nothing; gaps are `--gap`. Switches, Clear and Copy are always shown and `aria-disabled` when idle. `#meta` is the translation panel's one status line (errors `role="alert"`); warnings go in `#notes`. Phone (`max-width: 45.99rem`, `css/phone.css`): `--pane-height` is `calc(100svh - 12rem)`, fixed because iOS Safari's floating toolbar overlays the page and `env(safe-area-inset-bottom)` is 0; below 32rem model buttons show short names (`span.long` / `span.short`; a new model button needs both).
- **CJK typography** is `:lang(ja)` / `:lang(zh)` in `css/cjk.css`, so the textarea, source preview and output must carry the `lang` of their text (`setLang` in `app.ts`).
- **Click-to-sync scrolling** (`sync-scroll.ts`) is on only after a translation that finished with `stop` whose block count (`alignBlocks`) equals the source's, and only while source and output are unchanged.
- **History** (`history.ts`): last 50 translations in `localStorage`; browser-only by design, the server must never learn of it.
- **Resuming a translation** (`resume.ts`): iOS cuts the SSE connection when the page leaves the screen. The page always asks for `resumable: true`; on a cut, a failed read or `visibilitychange`/`pageshow` it reconnects to `/translations/{id}/events` after the last event id seen, so no delta is repeated. Stop also sends `DELETE`.
- **Service worker** (`sw.ts`, registered by `pwa.ts`, not under `DEV_RELOAD`): stale-while-revalidate for same-origin GETs except `/api/` and `/__dev/`, so the installed app opens from its cache and updates on the next open. Bump `CACHE` to drop old caches. e2e blocks service workers. `static.ts` sends `no-cache` (ETag) for code and `max-age=86400` for `icons/` and `vendor/`.
- **Reading aloud** (`speech-text.ts` pure, `speech-buffer.ts` audio, `speech.ts` player, `speech-ui.ts` page side): one side at a time. `speechSegments` builds utterances from `parseLines` for Markdown-shown text (never the raw text), line by line otherwise, packed into pieces of whole sentences (`Intl.Segmenter`; 180 characters, 60 for zh/ja) carrying their block's `data-line`. The buffer keeps exactly one request in flight until everything it wants is there (the reader's piece, then `NEAR_SECONDS`, then Previous/Next targets, then `AHEAD_SECONDS`) and aborts a request whose piece left the plan; voice or speed changes empty it and abort at once. One `AudioContext` created in the click; pause is `suspend()`. While `loading` only Stop works. A new translation, Clear, editing the source or changing From stops the reading.
- **QOA speech stream** (`qoa-stream.ts`, `public/qoa*.ts`, codec in `public/vendor/qoa/`): the page sends `Accept: audio/qoa, audio/wav;q=0.5` and goes by the answer's `Content-Type`; the server falls back to WAV when the codec is missing (`qoaLoader`; a miss is not remembered, so installing needs no restart). Decoding runs in a module worker (so the CSP needs no `wasm-unsafe-eval`). The page falls back to WAV for its life when `WebAssembly`/`Worker` is missing, the codec does not load, or a stream fails to decode (`QoaError`, request repeated without QOA).
- **Image as the source** (`open-ui.ts` `openImage`, `app.ts` `sourceImage`): an opened or dropped JPEG, PNG or WebP stands where the text box is, drawn on a `<canvas role="img">` (the CSP allows no `blob:` or `data:` picture) with the box empty under it; `state.image` keeps Clear enabled. Translate sends the file as a `data:` URL to the chat model whatever the model choice (`buildImageRequest`: glossary and constraints, no genre, no text). No Markdown, paragraph check, sync or history entry for an image. Whatever puts a text in the box (`loadSource`, a restored entry) takes the image away.
- **Opening files and PDF** (`open-file.ts`, `open-ui.ts`, `pdf.ts`, `pdf-worker.ts`, `elements/pdf-pages.ts`): browser-only like history (an image excepted, above); the server only serves the libraries. Text enters through `loadSource(text, preview)`, which Clear also uses. A clicked PDF page is extracted by pdf-inspector into the source; an empty result (a scan) leaves the box alone, `pagesNeedingOcr` or U+FFFD text is loaded with a warning (`pageNote`). Open reads Close while a PDF is open; Clear keeps it open. A later pick or click wins (`turn`), and a result arriving after a translation started is dropped.
  - Libraries are bundled, not from a CDN: the app is offline by design, the CSP is `default-src 'self'` (`static.ts`), and a CDN would run someone else's script in a page holding the user's documents. Pinned by checksum in `fetch_web_libs.ts`; when missing, `pdfInstalled()` hides PDF from the picker. They load on the first PDF, never at page load.
  - pdf-inspector is synchronous and reads the whole file per call, hence the worker (one per document). pdf.js is the legacy build (the other targets browsers newer than `.browserslistrc`).
  - Chromium 141 died with a V8 OOM compiling pdf-inspector's WebAssembly on a large PDF; e2e uses Playwright `~1.64.0` (Chromium 156). A new minor means a new browser: bump deliberately.
  - pdf-inspector 1.25.2: CJK in non-embedded fonts naming a predefined CMap comes out as U+FFFD (page 3 of `sample.pdf`; when fixed upstream, `e2e/open.spec.ts`'s warning test needs another page); two-column pages may be misordered; password-protected files are refused.
  - Changing a pin (`LIBRARIES` in `fetch_web_libs.ts`): check the typed calls in `pdf.ts` and `pdf-worker.ts` against the packages' `.d.ts`, that `place` finds the files, the licenses (`THIRD_PARTY_NOTICES.md`, `AppRun`), then `bun run e2e` and a large PDF in Chrome and Firefox.

### Engine and packaging

- Changing the audio.cpp pin (`TAG`, `COMMIT` in `build_audiocpp.ts`) or the speech GGUF (checksum in `fetch_models.ts`): check `src/audiocpp-ffi.ts` signatures and both struct layouts against the new `audiocpp.h` by hand (the build only proves the functions exist); the library still exports only `audiocpp_*` and needs no `libggml*.so`; `audiocpp-abort.patch` applies and its three checks still sit in the loops (`gpt.cpp` decoding, `s2mel.cpp` diffusion, `session.cpp` before the vocoder) and upstream added no abort; an utterance aborted early, mid and late stops within tens of milliseconds and the same sentence afterwards gives the same samples; a sentence per language by ear; the `duration_factor` range; VRAM beside the chat model. No test uses the real speech library.
- Changing the llama.cpp pin (`TAG`, `COMMIT` in `build_llama.ts`): check `src/llama-ffi.ts` signatures against the new `llama.h` and `mtmd.h` by hand (only the shim is compiled against them) and the CMake options; libmtmd's API is declared unstable, so read `mtmd.h` and `mtmd-helper.h` for changes to what the shim calls, check that `libmtmd` still exports `stbi_load_from_memory` (the shim fails to link otherwise), and translate an opaque, a transparent and a full-size image (no test uses the real library); compare output with that tag's `llama-server` and rerun the long-document check. After editing `llama-shim.c`: `bun scripts/build_llama.ts --shim`, and declare new functions in `llama-ffi.ts`.
- Builds that leave this machine (AppImage) must not be `--native`. `build_llama.ts` passes `-march=x86-64` itself; `build_audiocpp.ts` needs AVX2 either way.
- AppImage (`build_appimage.ts`, `packaging/appimage/`): the AppDir holds Bun and the repository layout in `usr/share/index-translator`, so `config.ts` finds everything as in a checkout; a new top-level directory the server reads must be added to the script. No system libraries are packed. `AppRun` sets `MODELS_DIR` and `VOICES_DIR` under `$XDG_DATA_HOME/index-translator/`, sets `INDEX_TRANSLATOR_APPIMAGE`, starts Bun with `--no-env-file`, and deliberately leaves `LD_LIBRARY_PATH` unset (the browser is started from this process). A new `APPIMAGETOOL` or `RUNTIME` needs a new URL and checksum; the runtime must stay the static one.
- CI (`.github/workflows/ci.yml`): `test` runs what Commands lists; `appimage` builds both engines (cached per script and patch), packs, and on the GPU-less runner checks the Vulkan message, that `--gpu-layers 0` loads the engine, and that `fetch` refuses an unknown model. `BUN_VERSION` there is the Bun that ships. Nothing in CI runs a model.
- Third-party notices: `THIRD_PARTY_NOTICES.md`. `fetch` (`acceptNotices` in `fetch_models.ts`) prints `NOTICES[id]` and needs "yes" on stdin; there is deliberately no bypass flag. A new pin, library or model means checking its license and updating the markdown, `NOTICES` and `AppRun`'s text; a test keeps the markdown and `NOTICES` in step.
