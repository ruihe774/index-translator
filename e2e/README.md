# Frontend tests (Playwright)

`bun run e2e` starts `e2e/mock-server.ts` (the real app on the mock llama-server from
`test/helpers/mock-engine.ts`) and runs the specs in Chromium. No GPU or model files are needed.

- `translate.spec.ts`: end to end, real server and mock engine; `fixtures.ts` scripts the engine
  through a control port (`/mock`).
- `integration.spec.ts`: real page, API stubbed with `page.route`, for error codes and SSE framing.

Setup: `bun install`, then `bunx playwright install chromium`, or set `CHROMIUM_PATH` to an
existing Chromium. Env: `E2E_PORT` (3100), `E2E_CONTROL_PORT` (3101). `bun test` ignores this
directory (see `bunfig.toml`).
