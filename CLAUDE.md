# CLAUDE.md

Local translation app. One Bun process serves the REST/SSE API and the static web app, and runs
llama.cpp in-process (libllama through `bun:ffi`, Vulkan) on a worker thread that holds one model at a
time; the chat model also translates the text in an image (libmtmd, same build and thread). Reading
aloud (IndexTTS-2.5) runs in the same process: audio.cpp's C API (libaudiocpp, built from source)
through `bun:ffi` on a second worker thread, which also runs BS-RoFormer (voice separation) on uploaded
voice samples. User docs: README.md. On Windows read `WINDOWS.md` first.

## Commands

Use Bun canary (`bun --revision` must end in `-canary…`; `lint:ts` needs its builtins). Cloud session without it: `curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/canary/bun-linux-x64.zip && unzip -qo /tmp/bun.zip -d /tmp/bun && install -m755 /tmp/bun/bun-linux-x64/bun ~/.bun/bin/bun`.

Run `bun install` before `lint:*` or `e2e` when `node_modules` is missing or stale.

- Run: `bun src/server.ts` (`--help` lists every setting). Dev: `bun run dev`
- Test: `bun test` (mock engine, no GPU). E2E/a11y: `bun run e2e` (Playwright, mock engine; `e2e/README.md`; `bunx playwright install chromium` or `CHROMIUM_PATH`)
- Coverage: `bun run test:coverage`, `bun run e2e:coverage` (`e2e/coverage.ts`); workers are not measured
- Lint and typecheck: `bun run lint:ts` (`bun lint`: builtin linter and type checker, no `tsc`; each file uses its nearest `tsconfig.json`). Config under `[lint]` in `bunfig.toml`. Errors and warnings stay at zero. Suppress with `// eslint-disable-next-line <rule> -- <why>` (a `: <why>` suffix suppresses nothing). **If a change introduces lint errors or warnings, tell the user which rules failed, even if you then fix them** (the user audits the rules).
- JS browser support: `bun run lint:es` (ESLint, `eslint-plugin-browser-compat` against `.browserslistrc` and `eslint-plugin-es-x` up to `ES_EDITION` in `scripts/lint_es.ts`: raise it as editions reach Baseline widely available). It lints what `public/*.ts` becomes under `Bun.Transpiler`: `bun:*` and `*.json` imports are errors. Bun strips comments, so `eslint-disable` in `public/` does nothing: an exception goes in `scripts/lint_es.ts` (`settings.polyfills` or a rule override) with a comment why. Same reporting rule as `lint:ts`
- Format: `bun run format:write` / `format:check` (120 columns; Markdown is hand-formatted)
- CSS: `bun run lint:css`. Markdown conformance: `bun scripts/commonmark.ts`. Long documents: `MODEL=index-nailong-9b bun scripts/longtext.ts http://127.0.0.1:3000`
- No `check`, `lint` or `format` script in `package.json` on purpose: each would shadow the builtin.

Setup (Linux and Windows):
- `bun scripts/build_llama.ts`: libllama, libmtmd, Vulkan, CPU variants, `libllama-shim.so` into `vendor/llama.cpp` (`--shim` only recompiles `src/llama-shim.c`)
- `bun scripts/build_audiocpp.ts`: `vendor/audio.cpp/libaudiocpp.so` from the pinned commit plus `scripts/patches/audiocpp-abort.patch` (AVX2 unless `--native`)
- `bun scripts/build_soxr.ts`: `vendor/soxr/libsoxr.so.0` (`soxr.dll`) from the pinned commit of soxr's git repository; required, opened before libaudiocpp (see Invariants)
- `bun scripts/fetch_models.ts`: models (about 17.9 GiB) and example voices; `--model <id>`, `HF_ENDPOINT`
- `bun scripts/fetch_web_libs.ts`: `public/vendor/` (not in git): PDF libraries, undoc (Word), QOA codec; needed by `e2e`, QOA tests, packaging
- `bun scripts/fetch_minicelt.ts`: `vendor/minicelt/` (not in git): the Opus encoder (WASM 3.0 build, pinned commit of the `miniopus` branch); needed with libsoxr by the Opus tests and e2e (skipped without), required by packaging
- `bun scripts/build_appimage.ts`, `bun scripts/build_installer.ts` (need both engines built; `WINDOWS.md`)

