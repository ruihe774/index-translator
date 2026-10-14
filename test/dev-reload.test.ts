// DEV_RELOAD=1: the reload stream, the injected client script, and nothing of it without the flag.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type App, startApp } from "../src/app";
import { config, launcher } from "./helpers/mock-engine";

let dir: string;
let app: App | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dev-reload-test-"));
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "index.html"), "<!doctype html><title>t</title><body><p>hi</p></body>");
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("without DEV_RELOAD", () => {
  test("no /__dev routes and no script in the page", async () => {
    app = await startApp(config({ publicDir: dir }), launcher);
    const base = app.server.url.href;
    expect((await fetch(`${base}__dev/reload`)).status).toBe(404);
    expect((await fetch(`${base}__dev/reload.js`)).status).toBe(404);
    expect(await (await fetch(base)).text()).not.toContain("__dev");
  });
});

describe("with DEV_RELOAD", () => {
  test("the page carries the client script, which is served", async () => {
    app = await startApp(config({ publicDir: dir, devReload: true }), launcher);
    const base = app.server.url.href;
    const page = await fetch(base);
    expect(await page.text()).toContain('<script src="/__dev/reload.js"></script></body>');
    expect(page.headers.get("cache-control")).toBe("no-store");
    const script = await fetch(`${base}__dev/reload.js`);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toContain("EventSource");
  });

  test("a change in the public directory sends a reload event", async () => {
    app = await startApp(config({ publicDir: dir, devReload: true }), launcher);
    const res = await fetch(`${app.server.url.href}__dev/reload`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = decoder.decode((await reader.read()).value);
    expect(seen).toContain("event: hello");
    await Bun.write(join(dir, "app.ts"), "export {};\n");
    const deadline = Date.now() + 3000;
    while (!seen.includes("event: reload") && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), Bun.sleep(3000).then(() => {})]);
      if (!next || next.done) {
        break;
      }
      seen += decoder.decode(next.value);
    }
    expect(seen).toContain("event: reload");
    await reader.cancel();
  });
});
