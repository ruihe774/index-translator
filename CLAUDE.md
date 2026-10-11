# CLAUDE.md

Local translation app. One Bun process serves the REST/SSE API and the static web app, and runs
llama.cpp in-process (libllama through `bun:ffi`, Vulkan) on a worker thread that holds one model
at a time. Reading aloud (IndexTTS-2.5) runs in the same process too: audio.cpp's C API
(libaudiocpp, built from source) through `bun:ffi` on a second worker thread. User-facing docs:
README.md.

## Commands

Dev tools (TypeScript, `@types/bun`, Playwright, doiuse, postcss) come from `node_modules`. Run
`bun install` before `typecheck`, `lint:css` or `e2e` whenever `node_modules` is missing or stale.
`bun --install=…` / `-i` do not fetch them for `bun run` scripts, so the plain install step is required.

- Run: `bun src/server.ts` (http://127.0.0.1:3000)
- Dev: `bun run dev` (`bun --watch` restarts the process on backend changes, `DEV_RELOAD=1` makes open pages reload on `public/` changes and after a restart; `OPEN_BROWSER=0`; each restart reloads the model)
- Test: `bun test` (API tests use a mock engine; no GPU needed)
- Typecheck: `bun run typecheck`
- Frontend e2e/integration/a11y: `bun run e2e` (Playwright, mock engine; see `e2e/README.md`; `bunx playwright install chromium` or `CHROMIUM_PATH`)
- Lint and format: `bun run check` (Biome, recommended rules; `bun run format` writes). Errors must stay at zero; the style warnings (`noNonNullAssertion`, `noExplicitAny`, `useTemplate`) are tolerated
- CSS browser-support check: `bun run lint:css` (doiuse against `.browserslistrc`)
- Setup: `bun scripts/fetch_llama.ts` (vendor/llama.cpp with the tag's headers in `include/`, checksums verified); `bun scripts/build_audiocpp.ts` (vendor/audio.cpp: `libaudiocpp.so` built from the pinned commit, about 1 min of compiling on 20 threads; needs git, cmake, a C++ compiler, glslc, libvulkan-dev, spirv-headers; AVX2 code unless `--native`; `--keep` keeps the build tree in `vendor/.build/`); `uv run scripts/fetch_models.py` (models/, about 17.5 GiB with the 3.5 GB speech model, and the example voices into voices/)
- Markdown conformance: `bun scripts/commonmark.ts` (CommonMark spec examples against `public/markdown.ts`; divergences in `docs/markdown-conformance.md`)
- Long-document check: `MODEL=index-nailong-9b bun scripts/longtext.ts http://127.0.0.1:3000`

No npm runtime dependencies; no build step for the web app.

## Layout

- `src/server.ts`: entry point, signal handling (SIGINT/SIGTERM free the models and stop)
- `src/open-browser.ts`: opens the default browser (`xdg-open`/`open`/`start`)
- `src/app.ts`: routes, model selection, SSE, static files
- `src/llama.ts`: engine state (one model at a time), token counting, streamed generation; server-thread side of the engine worker
- `src/llama-worker.ts`: worker thread that owns libllama; loads, unloads and generations run in arrival order
- `src/llama-ffi.ts`: `bun:ffi` bindings (blocking), ChatML prompt, tokenize/decode/sample
- `src/llama-shim.c`: the calls that pass structs by value and the log filter; compiled at startup by `bun:ffi`'s `cc` (TinyCC) against `vendor/llama.cpp/include/llama.h`
- `src/models.ts`: model registry (ids, files, kinds, document directions)
- `src/prompt.ts`: chat prompts, NativeLong document prompts, language table
- `src/speech.ts`: the speech engine's state, lazy load and idle unload, voices from `VOICES_DIR`; server-thread side of the speech worker
- `src/speech-worker.ts`: worker thread that owns libaudiocpp; loads, unloads and utterances run in arrival order, each to its end
- `src/audiocpp-ffi.ts`: `bun:ffi` bindings (blocking) to audio.cpp's C API (`vendor/audio.cpp/include/audiocpp.h`); no C shim, the two config structs are written into buffers
- `src/wav.ts`: WAV decoding (voice recordings: PCM 8 to 32 bits, float 32/64) and 16-bit PCM writing
- `src/queue.ts`: single-slot FIFO
- `src/static.ts`: static files; `.ts` in `public/` transpiled on request, ETag-cached in memory, never written to disk
- `public/`: web app (`app.ts`, `select-model.ts`, `request.ts`, `sse.ts`, `messages.ts`, `errors.ts`, `paragraphs.ts`, `glossary.ts`, `markdown.ts`, `markdown-dom.ts`, `sync-scroll.ts`, `speech-text.ts`, `speech.ts`, `style.css`)
- `prompts/`: the four official NativeLong templates (from bilibili/Index-Translate)
- `scripts/`: fetch and test helpers
- `e2e/`: Playwright specs (`a11y.spec.ts`: axe and WCAG layout checks; `speech.spec.ts`: reading aloud), `mock-server.ts` (real app on the `test/helpers/mock-engine.ts` mocks of both engines, scriptable via a control port)
- `test/`: `bun test`; `test/fixtures/essays.en.txt` is the long-input fixture (30 paragraphs, 16,566 letters)
- `docs/openapi.yaml`: API spec, served at `/api/v1/openapi.yaml`

## Invariants

- The backend never picks a model from the text. The client does (`public/select-model.ts`).
- Model choice by length: `LONG_THRESHOLD_LETTERS = 11_000` in `public/select-model.ts`. Keep the
  web app and any docs in sync with it.
- A model swap frees the loaded model and loads the other. Repeated requests for the loaded model do not reload it.
- libllama is only called from the worker thread; every call blocks it. A generation returns to the
  worker's event loop after each decode, which is when `/tokenize` counts and cancellations are handled.
- The prompt is written by `chatPrompt` (`src/llama-ffi.ts`), not by the model's Jinja template:
  ChatML, content trimmed, empty think block. It must stay token-identical to what the template
  renders with `enable_thinking=false`; a model whose template is not ChatML fails to load.
- Generation is greedy (temperature 0) and starts from an empty context every time.
- One generation at a time; up to `MAX_QUEUE` wait FIFO, beyond that `429 queue_full`.
- Closing the client connection cancels the generation.
- `MAX_INPUT_TOKENS + 64 < CTX_SIZE`, otherwise startup fails.
- Output is capped at 4 × prompt tokens + 512 unless `max_output_tokens` is set, so loops stop.
- No authentication. Keep `HOST` on loopback or behind a proxy. `ALLOWED_ORIGINS` and
  `ALLOWED_HOSTS` control browser and proxy access.
- Both engines share the server's process: a crash inside llama.cpp or audio.cpp takes the server
  down, and any exit, `SIGKILL` included, releases the VRAM.
- libaudiocpp is only called from the speech worker thread, which is started by the first
  `POST /speech` (never at startup). The model is loaded by that request and freed after
  `SPEECH_IDLE_UNLOAD` seconds without one (timer in `src/speech.ts`; state back to `stopped`);
  the next request loads it again. A failed load is retried by the next request.
- libaudiocpp must have its ggml linked in statically with only `audiocpp_*` exported, which is
  what `scripts/build_audiocpp.ts` builds. audio.cpp's ggml is a fork (0.12, own ops) with the
  same SONAME `libggml.so.0` as llama.cpp's: a build with shared ggml libraries binds to the one
  libllama loaded and dies with an undefined symbol, or alone finds no backend because it looks
  for them beside the `bun` executable.
- An utterance cannot be stopped: the C API has no abort. A request whose client goes away is
  answered at once and leaves its queue slot; the worker finishes the utterance, which nobody
  receives, and the next one waits behind it (a few seconds at most, given the client's pieces).
- Speech has its own single-slot queue (`MAX_QUEUE` waiting) and never holds the translation
  queue: a translation and a synthesis may run on the GPU at the same time.
- `POST /speech` speaks the text as given: one request, one utterance, at most 1,000 characters,
  only `zh`, `en`, `ja`, `es`, `ar` (other languages come out as noise, so they are refused). The
  voice id must be one that `voices()` lists; it is never used to build a path otherwise.
  Markdown handling and sentence splitting are the client's (`public/speech-text.ts`), whose
  language list must match `SPEECH_LANGUAGES` in `src/speech.ts`.

## Configuration

Environment variables, all optional. Defaults in `src/config.ts`.

| Variable | Default | Notes |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `3000` | |
| `ALLOWED_ORIGINS` | empty | Browser origins allowed to call the API cross-origin |
| `ALLOWED_HOSTS` | empty | Extra `Host` header names, needed when `HOST` is `0.0.0.0` or `::` |
| `MODELS_DIR` | `models/` | Must contain the GGUF files named in `src/models.ts` |
| `DEFAULT_MODEL` | `index-translate-9b` | Loaded at startup, used when a request names none |
| `CTX_SIZE` | `65536` | Shared by prompt and output; at least 66 |
| `MAX_INPUT_TOKENS` | `28000` | Must satisfy `MAX_INPUT_TOKENS + 64 < CTX_SIZE` |
| `MAX_QUEUE` | `8` | Requests allowed to wait |
| `GPU_LAYERS` | `all` | `all` or a layer count; `0` runs on CPU |
| `LLAMA_THREADS` | half the logical CPUs | CPU threads for decoding |
| `LLAMA_DIR` | `vendor/llama.cpp` | Holds `libllama`, the `libggml-*` backends and `include/llama.h`; headers must match the library |
| `PUBLIC_DIR` | `public/` | |
| `SPEECH` | on | `0`: reading aloud is reported as unavailable and libaudiocpp is never loaded |
| `AUDIO_DIR` | `vendor/audio.cpp` | Holds `libaudiocpp.so` (and `include/audiocpp.h` for reference); the model's spec comes from its GGUF |
| `SPEECH_MODEL_DIR` | `MODELS_DIR/IndexTTS2.5-GGUF` | Directory with the one IndexTTS-2.5 GGUF |
| `VOICES_DIR` | `voices/` | One `*.wav` reference recording per voice; read on every `GET /voices` |
| `SPEECH_BACKEND` | `vulkan` | audio.cpp backend; `cpu` works but is far slower than real time |
| `SPEECH_IDLE_UNLOAD` | `300` | Seconds without a synthesis until the speech model is unloaded; `0` never |
| `DEV_RELOAD` | off | `1`: serves `/__dev/reload` (SSE) and injects its script into HTML; development only (`src/dev-reload.ts`, `src/dev-watch.ts`) |
| `OPEN_BROWSER` | on | Opens the web app in the default browser at startup; `0` disables. Wildcard `HOST` opens `127.0.0.1` |

## API

Spec: `docs/openapi.yaml`. Endpoints:

- `POST /api/v1/translate`: JSON, or SSE with `stream: true`
- `POST /api/v1/tokenize`: token count and budget; never queues or swaps; `503` while no model is ready
- `GET /api/v1/models`: models, default, loaded one
- `GET /api/v1/languages`: codes with short forms
- `GET /api/v1/health`: engine state, loaded model, limits, queue, speech engine state
- `POST /api/v1/speech`: `{ text, lang, voice?, speed? }` to one WAV (22.05 kHz mono); `503 speech_unavailable` when not installed, `502 speech_error`
- `GET /api/v1/voices`: speech state, voices, languages, speed range, text limit

## Models

| id | Kind | Notes |
|---|---|---|
| `index-translate-9b` | chat | Any language; glossary, constraints, genre |
| `index-nailong-9b` | document (NativeLong) | Directions `zh-en`, `en-zh`, `zh-ja`, `ja-zh` only; `source_lang` required; glossary, constraints, genre rejected |

Both are Q6_K GGUF files. Measured on RX 9070 (16 GiB, RADV), llama.cpp `b11552`, 65,536 context:
about 9,300 MiB VRAM for the chat model (the NativeLong model was not sampled); about 70 tokens/s
generation for both; 4,400-token prompt read in under 2 s; model load or swap about 2 s with the
file in the page cache. Output, token counts and speed match `llama-server` of the same build.

Speech: IndexTTS-2.5 as `index-tts2_5-q8_0.gguf` from `audio-cpp/audio.cpp-gguf` (a community
conversion; the official release is PyTorch and names NVIDIA only), run by audio.cpp `v0.9.1`
(family `index_tts2`, the only family compiled into our libaudiocpp). Measured in-process on the
same card: about 2,600 MiB VRAM after the load and 5,100 after the first utterance (15,000 MiB
of 16,304 with the chat model, up to 15,500 once several voices have been used), back to the
chat model's 9,900 half a second after the idle unload; model load about 5 s; then about 0.3 of
real time (a 3.9 s sentence in 1.2 s). A translation and utterances at the same time share the
GPU: about 57 tokens/s instead of 71, and 0.6 of real time instead of 0.3; the release's
`audiocpp_server` as a child process measured the same in every respect, so being in-process
costs and gains no speed. Speed is the model's `duration_factor` (1/speed), range 0.5 to 2.
The C API's output equals that of `audiocpp_cli` built from the same tree to 16-bit rounding;
the AVX2 and `--native` builds give the same samples, the release binaries slightly different
ones (3.59 s instead of 3.87 s for one sentence). With the same seed a sentence sounds the same
again, except that a voice's first use after another voice differs once from its later uses
(the release server does the same). Output of the release build transcribed back with Qwen3-ASR
matched the text for zh, en, ja, es and ar; our own build was checked for parity with the CLI
and for all five languages producing audio, not transcribed or listened to. Not
normalized by audio.cpp: digits in Japanese ("2026年" was read "二十二年年"; `speech-text.ts`
writes them in kanji first) and in Arabic (garbled, not handled). German input produced noise.

## Known model limits

Measured with `test/fixtures/essays.en.txt`:

- **NativeLong, en→zh, whole document** (30/30 paragraphs, 4,472 prompt tokens): complete, 57 s.
- **NativeLong, zh→en**: not reliable at full length. 1–15 (3.1K chars), 1–22 (4.5K), and 23–30
  (1.6K) pass. All 30 (6.1K chars, 3,805 tokens) lost markers for paragraphs 17–27 and condensed
  to about 2,300 words from about 3,600, with `finish_reason: stop`. Cause not isolated: length
  alone does not trigger it (22 paragraphs pass), nor does any single paragraph. Verify paragraph
  markers on the client for zh→en document output.
- **Translate, en→zh**: first 15 paragraphs (8.3K letters) and first 20 (11.1K) complete; all 30
  (16.6K) lost 11 paragraphs and repeated 2 with `finish_reason: stop`. The limit lies between
  11.1K and 16.6K, unmeasured further. The same failure happens in the reference PyTorch 2B
  sibling and on CPU, so it is a model property. "Translate everything" constraints made it loop.

Hence the 11,000-letter switch point.

## Notes for changes

- UI changes keep `A11Y-ACCEPTANCE.md` (WCAG 2.2 AA) true: update the affected rows and keep `e2e/a11y.spec.ts` green. The stylesheet may use features that all browsers in `.browserslistrc` support; `bun run lint:css` enforces it.

- The web app must keep working with the server's error codes (`public/errors.ts`) and the paragraph-loss check (`public/paragraphs.ts`, counted in the source's own unit).
- Markdown output: the web app renders the output as Markdown only when the *source* passes
  `looksLikeMarkdown` (`public/markdown.ts`); otherwise it stays plain text. The parser is pure and
  must stay prefix-stable (a block never changes once a later complete line starts another), which
  `MarkdownStream` relies on to append finished blocks once and rebuild only the open tail per
  frame (`public/markdown-dom.ts`). Elements are built with the DOM API, never `innerHTML`; links
  are limited to `http(s):` and `mailto:`. Copy and the paragraph check use the raw text. Parser
  changes keep `bun scripts/commonmark.ts` passing and `docs/markdown-conformance.md` in step. The
  rendered output's accessibility review is still pending (not yet in `A11Y-ACCEPTANCE.md`).
- Link check (`public/links.ts`, DOM part `checkLinks` in `public/markdown-dom.ts`): after a finished translation of a Markdown source, each output link target is checked against the source. Not found in the source text: the link is disabled (no `href`, `role="link"`, `aria-disabled`, struck through). Found, but not among the targets of the source block that `alignBlocks` pairs with the output block, or the blocks do not pair up: marked in `--error` with a dashed rule. Both carry a title and an `sr-only` note. Applied after the last `output.finish()` (which rebuilds the open tail and would drop the marks) and re-applied when the output view is rebuilt. Clicking any output link first opens a modal `<dialog>` (`public/link-dialog.ts`, wording from `linkPrompt`): a link that passed the check (`data-link-paired`) gets the plain text, any other (mismatch, or the check has not run) the warning text with "Open anyway"; confirming calls `window.open` with `noopener,noreferrer`; reviewed in `A11Y-ACCEPTANCE.md` (screen reader not run).
- Layout: the text box, the source preview and the translation share one height (`--pane-height`), so the panes line up and switching Raw/Preview shifts nothing; the text box does not resize. Under each panel's text area comes its button row (the translation panel: the `#meta` line and Copy). The Raw/Preview switches, Clear and Copy are always shown and `aria-disabled` when they have nothing to act on (source switch and Clear: text in the box; Clear also while a result is on screen; output switch and Copy: output present, Copy also not while running). Source Preview renders Markdown only when the text looks like it, else plain lines. All gaps (panel padding, rows, buttons) are `--gap`. `#meta` is the one status line of the translation panel, one line that scrolls sideways (focusable only while it overflows): progress while running, then the result numbers, or the stop/error text, or briefly the copy confirmation; errors are styled and `role="alert"`. Warnings after a finished translation stay in `#notes` below the button row (up to three: output limit, paragraph mismatch, zh→en loss), which is absent when empty. Stop replaces Clear while a translation runs (never both), and the three buttons share one width. Disabled (`aria-disabled`) buttons have no hover style. The model switch (Automatic / Index-Translate-9B / Index-NativeLong-9B) is a button group like Raw/Preview; only warnings (`adviceMessage`) are shown under the source, the model in use is named in the status line. The engine status in the header links to `/api/v1/health`.
- Japanese and Chinese typography (jlreq, clreq) is done in CSS by `:lang(ja)` / `:lang(zh)` in `public/style.css`, so the textarea, the source preview and the output must carry the `lang` of their text (`setLang` in `public/app.ts`; source: the selected language or `detectSource`, output: the target). Covered: per-language font stacks (no Chinese glyph forms for Japanese), `line-break: strict` (kinsoku), `text-autospace: normal` (Chrome's initial value is `no-autospace`), `text-spacing-trim: trim-start` (Chrome only). Left out on purpose because the documents only recommend them: justification, paragraph indent, line height, emphasis marks, hanging punctuation (Safari only), `text-justify` (not in Safari). Punctuation shared with Latin (U+00B7, U+2014, U+2018/2019, U+201C/201D, U+2026/2027) would otherwise come from the Latin fonts first in `--font-zh`; the `Han Punctuation SC` `@font-face` (`local()` Simplified Chinese fonts, `unicode-range` limited to those code points) sits at the head of the stack so clreq's full-width forms are used (`Han Punctuation JP` does the same for `--font-ja`: U+2014/2015, U+2018/2019, U+201C/201D, U+2025/2026). Not possible from `zh` alone: Simplified vs Traditional glyph forms and punctuation placement.
- Source preview and views: after Translate, a source that passes `looksLikeMarkdown` is rendered
  (whole, not streamed) in `#source-view` in place of the textarea; each side has a Raw / Preview
  switch (source Raw is the textarea, re-rendered on Preview). Clear empties both sides and restores
  the textarea. Every top-level rendered element carries `data-line` (its first line in the text;
  plain text is one span per line).
- Click-to-sync scrolling (`public/sync-scroll.ts`) is on only after a translation that finished
  with `stop` and whose block count, in the source's unit, equals the source's (`alignBlocks` in
  `public/paragraphs.ts`), and only while the source and output text are unchanged. Block i maps to
  block i; blocks show a background on hover while sync is on; the clicked block's top is lined up on the other side, which is a scroll container
  (`--pane-max`). The raw textarea is measured with a hidden mirror element.
- The source preview, the view switches, Clear and sync scrolling have not been reviewed for
  accessibility yet (not in `A11Y-ACCEPTANCE.md`); `e2e/a11y.spec.ts` passes.
- Reading aloud (`public/speech-text.ts` pure, `public/speech.ts` player, wiring in `app.ts`): each panel's button row starts with Listen (a loudspeaker; a square, "Stop reading…", while that side is read) and, only while reading, Pause / Resume. One side is read at a time. Listen is `aria-disabled`, with the reason as `title`, when speech is unavailable, there is no text, the translation is still running, or the language is not one the model speaks (source: the selected language or `detectSource`; output: `outputEl.lang`). Starting a translation, Clear, editing the source or changing From stops the reading. `speechSegments` builds what is spoken: for a text shown as Markdown (source: `looksLikeMarkdown`; output: `views.output.available`) from `parseLines`, never the raw text (headings and list items are utterances and get a full stop, ordered items their number, table rows "header: cell" pairs, links their text, images their alt, URLs their host, code blocks and rules nothing); plain text line by line. Utterances are packed into pieces of whole sentences (`Intl.Segmenter`; 180 characters, 60 for zh/ja; a longer sentence is cut at commas), each with the `data-line` of its top-level block, which gets `.speaking` and is scrolled into its pane. The player fetches one piece at a time, the next one while the current plays, and plays through one `AudioContext` created in the click; pause is `suspend()`. Voice and speed (selects under "Model and options", stored like the languages, hidden without voices) apply from the current piece, which is fetched again. Errors flash in `#meta`. While audio is being made and none plays (`loading`: first piece, after a jump or a voice/speed change) only Stop works: Pause shows a spinner and is `aria-disabled`, as are Previous / Next. Previous / Next block (visible only while that side is read; `SpeechPlayer.jump`) go to the start of the previous or next run of pieces with the same `line` (Previous first returns to the start of the current block); the new block is shaded at once but its audio is requested only after `JUMP_SETTLE_MS` without another jump, because an utterance cannot be cancelled and abandoned requests would fill the speech queue (`429`). `#meta` says "Block n of m". The block being read carries `aria-current` as well as `.speaking`; a blocked Listen's reason is its `aria-describedby`, not only `title`. Reviewed in `A11Y-ACCEPTANCE.md` (screen reader not run).
- Changing the audio.cpp version (`TAG` and `COMMIT` in `scripts/build_audiocpp.ts`; the source is fetched by commit id, which is its checksum) or the speech GGUF (`scripts/fetch_models.py`, update the checksum): check the signatures declared in `src/audiocpp-ffi.ts` and the two struct layouts against the new `include/audiocpp.h` by hand (the build script only proves that the functions exist; the ABI major version is checked at load), that the library still exports only `audiocpp_*` and does not need `libggml*.so`, then a sentence per language by ear or by transcribing it, the `duration_factor` range, and VRAM beside the chat model. The speech engine has no test with the real library: `bun test` and `e2e` use the mock.
- Changing the llama.cpp tag (`scripts/fetch_llama.ts`): update the header checksums, and check the
  signatures declared in `src/llama-ffi.ts` against the new `llama.h` by hand, since only
  `src/llama-shim.c` is compiled against it. The shim needs the system's C library headers
  (`stdio.h`) at startup. Then compare output with `llama-server` of that build and rerun the
  long-document check.
- Update `docs/openapi.yaml` and the tests in `test/api-contract.test.ts` / `test/openapi.test.ts` when the API changes.
- Update README.md for user-visible behaviour only; keep developer detail here.
