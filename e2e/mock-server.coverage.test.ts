// `bun e2e/mock-server.ts` under `bun test --coverage`, so that the server's coverage is written when it stops
// (`bun run` has no coverage option). Used by `bun run e2e:coverage` (`e2e/playwright.config.ts`); not a test.

import { test } from "bun:test";

// eslint-disable-next-line bun:test/expect-expect -- deliberate
test("mock server", async () => {
  const { stopped } = await import("./mock-server");
  await stopped;
}, 86_400_000);
