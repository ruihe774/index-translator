// src/static.ts against a temporary public directory: transpiling, revalidation, headers and paths.
// The app-level behaviour of the real public/ directory is in api-requests.test.ts ("static files").

import { afterAll, beforeAll, beforeEach, describe, expect, onTestFinished, spyOn, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createStaticServer } from "../src/static";

let dir: string;
// One server per test, as in src/app.ts, so the transpile cache is shared between requests.
let serve: ReturnType<typeof createStaticServer>;

function write(rel: string, content: string) {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Serves `path` the way src/app.ts calls it; a `publicDir` gets its own server. */
function get(path: string, init: RequestInit = {}, publicDir?: string): Promise<Response> {
  const handler = publicDir === undefined ? serve : createStaticServer(publicDir);
  return handler(path, new Request("http://127.0.0.1" + path, init));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "static-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  write("index.html", "<!doctype html><title>t</title>");
  write("style.css", "body { color: black; }");
  write("app.ts", "export const answer: number = 42;\n");
  write("broken.ts", "export const = ;\n");
  write("sub/index.html", "<p>sub</p>");
  serve = createStaticServer(dir);
});

describe("transpiled .js", () => {
  test("is JavaScript without type annotations, revalidated with a 304 on a matching ETag", async () => {
    const res = await get("/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).not.toContain(": number");

    const etag = res.headers.get("etag")!;
    const again = await get("/app.js", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
  });

  test("a changed file is served again: new size, and a same-size edit with a newer mtime", async () => {
    const path = join(dir, "app.ts");
    const first = await get("/app.js");
    const firstEtag = first.headers.get("etag")!;
    expect(await first.text()).toContain("42");

    // Different size: the ETag changes, so the old one no longer validates.
    writeFileSync(path, "export const answer: number = 4242424242;\n");
    const grown = await get("/app.js", { headers: { "if-none-match": firstEtag } });
    expect(grown.status).toBe(200);
    expect(grown.headers.get("etag")).not.toBe(firstEtag);
    expect(await grown.text()).toContain("4242424242");

    // Same size, different content: only the mtime tells the cache the file changed.
    const before = (await get("/app.js")).headers.get("etag")!;
    writeFileSync(path, "export const answer: number = 9999999999;\n");
    utimesSync(path, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const touched = await get("/app.js");
    expect(touched.headers.get("etag")).not.toBe(before);
    expect(await touched.text()).toContain("9999999999");
  });

  test("a syntax error is a 500 that is logged, and the server keeps serving other files", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await get("/broken.js");
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect((await get("/index.html")).status).toBe(200);
    expect((await get("/app.js")).status).toBe(200);
  });

  test("a broken file is retried once it is fixed, without a restart", async () => {
    const path = join(dir, "broken.ts");
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await get("/broken.js")).status).toBe(500);
      writeFileSync(path, "export const fixed: number = 1;\n");
      utimesSync(path, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      const res = await get("/broken.js");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("fixed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("paths", () => {
  test("a directory is not a file: no trailing slash is a 404, with a trailing slash it is its index.html", async () => {
    expect((await get("/sub")).status).toBe(404);
    const index = await get("/sub/");
    expect(index.status).toBe(200);
    expect(await index.text()).toBe("<p>sub</p>");
  });

  test("a directory named like a module is not transpiled", async () => {
    mkdirSync(join(dir, "dirmod.ts"));
    expect((await get("/dirmod.js")).status).toBe(404);
  });

  test("raw .ts sources are a 404, with any letter case, and the .js of the same name still works", async () => {
    for (const path of ["/app.ts", "/broken.ts", "/APP.TS", "/sub/../app.ts"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not Found");
    }
    expect((await get("/app.js")).status).toBe(200);
  });

  test("a trailing slash on the public directory serves the same files", async () => {
    const res = await get("/index.html", {}, dir + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>");
    expect((await get("/app.js", {}, dir + "/")).status).toBe(200);
    expect((await get("/", {}, dir + "/")).status).toBe(200);
    expect((await get("/../etc/passwd", {}, dir + "/")).status).toBe(404);
  });

  test("a relative public directory serves the same files, including with ./", async () => {
    // On Windows the temp directory can be on another drive, where no relative path exists.
    let rel = relative(process.cwd(), dir);
    if (isAbsolute(rel)) {
      const local = mkdtempSync(join(process.cwd(), "static-test-"));
      cpSync(dir, local, { recursive: true });
      rel = relative(process.cwd(), local);
      onTestFinished(() => rmSync(local, { recursive: true, force: true }));
    }
    for (const publicDir of [rel, "./" + rel, rel + "/"]) {
      const res = await get("/style.css", {}, publicDir);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("color");
      expect((await get("/app.js", {}, publicDir)).status).toBe(200);
    }
    expect((await get("/../package.json", {}, rel)).status).toBe(404);
  });

  // "/" is the root of the current drive on Windows, so the temp directory must be on it.
  test("a public directory of / is not doubled into // and still serves", async () => {
    if (process.platform === "win32" && resolve(dir)[0] !== resolve("/")[0]) return;
    const rel = resolve(dir)
      .replace(/^[A-Za-z]:/, "")
      .replaceAll("\\", "/")
      .slice(1);
    const res = await get("/" + rel + "/style.css", {}, "/");
    expect(res.status).toBe(200);
    await res.text();
  });
});

describe("headers", () => {
  test("every static response is nosniff, including 404, 304 and 405", async () => {
    const responses = [
      await get("/index.html"),
      await get("/style.css"),
      await get("/app.js"),
      await get("/missing.html"),
      await get("/app.ts"),
      await get("/app.js", { headers: { "if-none-match": (await get("/app.js")).headers.get("etag")! } }),
      await get("/style.css", { method: "POST", body: "x" }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 404, 404, 304, 405]);
    for (const res of responses) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      await res.text();
    }
  });

  test("HTML carries the content security policy, other files do not", async () => {
    const html = await get("/");
    expect(html.headers.get("content-security-policy")).toBe("default-src 'self'; frame-ancestors 'none'");
    await html.text();
    for (const path of ["/style.css", "/app.js", "/missing.html"]) {
      const res = await get(path);
      expect(res.headers.get("content-security-policy")).toBeNull();
      await res.text();
    }
  });

  test("plain files are no-cache and revalidated by ETag", async () => {
    for (const path of ["/index.html", "/style.css"]) {
      const res = await get(path);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const etag = res.headers.get("etag")!;
      expect(etag).toStartWith('W/"');
      await res.text();

      const again = await get(path, { headers: { "if-none-match": etag } });
      expect(again.status).toBe(304);
      expect(await again.text()).toBe("");
    }
  });

  test("HEAD gets the same headers (the server, not this layer, drops the body)", async () => {
    const res = await get("/index.html", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    await res.text();
  });
});
