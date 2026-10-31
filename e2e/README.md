# Frontend tests (Playwright)

`bun run e2e` starts `e2e/mock-server.ts` (the real app on the fake models from
`test/helpers/mock-engine.ts`, which re-exports one file per mock) and runs the specs in Chromium. No
GPU or model files are needed. The ports and server timeouts are in `ports.ts`, shared by the config,
the mock server and `fixtures.ts`.

Waiting: no `waitForTimeout` where something can be observed. Use `expect.poll` or a web-first
assertion, the control port (`mock.state()`), `transitionsDone(locator)` for a CSS transition,
`frames(page)` for a handler that runs on the next frame, or `page.clock` to move the page's timers
by hand. A fixed wait stays only for what nothing shows (an absent request, real audio time or
real-time recording), through `quiet(page, ms)` in `fixtures.ts`, the one audited call of `waitForTimeout`, with a
comment saying why.

- `translate.spec.ts`: end to end, real server and mock engine; `fixtures.ts` scripts the engine
  through a control port (`/mock`).
- `speech.spec.ts`: reading aloud against the mock speech engine, which answers each utterance
  with a tenth of a second of silence and records what it was asked to say (`speech` in `/mock`).
  The Record tests use Chromium's fake microphone: `e2e/playwright.config.ts` passes
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (a tone, prompt accepted);
  the denial test stubs `getUserMedia`.
- `open.spec.ts`: the Open button. Text and Markdown files are given as buffers; the PDF tests open
  `test/fixtures/sample.pdf` (three pages, written by `make_sample_pdf.py` beside it) and the Word
  tests `test/fixtures/sample.docx` (written by `make_sample_docx.py`) with the real libraries from
  `public/vendor/`, so run `bun scripts/fetch_web_libs.ts` once before them. One test serves
  `/vendor/` as 404 to check that the page does without the libraries.
- `speech.spec.ts` also runs the QOA stream (the default way speech reaches the page) against the
  real codec in `public/vendor/qoa/`, and the fallbacks to WAV (codec files not served; a stream
  that cannot be decoded).
- `webpage.spec.ts`: a web address alone in the box, against the mock browser of `POST /webpage`,
  which answers every page with set Markdown and records the addresses (`webpage` in `/mock`); the
  mock server allows `example.com` and `*.example.com`. The real browser path is
  `test/webpage.test.ts` (`bun test`).
- `integration.spec.ts`: real page, API stubbed with `page.route`, for error codes and SSE framing.

Setup: `bun install`, then `bunx playwright install chromium`, or set `CHROMIUM_PATH` to an
existing Chromium. Env: `E2E_PORT` (3100), `E2E_CONTROL_PORT` (3101), `E2E_WORKERS` (a third of
the CPUs, at most 6; `1` runs serially). Each worker has its own mock server, app and control ports
stepping by 2 from those two (worker n: `E2E_PORT + 2n`), so tests run in parallel; a test that needs
state outside its `mock` fixture would break that. `bun test` ignores this directory (see `bunfig.toml`).

Coverage: `bun run e2e:coverage` (`E2E_COVERAGE=1`) writes `coverage/e2e-web/` (the page, `lcov-report/` for HTML) and
`coverage/e2e-server/<n>/lcov.info` (one per mock server). It always starts its own servers.

## Page load measurements (`bun run e2e:perf`)

`e2e/perf/run.ts` measures how long the page takes to show itself on a slow link. It is a script, not a spec: it
asserts nothing, since the numbers depend on the machine (compare runs of the same one), and it is not part of
`bun run e2e`. It starts the mock server on `PERF_PORT` (3200) and drives Chromium through a throttling reverse
proxy (`proxy.ts`): every request waits one round trip, and all responses share one bandwidth. The browser speaks
HTTP/1.1 (`http://app.test:3201`) or HTTP/2 over a throwaway certificate (`https://app.test:3202`, needs `openssl`);
`tailscale serve` is the latter. A proxy is used rather than DevTools' network emulation because that does not slow
the service worker's own downloads (the prefetch of every file), which is most of a first visit.

Options: `--worker prefetch,lazy` (the service worker as it is, or the ablation without its bulk prefetch: the
proxy serves `sw.ts` with the `saveData` test it already has turned on, so the cache fills only with what the page
asks for; with `lazy` the page's first visit caches nothing, as the worker does not control it yet),
`--profile loopback,fast,slow` (`profiles.ts`: unlimited, 20 Mbit/s with 40 ms, 5 Mbit/s with 100 ms),
`--protocol h1,h2`, `--scenario <names>`, `--repeats 3`. Results: a table of medians on stdout and every run in
`perf-results/<time>.json`.

| scenario    | visit                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| `cold`      | first, no service worker, empty HTTP cache                                    |
| `warm-http` | next visit, no service worker: the HTTP cache only                            |
| `first-sw`  | first, with the service worker, which downloads every file                    |
| `warm-sw`   | next visit, answered by the worker (checked: the page is controlled) |
| `again-sw`  | the visit after that: the first with a complete cache, whichever `--worker` it is |
| `sw-update` | next visit after every ETag outside `/vendor/` changed (the proxy rewrites them): a full update |
| `sw-patch`  | after that has settled, the next visit once only five files the page loads at start changed |

`visible` is the time until `visibility-gate.ts` sets the body's opacity to 1; `synced` is when the worker's cache
holds every file at the listed version; `reqs` and `MB` are what the proxy saw until the page and the worker went
quiet. Run `bun scripts/fetch_web_libs.ts` first, or the page is lighter than the real one.

The service worker needs a secure context, which `http://app.test` is not: the browser is started with
`--unsafely-treat-insecure-origin-as-secure`, which Playwright's default headless shell ignores, so the script uses
the `chromium` channel (the full browser, new headless). `CHROMIUM_PATH` must be a full Chromium as well. Not
modelled: TCP behaviour (slow start, loss, connection setup) and request priorities.
