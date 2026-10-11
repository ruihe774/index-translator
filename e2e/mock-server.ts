// Server for the Playwright tests: the real app (routes, static files, queue, engine supervisor)
// on top of the fake models from test/helpers/mock-engine.ts, so no GPU, libllama or model files
// are needed.
//
// A second, control server lets a test script what the mock engine says:
//   GET    /mock           current knobs and the generations requested so far
//   POST   /mock           set knobs: { chunks?, delayMs?, finish?, failWith?, failLaunch?, ready? }
//   DELETE /mock           reset knobs and forget recorded requests
//   POST   /mock/restart   unload the engine so the next request loads its model again
// Tests call it through e2e/fixtures.ts.

import { startApp } from "../src/app";
import { CHAT, DOCUMENT, config, launcher, mock, resetMock, waitReady } from "../test/helpers/mock-engine";

const port = Number(process.env.E2E_PORT ?? 3100);
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? 3101);

const app = await startApp(
  config({ port, ctxSize: 65536, maxInputTokens: 28000, maxQueue: 1, defaultModel: CHAT }),
  launcher,
);
await waitReady(app);

const KNOBS = ["chunks", "delayMs", "finish", "failWith", "failLaunch", "ready"] as const;

const control = Bun.serve({
  port: controlPort,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname !== "/mock" && pathname !== "/mock/restart") return new Response("not found", { status: 404 });
    if (pathname === "/mock/restart") {
      await app.engine.unload();
      return Response.json({ ok: true });
    }
    if (req.method === "POST") {
      const patch = (await req.json()) as Record<string, unknown>;
      for (const key of KNOBS) if (key in patch) (mock as any)[key] = patch[key];
    } else if (req.method === "DELETE") {
      resetMock();
      mock.requests.length = 0;
      mock.aborted = 0;
      mock.launches.length = 0;
    }
    return Response.json({ ...mock, models: { CHAT, DOCUMENT } });
  },
});

console.error(`[e2e] app ${app.server.url}, mock control ${control.url}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    control.stop(true);
    await app.stop();
    process.exit(0);
  });
}
