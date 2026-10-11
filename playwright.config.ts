import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 3101);

// Browser: Playwright's own download if present, else $CHROMIUM_PATH (e.g. a preinstalled Chromium).
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "e2e",
  // Every test shares one server and one mock engine, so they run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // The page keeps language choices in localStorage; each test gets a fresh context.
    locale: "en-US",
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
  webServer: {
    command: "bun e2e/mock-server.ts",
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { E2E_PORT: String(PORT), E2E_CONTROL_PORT: String(CONTROL_PORT) },
    stderr: "pipe",
  },
});
