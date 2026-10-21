// POST /webpage and the `webpage` part of GET /health, on the mock fetcher (no browser): what is
// refused before a page is opened, and how a fetch's failures are answered.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { Health, Webpage } from "../src/api";
import { type App, startApp } from "../src/app";
import {
  bodyOf,
  config,
  errorOf,
  launcher,
  mockWebpage,
  postTo,
  resetMockWebpage,
  speechLauncher,
  waitReady,
  webpageFetcher,
} from "./helpers/mock-engine";

let app: App;
let off: App;

beforeAll(async () => {
  app = await startApp(
    config({ allowedWebpageDomains: ["example.com", "*.example.org"] }),
    launcher,
    speechLauncher,
    webpageFetcher,
  );
  off = await startApp(config(), launcher, speechLauncher, webpageFetcher);
  await waitReady(app);
});

afterEach(() => resetMockWebpage());

afterAll(async () => {
  await app.stop();
  await off.stop();
});

const fetchPage = (body: unknown, target = app, init: RequestInit = {}) =>
  postTo(target.server.url.origin, "/api/v1/webpage", body, init);

describe("POST /webpage", () => {
  test("answers the page's Markdown, title and address", async () => {
    const res = await fetchPage({ url: "https://example.com/a?b=1" });
    expect(res.status).toBe(200);
    await expect(bodyOf<Webpage>(res)).resolves.toStrictEqual({
      url: "https://example.com/a?b=1",
      title: mockWebpage.title,
      markdown: mockWebpage.markdown,
    });
    expect(mockWebpage.requests).toStrictEqual(["https://example.com/a?b=1"]);
  });

  test.each([
    ["no url", {}],
    ["a number", { url: 42 }],
    ["an empty string", { url: " " }],
    ["no scheme", { url: "example.com/a" }],
    ["another scheme", { url: "ftp://example.com/a" }],
    ["a file", { url: "file:///etc/passwd" }],
    ["credentials", { url: "https://user:pass@example.com/" }],
  ])("%s is refused before anything is opened", async (_name, body) => {
    const res = await fetchPage(body);
    expect(res.status).toBe(400);
    await expect(errorOf(res)).resolves.toMatchObject({ code: "invalid_request", details: { field: "url" } });
    expect(mockWebpage.requests).toStrictEqual([]);
  });

  test("a host outside ALLOWED_WEBPAGE_DOMAINS is refused before anything is opened", async () => {
    for (const url of ["https://www.example.com/", "https://example.org/", "http://127.0.0.1:3000/"]) {
      const res = await fetchPage({ url });
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe("forbidden_webpage");
    }
    expect(mockWebpage.requests).toStrictEqual([]);
    expect((await fetchPage({ url: "http://a.b.example.org:8080/" })).status).toBe(200);
  });

  test("a page that ends up outside the allowed domains is refused", async () => {
    mockWebpage.redirectTo = "https://evil.test/";
    const res = await fetchPage({ url: "https://example.com/" });
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe("forbidden_webpage");
    expect(error.message).toContain("evil.test");
  });

  test("a page that cannot be opened is a 502 that says why", async () => {
    mockWebpage.failWith = "the page could not be opened: net::ERR_NAME_NOT_RESOLVED";
    const res = await fetchPage({ url: "https://example.com/" });
    expect(res.status).toBe(502);
    await expect(errorOf(res)).resolves.toStrictEqual({ code: "webpage_error", message: mockWebpage.failWith });
  });

  test("without allowed domains, or without turndown, it is unavailable, and /health says so", async () => {
    let res = await fetchPage({ url: "https://example.com/" }, off);
    expect(res.status).toBe(503);
    const error = await errorOf(res);
    expect(error.code).toBe("webpage_unavailable");
    expect(error.message).toContain("ALLOWED_WEBPAGE_DOMAINS");
    const health = async (target: App) =>
      (await bodyOf<Health>(await fetch(`${target.server.url.origin}/api/v1/health`))).webpage;
    await expect(health(off)).resolves.toMatchObject({ status: "unavailable" });
    await expect(health(app)).resolves.toStrictEqual({ status: "available" });

    mockWebpage.problem = "turndown is not installed on this server";
    res = await fetchPage({ url: "https://example.com/" });
    expect(res.status).toBe(503);
    await expect(errorOf(res)).resolves.toMatchObject({ code: "webpage_unavailable", message: mockWebpage.problem });
    await expect(health(app)).resolves.toStrictEqual({ status: "unavailable", error: mockWebpage.problem });
    expect(mockWebpage.requests).toStrictEqual([]);
  });

  test("two fetches at a time; the third is told to wait", async () => {
    mockWebpage.delayMs = 300;
    const running = [fetchPage({ url: "https://example.com/1" }), fetchPage({ url: "https://example.com/2" })];
    await Bun.sleep(50);
    const third = await fetchPage({ url: "https://example.com/3" });
    expect(third.status).toBe(429);
    expect((await errorOf(third)).code).toBe("queue_full");
    expect(third.headers.get("retry-after")).toBe("5");
    expect((await Promise.all(running)).map((r) => r.status)).toStrictEqual([200, 200]);
    expect((await fetchPage({ url: "https://example.com/4" })).status).toBe(200);
  });

  test("closing the connection stops the fetch", async () => {
    mockWebpage.delayMs = 5000;
    const controller = new AbortController();
    const res = fetchPage({ url: "https://example.com/" }, app, { signal: controller.signal });
    await Bun.sleep(50);
    controller.abort();
    await expect(res).rejects.toThrow();
    for (let i = 0; i < 50 && mockWebpage.aborted === 0; i++) {
      await Bun.sleep(10);
    }
    expect(mockWebpage.aborted).toBe(1);
  });

  test("only POST, and only a JSON body", async () => {
    const res = await fetch(`${app.server.url.origin}/api/v1/webpage`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    const text = await fetch(`${app.server.url.origin}/api/v1/webpage`, {
      method: "POST",
      body: "https://example.com/",
    });
    expect(text.status).toBe(415);
  });
});
