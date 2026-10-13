import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { COVERAGE } from "./coverage";

// Paths are relative to this file (e2e/), which is where Playwright resolves them; the repository root is `..`.
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// One mock server (app port + control port) per worker, so tests keep their private mock state while
// files run side by side. `E2E_WORKERS=1` gives the old serial run.
const WORKERS = Number(process.env.E2E_WORKERS ?? Math.min(6, Math.max(1, Math.floor(availableParallelism() / 3))));
const PORT = Number(process.env.E2E_PORT ?? 3100);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? PORT + 1);

// Browser: Playwright's own download if present, else $CHROMIUM_PATH (e.g. a preinstalled Chromium).
const executablePath = process.env.CHROMIUM_PATH || undefined;

// `bun run e2e:coverage` (`E2E_COVERAGE=1`): the page's coverage is collected by `fixtures.ts`, the server's by
// running each mock server under `bun test --coverage` (`e2e/coverage.ts`).
const server = (i: number) =>
  COVERAGE
    ? // `exec`: the signal that stops the server must reach `bun test`, not the shell around it.
      `exec bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage/e2e-server/${i} ./e2e/mock-server.coverage.test.ts`
    : "bun e2e/mock-server.ts";

export default defineConfig({
  ...(COVERAGE && {
    globalSetup: at("coverage-setup.ts"),
    globalTeardown: at("coverage-teardown.ts"),
  }),
  testDir: ".",
  // Not `*.test.ts`: `mock-server.coverage.test.ts` is run by `bun test`, not by Playwright.
  testMatch: "*.spec.ts",
  outputDir: at("../test-results"),
  // Each worker has its own server and mock engine (`parallelIndex`, see `e2e/fixtures.ts`), so the tests
  // of one worker run one at a time; tests are spread over the workers.
  fullyParallel: true,
  workers: WORKERS,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["dot"], ["html", { open: "never", outputFolder: at("../playwright-report") }]] : "dot",
  use: {
    trace: "retain-on-failure",
    // The page keeps language choices in localStorage; each test gets a fresh context.
    locale: "en-US",
    // The tests script the network from the page (route, the mock engine); a cache in between would hide it.
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath,
          // A fake microphone (a tone) whose permission prompt is accepted, for the Record button.
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
  ],
  webServer: Array.from({ length: WORKERS }, (_, i) => ({
    command: server(i),
    cwd: at(".."),
    url: `http://127.0.0.1:${PORT + 2 * i}/api/v1/health`,
    // A server that is reused has no coverage. The bun test run writes its report on SIGTERM, hence the wait.
    reuseExistingServer: !process.env.CI && !COVERAGE,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    timeout: 30_000,
    env: { E2E_PORT: String(PORT + 2 * i), E2E_CONTROL_PORT: String(CONTROL_PORT + 2 * i) },
    stderr: "pipe" as const,
  })),
});
