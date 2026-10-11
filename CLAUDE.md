# CLAUDE.md

Local translation app. One Bun process serves the REST/SSE API and the static web app, and
supervises a `llama-server` child (llama.cpp, Vulkan) that holds one model at a time. User-facing
docs: README.md.

## Commands

- Run: `bun src/server.ts` (http://127.0.0.1:3000)
- Test: `bun test` (API tests use a mock engine; no GPU needed)
- Typecheck: `bun run typecheck`
- Setup: `bun scripts/fetch_llama.ts` (vendor/llama.cpp, checksum verified); `uv run scripts/fetch_models.py` (models/, about 14 GiB)
- Long-document check: `MODEL=index-nailong-9b bun scripts/longtext.ts http://127.0.0.1:3000`

No npm runtime dependencies; no build step for the web app.

## Layout

- `src/server.ts`: entry point, signal handling (SIGINT/SIGTERM stop the child)
- `src/open-browser.ts`: opens the default browser (`xdg-open`/`open`/`start`)
- `src/app.ts`: routes, model selection, SSE, static files
- `src/llama.ts`: llama-server lifecycle (one model at a time), token counting, streamed generation
- `src/models.ts`: model registry (ids, files, kinds, document directions)
- `src/prompt.ts`: chat prompts, NativeLong document prompts, language table
- `src/queue.ts`: single-slot FIFO
- `src/static.ts`: static files; `.ts` in `public/` transpiled on request, ETag-cached in memory, never written to disk
- `public/`: web app (`app.ts`, `select-model.ts`, `request.ts`, `sse.ts`, `messages.ts`, `errors.ts`, `paragraphs.ts`, `glossary.ts`, `style.css`)
- `prompts/`: the four official NativeLong templates (from bilibili/Index-Translate)
- `scripts/`: fetch and test helpers
- `test/`: `bun test`; `test/fixtures/essays.en.txt` is the long-input fixture (30 paragraphs, 16,566 letters)
- `docs/openapi.yaml`: API spec, served at `/api/v1/openapi.yaml`

## Invariants

- The backend never picks a model from the text. The client does (`public/select-model.ts`).
- Model choice by length: `LONG_THRESHOLD_LETTERS = 11_000` in `public/select-model.ts`. Keep the
  web app and any docs in sync with it.
- A model swap restarts the engine. Repeated requests for the loaded model do not reload it.
- One generation at a time; up to `MAX_QUEUE` wait FIFO, beyond that `429 queue_full`.
- Closing the client connection cancels the generation.
- `MAX_INPUT_TOKENS + 64 < CTX_SIZE`, otherwise startup fails.
- Output is capped at 4 × prompt tokens + 512 unless `max_output_tokens` is set, so loops stop.
- No authentication. Keep `HOST` on loopback or behind a proxy. `ALLOWED_ORIGINS` and
  `ALLOWED_HOSTS` control browser and proxy access.
- `SIGKILL` leaves `llama-server` running with its VRAM held; it must be killed by hand.

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
| `GPU_LAYERS` | `all` | `0` runs on CPU |
| `LLAMA_EXTRA_ARGS` | empty | Extra `llama-server` args, space separated |
| `LLAMA_SERVER_BIN` | `vendor/llama.cpp/llama-server` | |
| `LLAMA_PORT` | free port | Loopback port for the engine; a new one is picked per load if unset |
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
generation for both; 4,400-token prompt read in under 2 s; model load a few seconds.

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

- The web app must keep working with the server's error codes (`public/errors.ts`) and the paragraph-loss check (`public/paragraphs.ts`, counted in the source's own unit).
- Update `docs/openapi.yaml` and the tests in `test/api-contract.test.ts` / `test/openapi.test.ts` when the API changes.
- Update README.md for user-visible behaviour only; keep developer detail here.
