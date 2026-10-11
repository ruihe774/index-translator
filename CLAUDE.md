# CLAUDE.md

Local translation app. One Bun process serves the REST/SSE API and the static web app, and runs
llama.cpp in-process (libllama through `bun:ffi`, Vulkan) on a worker thread that holds one model
at a time. User-facing docs: README.md.

## Commands

Dev tools (TypeScript, `@types/bun`, Playwright, doiuse, postcss) come from `node_modules`. Run
`bun install` before `typecheck`, `lint:css` or `e2e` whenever `node_modules` is missing or stale.
`bun --install=…` / `-i` do not fetch them for `bun run` scripts, so the plain install step is required.

- Run: `bun src/server.ts` (http://127.0.0.1:3000)
- Test: `bun test` (API tests use a mock engine; no GPU needed)
- Typecheck: `bun run typecheck`
- Frontend e2e/integration/a11y: `bun run e2e` (Playwright, mock engine; see `e2e/README.md`; `bunx playwright install chromium` or `CHROMIUM_PATH`)
- Lint and format: `bun run check` (Biome, recommended rules; `bun run format` writes). Errors must stay at zero; the style warnings (`noNonNullAssertion`, `noExplicitAny`, `useTemplate`) are tolerated
- CSS browser-support check: `bun run lint:css` (doiuse against `.browserslistrc`)
- Setup: `bun scripts/fetch_llama.ts` (vendor/llama.cpp with the tag's headers in `include/`, checksums verified); `uv run scripts/fetch_models.py` (models/, about 14 GiB)
- Markdown conformance: `bun scripts/commonmark.ts` (CommonMark spec examples against `public/markdown.ts`; divergences in `docs/markdown-conformance.md`)
- Long-document check: `MODEL=index-nailong-9b bun scripts/longtext.ts http://127.0.0.1:3000`

No npm runtime dependencies; no build step for the web app.

## Layout

- `src/server.ts`: entry point, signal handling (SIGINT/SIGTERM stop the child)
- `src/open-browser.ts`: opens the default browser (`xdg-open`/`open`/`start`)
- `src/app.ts`: routes, model selection, SSE, static files
- `src/llama.ts`: engine state (one model at a time), token counting, streamed generation; server-thread side of the engine worker
- `src/llama-worker.ts`: worker thread that owns libllama; loads, unloads and generations run in arrival order
- `src/llama-ffi.ts`: `bun:ffi` bindings (blocking), ChatML prompt, tokenize/decode/sample
- `src/llama-shim.c`: the calls that pass structs by value and the log filter; compiled at startup by `bun:ffi`'s `cc` (TinyCC) against `vendor/llama.cpp/include/llama.h`
- `src/models.ts`: model registry (ids, files, kinds, document directions)
- `src/prompt.ts`: chat prompts, NativeLong document prompts, language table
- `src/queue.ts`: single-slot FIFO
- `src/static.ts`: static files; `.ts` in `public/` transpiled on request, ETag-cached in memory, never written to disk
- `public/`: web app (`app.ts`, `select-model.ts`, `request.ts`, `sse.ts`, `messages.ts`, `errors.ts`, `paragraphs.ts`, `glossary.ts`, `markdown.ts`, `markdown-dom.ts`, `sync-scroll.ts`, `style.css`)
- `prompts/`: the four official NativeLong templates (from bilibili/Index-Translate)
- `scripts/`: fetch and test helpers
- `e2e/`: Playwright specs (`a11y.spec.ts`: axe and WCAG layout checks), `mock-server.ts` (real app on the `test/helpers/mock-engine.ts` mock, scriptable via a control port)
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
- The engine shares the server's process: a crash inside llama.cpp takes the server down, and any
  exit, `SIGKILL` included, releases the VRAM.

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
| `OPEN_BROWSER` | on | Opens the web app in the default browser at startup; `0` disables. Wildcard `HOST` opens `127.0.0.1` |

## API

Spec: `docs/openapi.yaml`. Endpoints:

- `POST /api/v1/translate`: JSON, or SSE with `stream: true`
- `POST /api/v1/tokenize`: token count and budget; never queues or swaps; `503` while no model is ready
- `GET /api/v1/models`: models, default, loaded one
- `GET /api/v1/languages`: codes with short forms
- `GET /api/v1/health`: engine state, loaded model, limits, queue

## Models

| id | Kind | Notes |
|---|---|---|
| `index-translate-9b` | chat | Any language; glossary, constraints, genre |
| `index-nailong-9b` | document (NativeLong) | Directions `zh-en`, `en-zh`, `zh-ja`, `ja-zh` only; `source_lang` required; glossary, constraints, genre rejected |

Both are Q6_K GGUF files. Measured on RX 9070 (16 GiB, RADV), llama.cpp `b11552`, 65,536 context:
about 9,300 MiB VRAM for the chat model (the NativeLong model was not sampled); about 70 tokens/s
generation for both; 4,400-token prompt read in under 2 s; model load or swap about 2 s with the
file in the page cache. Output, token counts and speed match `llama-server` of the same build.

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
- Link check (`public/links.ts`, DOM part `checkLinks` in `public/markdown-dom.ts`): after a finished translation of a Markdown source, each output link target is checked against the source. Not found in the source text: the link is disabled (no `href`, `role="link"`, `aria-disabled`, struck through). Found, but not among the targets of the source block that `alignBlocks` pairs with the output block, or the blocks do not pair up: marked in `--error` with a dashed rule. Both carry a title and an `sr-only` note. Applied after the last `output.finish()` (which rebuilds the open tail and would drop the marks) and re-applied when the output view is rebuilt. Clicking any output link first opens a modal `<dialog>` (`public/link-dialog.ts`, wording from `linkPrompt`): a link that passed the check (`data-link-paired`) gets the plain text, any other (mismatch, or the check has not run) the warning text with "Open anyway"; confirming calls `window.open` with `noopener,noreferrer`; not covered by `A11Y-ACCEPTANCE.md` yet.
- Layout: the text box, the source preview and the translation share one height (`--pane-height`), so the panes line up and switching Raw/Preview shifts nothing; the text box does not resize. Under each panel's text area comes its button row (the translation panel: the `#meta` line and Copy). The Raw/Preview switches, Clear and Copy are always shown and `aria-disabled` when they have nothing to act on (source switch and Clear: text in the box; Clear also while a result is on screen; output switch and Copy: output present, Copy also not while running). Source Preview renders Markdown only when the text looks like it, else plain lines. All gaps (panel padding, rows, buttons) are `--gap`. `#meta` is the one status line of the translation panel, one line that scrolls sideways (focusable only while it overflows): progress while running, then the result numbers, or the stop/error text, or briefly the copy confirmation; errors are styled and `role="alert"`. Warnings after a finished translation stay in `#notes` below the button row (up to three: output limit, paragraph mismatch, zh→en loss), which is absent when empty. Stop replaces Clear while a translation runs (never both), and the three buttons share one width. Disabled (`aria-disabled`) buttons have no hover style. The model switch (Automatic / Index-Translate-9B / Index-NativeLong-9B) is a button group like Raw/Preview; only warnings (`adviceMessage`) are shown under the source, the model in use is named in the status line. The engine status in the header links to `/api/v1/health`.
- Japanese and Chinese typography (jlreq, clreq) is done in CSS by `:lang(ja)` / `:lang(zh)` in `public/style.css`, so the textarea, the source preview and the output must carry the `lang` of their text (`setLang` in `public/app.ts`; source: the selected language or `detectSource`, output: the target). Covered: per-language font stacks (no Chinese glyph forms for Japanese), `line-break: strict` (kinsoku), `text-autospace: normal` (Chrome's initial value is `no-autospace`), `text-spacing-trim: trim-start` (Chrome only). Left out on purpose because the documents only recommend them: justification, paragraph indent, line height, emphasis marks, hanging punctuation (Safari only), `text-justify` (not in Safari). Not possible from `zh` alone: Simplified vs Traditional glyph forms and punctuation placement.
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
- Changing the llama.cpp tag (`scripts/fetch_llama.ts`): update the header checksums, and check the
  signatures declared in `src/llama-ffi.ts` against the new `llama.h` by hand, since only
  `src/llama-shim.c` is compiled against it. The shim needs the system's C library headers
  (`stdio.h`) at startup. Then compare output with `llama-server` of that build and rerun the
  long-document check.
- Update `docs/openapi.yaml` and the tests in `test/api-contract.test.ts` / `test/openapi.test.ts` when the API changes.
- Update README.md for user-visible behaviour only; keep developer detail here.
