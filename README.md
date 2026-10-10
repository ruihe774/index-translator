# Index Translator

Text translation backend built on a locally deployed [Index-Translate](https://huggingface.co/IndexTeam)
model. One Bun process serves the REST/SSE API and the static web app, and supervises a
`llama-server` (llama.cpp, Vulkan) child that runs the model.

## Setup

```bash
bun scripts/fetch_llama.ts      # pinned llama.cpp Vulkan build -> vendor/llama.cpp (checksum verified)
uv run scripts/fetch_models.py  # Index-Translate-9B Q6_K -> models/ (7.0 GiB, checksum verified)
bun src/server.ts               # http://127.0.0.1:3000
```

No system packages are needed beyond a working Vulkan driver, and there are no npm dependencies.

```bash
curl -s http://127.0.0.1:3000/api/v1/translate \
  -H 'content-type: application/json' \
  -d '{"text": "你好，世界。", "target_lang": "en"}'

curl -sN http://127.0.0.1:3000/api/v1/translate \
  -H 'content-type: application/json' \
  -d '{"text": "你好，世界。", "target_lang": "en", "stream": true}'
```

## API

The specification is [docs/openapi.yaml](docs/openapi.yaml), also served at `/api/v1/openapi.yaml`.

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/translate` | Translate; JSON response, or SSE with `stream: true` |
| `POST /api/v1/tokenize` | Token count and remaining budget for a request |
| `GET /api/v1/languages` | Language codes with a short form |
| `GET /api/v1/health` | Engine state, limits, queue |

One translation runs at a time; up to `MAX_QUEUE` more wait in order, beyond that the answer is
`429`. Closing the connection cancels the translation.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Listen address. There is no authentication; keep it on loopback or behind a proxy. |
| `MODEL_PATH` | `models/Index-Translate-9B.Q6_K.gguf` | GGUF file to load |
| `CTX_SIZE` | `65536` | Context window in tokens, shared by prompt and translation |
| `MAX_INPUT_TOKENS` | `28000` | Largest accepted prompt |
| `MAX_QUEUE` | `8` | Requests allowed to wait |
| `GPU_LAYERS` | `all` | Layers to offload; `0` runs on CPU |
| `LLAMA_EXTRA_ARGS` | | Extra `llama-server` arguments, space separated |
| `LLAMA_SERVER_BIN` | `vendor/llama.cpp/llama-server` | Engine binary |
| `LLAMA_SERVER_URL` | | Use an already running `llama-server` instead of spawning one |
| `LLAMA_PORT` | free port | Loopback port for the spawned engine |
| `PUBLIC_DIR` | `public/` | Static files for the web app |

## Layout

```
src/server.ts   entry point
src/app.ts      routes, SSE, static files
src/llama.ts    llama-server lifecycle, token counting, streamed generation
src/prompt.ts   Index-Translate prompt templates and language table
src/queue.ts    single-slot FIFO
scripts/        fetch_llama.ts, fetch_models.py, longtext.ts
test/           bun test (API tests run against a mock engine; no GPU needed)
docs/           openapi.yaml
```

If the Bun process is killed with `SIGKILL`, the `llama-server` child is not stopped and keeps
its VRAM; stop it by hand in that case. `SIGINT` and `SIGTERM` shut both down.

## Measured on this machine

Radeon RX 9070 (16 GiB, RADV), llama.cpp `b11552`, Index-Translate-9B Q6_K, 65,536-token context:

- about 8.4 GiB VRAM in use by the engine, model ready about 5 seconds after start
- about 70 tokens/s generation; a 4,400-token prompt is read in under 2 seconds

## Long inputs

The harness accepts prompts up to 28,000 tokens and translates them in one generation, never
splitting the input. **The model, however, does not stay reliable that far.** With the test
document in `test/fixtures/essays.en.txt` (30 paragraphs of ordinary prose, 16,566 letters,
English to Chinese):

| Input | Prompt tokens | Result |
|---|---|---|
| first 15 paragraphs, 8.3K letters | 2,196 | complete and in order |
| first 20 paragraphs, 11.1K letters | 2,917 | complete and in order |
| all 30 paragraphs, 16.6K letters | 4,386 | 11 paragraphs dropped, 2 repeated |

`bun scripts/longtext.ts http://127.0.0.1:3000` reproduces the last row and currently exits
non-zero. The failure is silent from the API's point of view: `finish_reason` is `stop`.

This is a property of the model, not of this deployment: the reference PyTorch implementation
of the 2B sibling fails on the same prompt with the same paragraph order as llama.cpp, and the
9B model fails identically on CPU and on Vulkan. Repetitive or table-heavy documents fail
sooner, and adding "translate everything" constraints made the model loop instead. For that
last case the backend caps output at four times the prompt size plus 512 tokens unless the
request sets `max_output_tokens`.

The family's dedicated whole-document model, Index-NativeLong (`IndexTeam/Index-Nailong-9B`),
translated the same 30 paragraphs completely and in order on this machine, but ships
templates only for Chinese↔English and Chinese↔Japanese. It is not part of this backend.
