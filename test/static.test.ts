// src/static.ts against a temporary public directory: transpiling, revalidation, headers and paths.
// The app-level behaviour of the real public/ directory is in api-requests.test.ts ("static files").

import { afterAll, beforeAll, beforeEach, describe, expect, onTestFinished, spyOn, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { createStaticServer } from "../src/static";

let dir: string;
// One server per test, as in src/app.ts, so the transpile cache is shared between requests.
let serve: ReturnType<typeof createStaticServer>;

async function write(rel: string, content: string) {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  await Bun.write(path, content);
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

beforeEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await write("index.html", "<!doctype html><title>t</title>");
  await write("style.css", "body { color: black; }");
  await write("app.ts", "export const answer: number = 42;\n");
  await write("broken.ts", "export const = ;\n");
  await write("sub/index.html", "<p>sub</p>");
  serve = createStaticServer(dir);
});

describe("HTML whitespace", () => {
  test("whitespace between tags is dropped, text keeps one space, literal elements are untouched", async () => {
    await write(
      "ws.html",
      "<!doctype html>\n<p>\n  a   <b>b</b>\n  <i>c</i>\n</p>\n<textarea>\n  x  </textarea>\n<pre>  y\n  z</pre>\n<script>let  a = 1;\n</script>\n",
    );
    const res = await get("/ws.html");
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(await res.text()).toBe(
      "<!doctype html><p> a <b>b</b><i>c</i></p><textarea>\n  x  </textarea><pre>  y\n  z</pre><script>let  a = 1;\n</script>",
    );
  });
});

describe("caching", () => {
  test("pages and scripts are revalidated, icons and vendored libraries may be kept for a day", async () => {
    await write("icons/icon.svg", "<svg/>");
    await write("vendor/lib/a.js", "export {}");
    expect((await get("/style.css")).headers.get("cache-control")).toBe("no-cache");
    expect((await get("/icons/icon.svg")).headers.get("cache-control")).toBe("public, max-age=86400");
    expect((await get("/vendor/lib/a.js")).headers.get("cache-control")).toBe("public, max-age=86400");
  });

  test("the service worker is served as a script that is always revalidated", async () => {
    await write("sw.ts", "const x: number = 1;\n");
    const res = await get("/sw.ts");
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("transpiled .ts", () => {
  test("is JavaScript without type annotations, revalidated with a 304 on a matching ETag", async () => {
    const res = await get("/app.ts");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).not.toContain(": number");

    const etag = res.headers.get("etag")!;
    const again = await get("/app.ts", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
  });

  test("a changed file is served again: new size, and a same-size edit with a newer mtime", async () => {
    const path = join(dir, "app.ts");
    const first = await get("/app.ts");
    const firstEtag = first.headers.get("etag")!;
    expect(await first.text()).toContain("42");

    // Different size: the ETag changes, so the old one no longer validates.
    await Bun.write(path, "export const answer: number = 4242424242;\n");
    const grown = await get("/app.ts", { headers: { "if-none-match": firstEtag } });
    expect(grown.status).toBe(200);
    expect(grown.headers.get("etag")).not.toBe(firstEtag);
    expect(await grown.text()).toContain("4242424242");

    // Same size, different content: only the mtime tells the cache the file changed.
    const before = (await get("/app.ts")).headers.get("etag")!;
    await Bun.write(path, "export const answer: number = 9999999999;\n");
    utimesSync(path, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const touched = await get("/app.ts");
    expect(touched.headers.get("etag")).not.toBe(before);
    expect(await touched.text()).toContain("9999999999");
  });

  test("a syntax error is a 500 that is logged, and the server keeps serving other files", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await get("/broken.ts");
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect((await get("/index.html")).status).toBe(200);
    expect((await get("/app.ts")).status).toBe(200);
  });

  test("a broken file is retried once it is fixed, without a restart", async () => {
    const path = join(dir, "broken.ts");
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await get("/broken.ts")).status).toBe(500);
      await Bun.write(path, "export const fixed: number = 1;\n");
      utimesSync(path, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      const res = await get("/broken.ts");
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
    expect((await get("/dirmod.ts")).status).toBe(404);
  });

  test("a .ts request is the transpiled module, never its source, and a missing one is a 404", async () => {
    const res = await get("/app.ts");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(": number");
    expect((await get("/sub/../app.ts")).status).toBe(200);
    const missing = await get("/missing.ts");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not Found");
  });

  test("a .js request for a module is answered from its .ts, as pages and workers installed earlier still ask", async () => {
    const res = await get("/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(await res.text()).not.toContain(": number");
    expect((await get("/nothing.js")).status).toBe(404);
  });

  test("a trailing slash on the public directory serves the same files", async () => {
    const res = await get("/index.html", {}, dir + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>");
    expect((await get("/app.ts", {}, dir + "/")).status).toBe(200);
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
      expect((await get("/app.ts", {}, publicDir)).status).toBe(200);
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
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 404, 200, 304, 405]);
    for (const res of responses) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      await res.text();
    }
  });

  // With nosniff a browser runs a module only as JavaScript and compiles a streamed .wasm only
  // as application/wasm: what the PDF libraries in public/vendor/ are served as.
  test("library files get the media types a browser insists on", async () => {
    await write("vendor/lib/pdf.min.mjs", "export const a = 1;\n");
    await write("vendor/lib/lib_bg.wasm", "\0asm");
    await write("vendor/lib/VERSION", "1.0.0 abc\n");
    const module = await get("/vendor/lib/pdf.min.mjs");
    expect(module.headers.get("content-type")).toStartWith("text/javascript");
    expect(await module.text()).toBe("export const a = 1;\n");
    const wasm = await get("/vendor/lib/lib_bg.wasm");
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    await wasm.arrayBuffer();
    expect((await get("/vendor/lib/VERSION")).status).toBe(200);
  });

  test("HTML carries the content security policy, other files do not", async () => {
    const html = await get("/");
    expect(html.headers.get("content-security-policy")).toBe("default-src 'self'; frame-ancestors 'none'");
    await html.text();
    for (const path of ["/style.css", "/app.ts", "/missing.html"]) {
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
