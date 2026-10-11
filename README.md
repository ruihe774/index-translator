# Index Translator

Text translation backend built on locally deployed [Index-Translate](https://huggingface.co/IndexTeam)
models. One Bun process serves the REST/SSE API and the static web app, and supervises a
`llama-server` (llama.cpp, Vulkan) child that runs whichever model the request asks for.

## Setup

```bash
bun scripts/fetch_llama.ts      # pinned llama.cpp Vulkan build -> vendor/llama.cpp (checksum verified)
uv run scripts/fetch_models.py  # both 9B Q6_K models -> models/ (about 14 GiB, checksums verified)
bun src/server.ts               # http://127.0.0.1:3000
```

No system packages are needed beyond a working Vulkan driver, and there are no npm dependencies.

```bash
curl -s http://127.0.0.1:3000/api/v1/translate \
  -H 'content-type: application/json' \
  -d '{"text": "你好，世界。", "target_lang": "en"}'

curl -sN http://127.0.0.1:3000/api/v1/translate \
  -H 'content-type: application/json' \
  -d '{"model": "index-nailong-9b", "text": "...whole document...", "source_lang": "zh", "target_lang": "en", "stream": true}'
```

## Models

| id | Use | Notes |
|---|---|---|
| `index-translate-9b` | Default. Any supported language, glossary and constraints | Chat-style prompts |
| `index-nailong-9b` | Whole documents (NativeLong) | Four directions only: `zh-en`, `en-zh`, `zh-ja`, `ja-zh`. `source_lang` is required; glossary, constraints and genre are rejected. |

The GPU holds one of them at a time: a request for the other model waits its turn, the engine
restarts with the requested model, and then the request runs. Repeated requests for one model do
not reload it. The backend never chooses a model by looking at the text; the client picks it. The
web app does so by length, see [Web app](#web-app).

## Web app

Open `http://127.0.0.1:3000/`. It is served by the same Bun process; there is no build step.
The TypeScript files in `public/` are transpiled on request by Bun and held in memory
(revalidated by ETag, nothing written to disk), and the browser imports them as `/x.js`.

With the model set to Automatic, the app counts the letters of the text (Unicode letters only;
spaces, digits and punctuation do not count) and picks the model:

- up to 11,000 letters: `index-translate-9b`
- over 11,000 letters and a direction `index-nailong-9b` supports (zh-en, en-zh, zh-ja, ja-zh):
  `index-nailong-9b`. With "Detect language" the source is guessed from the script (Chinese,
  Japanese, or plain English); anything else is not guessed.
- over 11,000 letters otherwise (other languages, glossary or constraints entered, source not
  recognised): `index-translate-9b`, with a visible warning that it may drop or repeat paragraphs.

The model can also be chosen by hand. The threshold is `LONG_THRESHOLD_LETTERS` in
`public/select-model.ts`. After a translation the app compares paragraph counts with the source and
warns on a mismatch. Translating while typing is not supported.

## API

The specification is [docs/openapi.yaml](docs/openapi.yaml), also served at `/api/v1/openapi.yaml`.

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/translate` | Translate; JSON response, or SSE with `stream: true` |
| `POST /api/v1/tokenize` | Token count and remaining budget for a request; never queues or swaps models (`503` while no model is ready) |
| `GET /api/v1/models` | Available models, the default, and the one loaded now |
| `GET /api/v1/languages` | Language codes with a short form |
| `GET /api/v1/health` | Engine state, loaded model, limits, queue |

One request uses the engine at a time; up to `MAX_QUEUE` more wait in order, beyond that the answer
is `429`. Closing the connection cancels the translation.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Listen address. There is no authentication; keep it on loopback or behind a proxy. |
| `ALLOWED_ORIGINS` | | Comma-separated origins (e.g. `https://app.example.com`) allowed to call the API from a browser page. Requests from the same origin, or with no `Origin` header, are always allowed. |
| `ALLOWED_HOSTS` | | Comma-separated host names (no port) the API accepts in the `Host` header, besides `localhost`, `127.0.0.1`, `::1` and `HOST`. Set this when `HOST` is `0.0.0.0` or `::` and clients reach the server through a proxy under another name. |
| `MODELS_DIR` | `models/` | Directory holding the GGUF files named in `src/models.ts` |
| `DEFAULT_MODEL` | `index-translate-9b` | Model loaded at startup and used when a request names none |
| `CTX_SIZE` | `65536` | Context window in tokens, shared by prompt and translation (at least 66) |
| `MAX_INPUT_TOKENS` | `28000` | Largest accepted prompt. Must satisfy `MAX_INPUT_TOKENS + 64 < CTX_SIZE`, so at most `CTX_SIZE - 65` (`65471` by default); startup fails otherwise |
| `MAX_QUEUE` | `8` | Requests allowed to wait |
| `GPU_LAYERS` | `all` | Layers to offload; `0` runs on CPU |
| `LLAMA_EXTRA_ARGS` | | Extra `llama-server` arguments, space separated |
| `LLAMA_SERVER_BIN` | `vendor/llama.cpp/llama-server` | Engine binary |
| `LLAMA_PORT` | free port | Loopback port for the engine (a new port is picked per load if unset) |
| `PUBLIC_DIR` | `public/` | Static files for the web app |

## Layout

```
src/server.ts   entry point
src/app.ts      routes, model selection, SSE, static files
src/llama.ts    llama-server lifecycle (one model at a time), token counting, streamed generation
src/models.ts   model registry: ids, file names, kinds, document directions
src/prompt.ts   chat prompts, NativeLong document prompts, language table
src/queue.ts    single-slot FIFO
src/static.ts   static files, with .ts modules in public/ transpiled on request
public/         the web app: index.html, style.css, app.ts, select-model.ts (model choice by length)
prompts/        the four official NativeLong templates (from bilibili/Index-Translate)
scripts/        fetch_llama.ts, fetch_models.py, longtext.ts
test/           bun test (API tests run against a mock engine; no GPU needed)
docs/           openapi.yaml
```

If the Bun process is killed with `SIGKILL`, the `llama-server` child is not stopped and keeps
its VRAM; stop it by hand in that case. `SIGINT` and `SIGTERM` shut both down.

## Measured on this machine

Radeon RX 9070 (16 GiB, RADV), llama.cpp `b11552`, both models Q6_K, 65,536-token context:

- about 9,300 MiB of VRAM in use while the chat model runs (amd-smi); the NativeLong model was not sampled
- about 70 tokens/s generation for both; a 4,400-token prompt is read in under 2 seconds
- a model load takes a few seconds

## Long inputs

Both models read the whole input in one generation; the backend never splits it. The accepted
prompt size is 28,000 tokens. Behaviour differs by model. The test document is
`test/fixtures/essays.en.txt`: 30 paragraphs of ordinary prose, 16,566 letters.

**`index-nailong-9b` (NativeLong)**, English to Chinese, whole document: complete, 30 of 30
paragraphs in order, 4,472 prompt tokens, 3,689 completion tokens, one generation (57 s).
Run with `MODEL=index-nailong-9b bun scripts/longtext.ts http://127.0.0.1:3000`.

Chinese to English, using that Chinese output as input, is **not reliable at full length**:

| Input (Chinese) | Prompt tokens | Result |
|---|---|---|
| paragraphs 1–15, 3.1K characters | 1,973 | complete |
| paragraphs 1–22, 4.5K characters | 2,826 | complete |
| paragraphs 23–30, 1.6K characters | 1,095 | complete |
| all 30 paragraphs, 6.1K characters | 3,805 | paragraphs 17–27 lost their markers, output condensed to about 2,300 words from a source of about 3,600 |

The full-length failure is silent (`finish_reason` is `stop`). It does not follow from length alone
(22 paragraphs pass) or from any single paragraph (the last eight pass), and I did not isolate the
cause. Until it is understood, verify the paragraph markers of any Chinese-to-English document
result on the client side.

**`index-translate-9b`** on the same English document, English to Chinese: the first 15 paragraphs
(8.3K letters) and the first 20 (11.1K letters) came out complete and in order; all 30 (16.6K
letters) lost 11 paragraphs and repeated 2, reported as `finish_reason: stop`. The limit lies
between 11.1K and 16.6K and was not measured further; the web app switches models at 11,000 letters. This is a property of the model, not of
this deployment: the reference PyTorch implementation of the 2B sibling fails the same way, and
the 9B model fails identically on CPU and on Vulkan. Adding "translate everything" constraints made
it loop instead. For long documents, use `index-nailong-9b`.

The backend caps output at four times the prompt size plus 512 tokens unless the request sets
`max_output_tokens`, so a loop stops rather than filling the context.
