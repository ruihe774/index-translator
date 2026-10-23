// Where the mock servers listen, and how long Playwright gives them: one place for playwright.config.ts
// (which starts them), mock-server.ts (which is one) and fixtures.ts (which talks to them).
//
// Worker n has its own mock server (`e2e/playwright.config.ts`): ports step by 2, app then control.
// The server process itself is told its two ports as E2E_PORT and E2E_CONTROL_PORT, so inside it
// `PORT` and `CONTROL_PORT` are its own; elsewhere they are worker 0's.

export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? PORT + 1);

/** The ports of the mock server of Playwright worker `index`. */
export function portsOf(index: number): { app: number; control: number } {
  return { app: PORT + 2 * index, control: CONTROL_PORT + 2 * index };
}

/** How long a mock server may take to answer its health check after it was started. */
export const SERVER_START_TIMEOUT_MS = 30_000;
/** How long a mock server gets to finish after SIGTERM (`bun test` writes its coverage report then). */
export const SERVER_STOP_TIMEOUT_MS = 15_000;
