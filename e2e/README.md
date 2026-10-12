# Frontend tests (Playwright)

`bun run e2e` starts `e2e/mock-server.ts` (the real app on the fake models from
`test/helpers/mock-engine.ts`) and runs the specs in Chromium. No GPU or model files are needed.

- `translate.spec.ts`: end to end, real server and mock engine; `fixtures.ts` scripts the engine
  through a control port (`/mock`).
- `speech.spec.ts`: reading aloud against the mock speech engine, which answers each utterance
  with a tenth of a second of silence and records what it was asked to say (`speech` in `/mock`).
  The Record tests use Chromium's fake microphone: `playwright.config.ts` passes
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (a tone, prompt accepted);
  the denial test stubs `getUserMedia`.
- `open.spec.ts`: the Open button. Text and Markdown files are given as buffers; the PDF tests open
  `test/fixtures/sample.pdf` (three pages, written by `make_sample_pdf.py` beside it) with the real
  libraries from `public/vendor/`, so run `bun scripts/fetch_web_libs.ts` once before them. One
  test serves `/vendor/` as 404 to check that the page does without the libraries.
- `integration.spec.ts`: real page, API stubbed with `page.route`, for error codes and SSE framing.

Setup: `bun install`, then `bunx playwright install chromium`, or set `CHROMIUM_PATH` to an
existing Chromium. Env: `E2E_PORT` (3100), `E2E_CONTROL_PORT` (3101). `bun test` ignores this
directory (see `bunfig.toml`).