No npm runtime dependencies; no build step for the web app.

## Layout

- `src/`: `server.ts` entry; `app.ts` routes, model selection, SSE; `config.ts`; `static.ts` (`.ts` in `public/` transpiled on request); `queue.ts`; `preflight.ts` + `llama-probe.ts`; `models.ts`; `prompt.ts` (NativeLong templates); `image.ts`
- Engine pairs, server + worker: `llama.ts` / `llama-worker.ts` (`llama-ffi.ts` bindings, `llama-shim.c` struct calls); `speech.ts` / `speech-worker.ts` (`audiocpp-ffi.ts` bindings to `vendor/audio.cpp/include/audiocpp.h`, no C shim); `opus-stream.ts` (+ `ogg-opus.ts`, `resample.ts`); `qoa-stream.ts`; `accept.ts`; `wav.ts`
- `public/`: web app. `state.ts` + `render.ts` hold the state behind the always-shown controls and the one synchronous `render()` (callers move focus right after `setState`); `elements/` light-DOM custom elements enhancing `index.html`; `css/` one file per feature, `style.css` only the layer order and `@import`s
- `e2e/mock-server.ts`: real app on the `test/helpers/mock-engine.ts` mocks, scriptable via a control port. Fixtures in `test/fixtures/` (`sample.pdf`: `uv run make_sample_pdf.py`; `sample.docx`: `make_sample_docx.py`)

## Invariants

- The backend never picks a model from the text; the client does (`public/select-model.ts`). `LONG_THRESHOLD_LETTERS = 11_000` there is the switch point (the chat model loses paragraphs beyond about 11–16K letters); keep docs in sync.
- A model swap frees the loaded model and loads the other; repeated requests do not reload.
- libllama is only called from its worker thread, and every call blocks it. A generation returns to the worker's event loop after each decode, which is when `/tokenize` and cancellations are handled.
- The prompt is written by `chatPrompt` (`src/llama-ffi.ts`), not the Jinja template: ChatML, content trimmed, empty think block, token-identical to the template with `enable_thinking=false`. A non-ChatML template fails to load.
- **Image input** (`image` on `POST /translate`, chat model only):
  - Every upload is decoded by `Bun.Image` and re-encoded as an uncompressed PNG (`prepareImage`, before the queue); JPEG, PNG, WebP only, 8 MiB, 50 million pixels. It is resized once to the size libmtmd would pick (`engineSize`, Qwen-VL smart resize, cubic), so libmtmd copies it without resampling. PNG in between because `Bun.Image` has no raw output and libmtmd's stb_image has no WebP.
  - The shim decodes with libmtmd's own `stbi_load_from_memory` (exported without a header), not `mtmd_helper_bitmap_init_from_buf`, which drops alpha: transparency becomes white (dark text would otherwise be black on black).
  - The prompt is `buildImagePrompt`, then the image: `imageChatPrompt` splits `chatPrompt` there and `mtmd_tokenize_from_parts` puts the image between `<|vision_start|>` and `<|vision_end|>`. No media marker, so one in the text is text.
  - M-RoPE: an image takes `max(rows, columns)` positions, not its token count. After an image prompt the worker decodes with explicit positions (`shim_decode_at`, `Model.nextPos`); `llama_batch_get_one` would continue one past the image's first position.
  - The mmproj GGUF (`ModelSpec.mmproj`) is loaded by the first image and freed with the model. Missing: `503 image_unavailable`, checked per request. About 0.65 GiB VRAM, 1.1 GiB after a full-size image.
  - Counting an image's tokens means preparing it, so it goes through the worker's chain and `/tokenize` refuses images.
