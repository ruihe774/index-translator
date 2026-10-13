// Server for the Playwright tests: the real app (routes, static files, queue, engine supervisor)
// on top of the fake models from test/helpers/mock-engine.ts, so no GPU, libllama or model files
// are needed.
//
// A second, control server lets a test script what the mock engine says:
//   GET    /mock           current knobs and the generations requested so far
//   POST   /mock           set knobs: { chunks?, delayMs?, finish?, failWith?, failLaunch?, ready?,
//                          speech?: { state?, delayMs?, audioSeconds?, failWith? } }; `speech` in the answer holds
//                          the utterances requested from the mock speech engine
//   DELETE /mock           reset knobs and forget recorded requests
//   POST   /mock/restart   unload the engine so the next request loads its model again
// Tests call it through e2e/fixtures.ts.

import { startApp } from "../src/app";
import {
  CHAT,
  config,
  DOCUMENT,
  launcher,
  mock,
  mockSpeech,
  resetMock,
  resetMockSpeech,
  speechLauncher,
  waitReady,
} from "../test/helpers/mock-engine";

const port = Number(process.env.E2E_PORT ?? 3100);
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? 3101);

const app = await startApp(
  config({ port, ctxSize: 65_536, maxInputTokens: 28_000, maxQueue: 1, defaultModel: CHAT }),
  launcher,
  speechLauncher,
);
await waitReady(app);

const KNOBS = ["chunks", "delayMs", "finish", "failWith", "failLaunch", "imageUnavailable", "ready"] as const;

const control = Bun.serve({
  port: controlPort,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname !== "/mock" && pathname !== "/mock/restart") {
      return new Response("not found", { status: 404 });
    }
    if (pathname === "/mock/restart") {
      await app.engine.unload();
      return Response.json({ ok: true });
    }
    if (req.method === "POST") {
      const patch = (await req.json()) as Record<string, unknown>;
      for (const key of KNOBS) {
        if (key in patch) {
          (mock as any)[key] = patch[key];
        }
      }
      // { speech: { state?, delayMs?, failWith? } } scripts the mock speech engine.
      if (patch.speech) {
        Object.assign(mockSpeech, patch.speech);
      }
    } else if (req.method === "DELETE") {
      resetMock();
      resetMockSpeech();
      mock.requests.length = 0;
      mock.aborted = 0;
      mock.launches.length = 0;
    }
    // An image is reported by what a test can check: its size in bytes and whether it is the PNG the engine is given.
    const requests = mock.requests.map(({ image, ...rest }) => ({
      ...rest,
      ...(image ? { image: { bytes: image.length, png: image[0] === 0x89 && image[1] === 0x50 } } : {}),
    }));
    return Response.json({ ...mock, requests, models: { CHAT, DOCUMENT }, speech: mockSpeech });
  },
});

console.error(`[e2e] app ${app.server.url}, mock control ${control.url}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void control.stop(true);
    void app.stop().then(() => process.exit(0));
  });
}