- Generation is greedy from an empty context. One at a time; up to `MAX_QUEUE` wait FIFO, beyond that `429 queue_full`. Closing the client connection cancels it, except for an SSE request with `resumable: true`: that job (`Job` in `src/app.ts`, numbered events in memory) runs on for `RESUME_GRACE_MS` with no reader, can be read again by `GET /translations/{id}/events` (`Last-Event-ID`) and is cancelled by `DELETE /translations/{id}`; finished ones are kept 10 minutes.
- `MAX_INPUT_TOKENS + 64 < CTX_SIZE`, else startup fails. Output is capped at 4 × prompt tokens + 512 unless `max_output_tokens` is set.
- No authentication: keep `HOST` on loopback or behind a proxy; `ALLOWED_ORIGINS` / `ALLOWED_HOSTS` control access.
- `src/server.ts` runs `preflight` first and exits 1 with one message when the machine cannot run the translator: libraries do not open (checked in a separate process so a crashing driver is reported), no CPU backend, no Vulkan GPU while `GPU_LAYERS` is not `0` (CPU-type devices such as lavapipe do not count), or the default model's file is missing. `startApp` does not check; tests and e2e use the mocks.
- Both engines share the process: a crash in either takes the server down.
- libaudiocpp is only called from the speech worker, started by the first `POST /speech` (never at startup), which loads the model; it is freed after `SPEECH_IDLE_UNLOAD` seconds idle. A failed load is retried by the next request.
- libaudiocpp must link its ggml statically and export only `audiocpp_*`. audio.cpp's ggml is a fork with the same SONAME `libggml.so.0` as llama.cpp's; shared ggml binds to the loaded libllama and dies with an undefined symbol.
- libsoxr: audio.cpp (`src/framework/audio/resampling.cpp`) `dlopen`s `libsoxr.so.0` / `soxr.dll` by bare name, prefers it for the IndexTTS-2 reference audio (22.05 and 16 kHz) and for mixing, and otherwise falls back to a torchaudio-style sinc or linear resampler, which sounds different. So `openSoxr` (`src/audiocpp-ffi.ts`) opens our `vendor/soxr` build by full path before libaudiocpp; the loader hands an already-loaded library to a later request for its name (SONAME on Linux, file name on Windows), ahead of any installed one. A missing build is an error, not a fallback. Changing the audio.cpp pin: recheck that the lookup names and the `soxr_*` symbols are still those.
- Aborting an utterance: audio.cpp has no abort, so our patch adds `audiocpp_set_abort_flag` (checked before every decoding step, diffusion step and the vocoder; non-zero makes the run fail). Each `synthesize` message carries its own 4-byte `SharedArrayBuffer`, set on client abort; the worker answers `aborted`. The request is answered at once but keeps its queue slot until that answer (`Speech.synthesize`'s `done`). Not stoppable: conditioning before the first step, a model load, a separation.
- Uploaded voice samples are separated by BS-RoFormer (`POST /voices` → worker `separate`) when a `.gguf` is in `SEPARATION_MODEL_DIR`; otherwise kept as uploaded. Speech and separation models are never loaded together: the worker frees speech, separates, frees the separator (`separating` is the gate). The stored voice is the vocals at 44.1 kHz through `normalizeLoudness` (`src/wav.ts`). Failure is `SeparationError` (`502 speech_error`), never a fallback to the unseparated sample.
- Speech has its own single-slot queue and never holds the translation queue; both may use the GPU at once.
- `POST /speech`: one utterance, at most 1,000 characters, only `zh`, `en`, `ja`, `es`, `ar` (others come out as noise). The voice id must be one `voices()` lists, never used to build a path otherwise. Markdown handling and sentence splitting are the client's (`public/speech-text.ts`), whose language list must match `SPEECH_LANGUAGES` in `src/speech.ts`.

## Configuration

Every setting is an environment variable with a lowercase-dashed flag that wins (`PORT` / `--port`);
defaults in `src/config.ts`, whose `SETTING_NAMES` lists them, so a new one goes there too. Unknown
arguments fail startup. Non-obvious ones:

- `ALLOWED_ORIGINS`: `scheme://host[:port]` or `scheme://*.host[:port]` (subdomains only); no bare `*`, no path (`src/access.ts`). `ALLOWED_HOSTS`: extra `Host` names, needed when `HOST` is `0.0.0.0` or `::`
- `GPU_LAYERS`: `all`, a count, or `0` for CPU. `SPEECH=0`: reading aloud unavailable, libaudiocpp never loaded. `SPEECH_IDLE_UNLOAD=0`: never unload. `SPEECH_BACKEND=cpu` is far slower than real time
- `SPEECH_MODEL_DIR` / `SEPARATION_MODEL_DIR` hold one GGUF each; no separation model means no separation. `VOICES_DIR` holds one `*.wav` per voice

## API

Spec: `docs/openapi.yaml` (served at `/api/v1/openapi.yaml`). After editing it run `bun run gen:api`: `src/api-schema.d.ts` (committed, generated, excluded from lint and format; CI fails when stale) holds its types, `src/api.ts` names them. The server builds every response as its schema's type (`json<T>(…)`, `emit(event, data)` in `src/app.ts`) and `public/` and the tests read bodies as these types, so a spec change shows up as a type error; no `any` crosses the API. `test/api-contract.test.ts` and `test/openapi.test.ts` keep only what types cannot say; do not re-add a test that the types already enforce.

- `POST /translate` takes `text` or `image` (`text` then only a hint, `genre` refused); the image does not count towards the 4 MiB body limit (`parseBody`). `POST /tokenize` never queues or swaps. `POST /speech` answers WAV, or with `Accept: audio/ogg` or `audio/qoa` (named, not `*/*`; the heavier weight first, Opus on a tie) an Ogg Opus or a QOA stream; speed is `duration_factor` = 1/speed, range 0.5 to 2. `POST /voices` limits: `validateSample` in `src/speech.ts`.

## Models

- `index-translate-9b` (chat): any language; glossary, constraints, genre; images through its mmproj (Q8_0).
- `index-nailong-9b` (NativeLong document): `zh-en`, `en-zh`, `zh-ja`, `ja-zh` only; `source_lang` required; glossary, constraints, genre rejected.

Both Q6_K, about 9.3 GiB VRAM and 70 tokens/s. Speech adds about 5 GiB after the first utterance. The
separation GGUF embeds only a legacy spec, hence `AUDIOCPP_DEPLOYMENT_BUILD=ON`.

Limits: audio.cpp does not normalize digits in Japanese (`speech-text.ts` writes them in kanji) or Arabic
(garbled); German produced noise. NativeLong zh→en loses paragraph markers at full length (cause
unknown), so the client verifies them. Chat en→zh loses or repeats paragraphs by about 16K letters.

## Notes for changes

- UI changes keep `A11Y-ACCEPTANCE.md` (WCAG 2.2 AA) true and `e2e/a11y.spec.ts` green. CSS may use only what `.browserslistrc` supports. Click-to-sync has no keyboard route (A11Y-13 FAIL). Anything that scrolls must be focusable while it overflows (`public/scroll-focus.ts`).
- The web app must keep working with the server's error codes (`public/errors.ts`) and the paragraph-loss check (`public/paragraphs.ts`).
- README.md is for user-visible behaviour only.

### Web app

- **Markdown**: output renders as Markdown only when the *source* passes `looksLikeMarkdown`. The parser is pure and prefix-stable (a block never changes once a later complete line starts another), which `MarkdownStream` relies on to rebuild only the open tail. Elements are built with the DOM API, never `innerHTML`; links limited to `http(s):` and `mailto:`. Copy and the paragraph check use the raw text. Top-level rendered elements carry `data-line`. Parser changes keep `bun scripts/commonmark.ts` passing and `docs/markdown-conformance.md` in step.
- **Link check** (`links.ts`, `checkLinks` in `markdown-dom.ts`): after a finished translation of a Markdown source, an output link target not in the source is disabled, one not in the paired block (`alignBlocks`) is marked a mismatch; re-applied when the view is rebuilt. Clicking a link opens a modal `<dialog>` (`link-dialog.ts`), with "Open anyway" for flagged ones.
- **Layout**: text box, source preview and translation share one height (`--pane-height`). Switches, Clear and Copy are always shown, `aria-disabled` when idle. `#meta` is the one status line (errors `role="alert"`); warnings go in `#notes`. One width breakpoint, 54rem: from it two columns; below it (`css/phone.css`) one column, `--pane-height` is `calc(100svh - 12rem)` (fixed because iOS Safari's floating toolbar overlays the page), and model buttons show short names (`span.long` / `span.short`; a new model button needs both).
- **CJK typography** is `:lang(ja)` / `:lang(zh)` in `css/cjk.css`, so the textarea, source preview and output must carry the `lang` of their text (`setLang` in `app.ts`).
- **Click-to-sync scrolling** (`sync-scroll.ts`): only after a translation that finished with `stop` and whose block count (`alignBlocks`) equals the source's, while both are unchanged.
- **History** (`history.ts`): `localStorage` only; the server must never learn of it.
- **Resuming** (`resume.ts`): iOS cuts the SSE connection when the page leaves the screen. The page always asks for `resumable: true` and reconnects after the last event id seen. Stop also sends `DELETE`.
- **Service worker** (`sw.ts`, `pwa.ts`): stale-while-revalidate for same-origin GETs except `/api/` and `/__dev/`. Bump `CACHE` to drop old caches.
- **Reading aloud** (`speech-text.ts` pure, `speech-buffer.ts` audio, `speech.ts` player, `speech-ui.ts` page side): one side at a time. `speechSegments` builds utterances from `parseLines` for Markdown-shown text (never the raw text), line by line otherwise, packed into pieces of whole sentences (`Intl.Segmenter`; 180 characters, 60 for zh/ja) carrying their block's `data-line`. The buffer keeps one request in flight and aborts one whose piece left the plan; voice or speed changes empty it. One `AudioContext` created in the click; pause is `suspend()`. A new translation, Clear, switching the source to Raw or changing From stops the reading.
  - **Read-from gutter** (`read-gutter.ts`): Read aloud is an `aria-pressed` toggle that starts nothing: it shows a column of "Read from: …" buttons, one per spoken block, and moves focus there; released, it hides the column and stops. The source is read only from Preview. The buttons live in the scroller, not the view (no `data-line` on them; Copy and `MarkdownStream` work on the view), a vertical APG toolbar with one tab stop. Targets are ≥ 24 px (2.5.8), not 44: one-line blocks are shorter.
- **Opus stream** (`public/opus.ts`, `src/opus-stream.ts`): the page probes once whether `OfflineAudioContext.decodeAudioData` decodes an embedded Ogg Opus file (not `canPlayType`, which answers for `<audio>`) and, if so, sends `Accept: audio/ogg, audio/qoa;q=0.8, audio/wav;q=0.5`; an Opus answer is the file, handed to the player like a WAV. The server resamples the engine's audio to 48 kHz mono with libsoxr (`resample.ts`, `soxr_oneshot` on the main thread), encodes it with minicelt (CELT, 20 ms, VBR, 64 kbit/s, no DTX) and muxes it with `ogg-opus.ts` (ported from libopus-wasm). minicelt's WASM holds one static encoder, so every response instantiates the compiled module itself. Pre-skip is the encoder's lookahead in 48 kHz samples and the last packet's `validDuration` cuts the padding, so the decoded length equals the audio's (e2e checks it). The loader (`opusLoader`) answers undefined when `vendor/minicelt` is missing, so the next format or WAV is sent. e2e's mock server points `audioDir` at the real `vendor/audio.cpp` only so that `vendor/soxr` and `vendor/minicelt` are found; tests that want QOA remove `OfflineAudioContext` (`withoutOpus`). Changing the minicelt pin: the exports are those of `wasm/src/lib.rs`; recheck `FRAME` (960) and the 48 kHz input.
- **QOA stream** (`qoa.ts`, `qoa-worker.ts`, codec in `public/vendor/qoa/`): the page sends `Accept: audio/qoa, audio/wav;q=0.5` and goes by the answer's `Content-Type`; the server falls back to WAV when the codec is missing (`qoaLoader`; a miss is not remembered). Decoding runs in a module worker (the CSP has no `wasm-unsafe-eval`). The page falls back to WAV for its life when the codec cannot load or a stream fails to decode (`QoaError`).
- **Image as the source** (`open-ui.ts` `openImage`, `app.ts` `sourceImage`): drawn on a `<canvas role="img">` where the text box is (the CSP allows no `blob:` or `data:` picture); translate sends it to the chat model whatever the model choice (`buildImageRequest`). No Markdown, paragraph check, sync or history entry. Whatever puts a text in the box (`loadSource`, a restored entry) takes the image away.
- **Opening files and PDF** (`open-file.ts`, `open-ui.ts`, `pdf.ts`, `pdf-worker.ts`, `elements/pdf-pages.ts`): browser-only like history; the server only serves the libraries. Text enters through `loadSource(text, preview)`, which Clear also uses. An empty PDF page (a scan) leaves the box alone; `pagesNeedingOcr` or U+FFFD text loads with a warning (`pageNote`). A later pick wins (`turn`), and a result arriving after a translation started is dropped.
  - Libraries are bundled, not from a CDN (offline by design, CSP `default-src 'self'`), pinned by checksum in `fetch_web_libs.ts`; when missing, `pdfInstalled()` hides PDF. pdf-inspector is synchronous, hence one worker per document.
  - Chromium 141 hit a V8 OOM compiling pdf-inspector's WebAssembly on a large PDF; e2e pins Playwright `~1.64.0` (Chromium 156): bump deliberately.
  - pdf-inspector 1.25.2: CJK in non-embedded fonts naming a predefined CMap comes out as U+FFFD (page 3 of `sample.pdf`, used by `e2e/open.spec.ts`'s warning test); two-column pages may be misordered; password-protected files are refused.
- **Word documents** (`docx.ts`, `docx-worker.ts`): `.docx` only, read by undoc into the box as Markdown with `preview`. The library is the `undoc` orphan branch of this repository (wasm-pack `--target web` output of `undoc-wasm`, `--no-default-features --features docx`, from ruihe774/undoc@393af42). One worker per document. Errors carry undoc's numeric `kind` (`docxFailure` in `open-file.ts`). Rebuilding: commit the output on that branch, then update `UNDOC_COMMIT`, the checksums and `UNDOC_SNIPPET` in `fetch_web_libs.ts`, and the notices if the crate list changed.

### Engine and packaging

- Changing the audio.cpp pin (`TAG`, `COMMIT` in `build_audiocpp.ts`) or the speech GGUF: check `src/audiocpp-ffi.ts` signatures and both struct layouts against the new `audiocpp.h` by hand; the library still exports only `audiocpp_*`; `audiocpp-abort.patch` applies and its three checks still sit in the loops (`gpt.cpp`, `s2mel.cpp`, `session.cpp`) and upstream added no abort; an utterance aborted early, mid and late stops within tens of milliseconds. No test uses the real speech library.
- Changing the llama.cpp pin (`TAG`, `COMMIT` in `build_llama.ts`): check `src/llama-ffi.ts` signatures against the new `llama.h` and `mtmd.h` by hand and the CMake options; libmtmd's API is unstable, so read what the shim calls, check that `libmtmd` still exports `stbi_load_from_memory`, that `engineSize` (`src/image.ts`) still equals `calc_size_preserved_ratio` and the projector's branch in `clip.cpp` (`test/image.test.ts` lists known sizes), and translate an opaque, a transparent and a full-size image; rerun the long-document check. After editing `llama-shim.c`: `bun scripts/build_llama.ts --shim`, and declare new functions in `llama-ffi.ts`.
- `packaging/bunfig.toml` is Bun's config for both packages (`env = false`, `telemetry = false`); new Bun flags go there, except `--disallow-code-generation-from-strings=strict`, which bunfig cannot express and which `AppRun`, `launcher.c` and the installer's smoke test pass explicitly.
- Builds that leave this machine (AppImage) must not be `--native`.
- AppImage (`build_appimage.ts`, `packaging/appimage/`): the AppDir holds Bun and the repository layout in `usr/share/index-translator`; a new top-level directory the server reads must be added to the script. No system libraries are packed. `AppRun` deliberately leaves `LD_LIBRARY_PATH` unset (the browser is started from this process). A new `APPIMAGETOOL` or `RUNTIME` needs a new URL and checksum; the runtime must stay the static one.
- CI (`.github/workflows/ci.yml`): `BUN_VERSION` there is the Bun that ships. Nothing in CI runs a model.
- Third-party notices: `THIRD_PARTY_NOTICES.md`. `fetch` (`acceptNotices` in `fetch_models.ts`) prints `NOTICES[id]` and needs "yes" on stdin; there is deliberately no bypass flag. A new pin, library or model means checking its license and updating the markdown, `NOTICES` and `AppRun`; a test keeps them in step.
