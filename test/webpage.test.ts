// src/webpage.ts with a real browser: Bun.WebView opens pages served here and src/page/extract.ts,
// with turndown, turns them into Markdown. Skipped without turndown (bun scripts/fetch_turndown.ts)
// or a browser Bun can start: Chrome or Chromium installed, BUN_CHROME_PATH, or e2e's CHROMIUM_PATH.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { turndownPath, WebpageError, WebpageForbiddenError, webViewBackend, webViewFetcher } from "../src/webpage";

const browser = process.env.CHROMIUM_PATH || undefined;

function browserFound(): boolean {
  try {
    new Bun.WebView({ backend: webViewBackend(browser) }).close();
    return true;
  } catch {
    return false;
  }
}

const installed = existsSync(turndownPath()) && browserFound();

const PAGES: Record<string, string> = {
  "/article": `<!doctype html><title> An article </title>
    <header><a href="/">Site</a></header>
    <nav><a href="/a">Menu</a></nav>
    <main>
      <aside>Related posts</aside>
      <article>
        <header><h1>The title <a href="#the-title">#</a></h1></header>
        <p>First <em>paragraph</em> with a <a href="other?x=1">relative link</a> and <a href="javascript:void 0">a script</a>.</p>
        <div style="display: none">Hidden text</div>
        <script>document.write("<p>Written by a script.</p>")</script>
        <form><p>Kept text in a form</p><button>Send</button><input value="typed"></form>
        <ul><li>One</li><li>Two</li></ul>
        <pre><code>let x = 1;</code></pre>
      </article>
    </main>
    <footer>Copyright</footer>`,
  "/list": `<!doctype html><title>List</title>
    <header>Site header</header>
    <article><h2>First post</h2><p>One.</p></article>
    <article><h2>Second post</h2><p>Two.</p></article>
    <footer>Site footer</footer>`,
  "/late": `<!doctype html><title>Late</title><body><p>Static.</p>
    <img src="/slow.png" alt="">
    <script>addEventListener("load", () => {
      document.body.insertAdjacentHTML("beforeend", "<p>Added on load.</p>");
    });</script>`,
  // Renders in steps after load, each sooner than the quiet time after the one before.
  "/rendering": `<!doctype html><title>Rendering</title><body><p>Shell.</p>
    <script>addEventListener("load", () => {
      for (const n of [1, 2, 3]) {
        setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<p>Part " + n + ".</p>"), 200 * n);
      }
    });</script>`,
  // Never stops changing.
  "/busy": `<!doctype html><title>Busy</title><body><p>Content.</p><p id="clock">0</p>
    <script>let n = 0; setInterval(() => { document.getElementById("clock").textContent = String(++n); }, 100);</script>`,
};

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      // An image that holds the page's load event back.
      if (pathname === "/slow.png") {
        return Bun.sleep(500).then(() => new Response(null, { status: 404 }));
      }
      if (pathname === "/redirect") {
        return Response.redirect(`http://localhost:${server.port}/article`, 302);
      }
      if (pathname === "/doc.md") {
        return new Response("# Título\n\n*Ünï* — **kept**\n\n- one\n", {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }
      if (pathname === "/latin1.md") {
        return new Response(new Uint8Array([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9]), {
          headers: { "content-type": "text/markdown; charset=iso-8859-1" },
        });
      }
      if (pathname === "/notes.txt") {
        return new Response("Line one\n\n  indented <b>not html</b>\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (pathname === "/data.json") {
        return new Response('{"a":1}', { headers: { "content-type": "application/json" } });
      }
      const page = PAGES[pathname];
      return new Response(page ?? "not found", {
        status: page ? 200 : 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  Bun.WebView.closeAll();
});

const local = (url: URL) => url.hostname === "127.0.0.1";

describe.skipIf(!installed)("webViewFetcher", () => {
  const fetcher = webViewFetcher(turndownPath(), browser);

  test("takes the one article of the one <main>, as Markdown with absolute links", async () => {
    const page = await fetcher.fetch(new URL(`${base}/article`), local, new AbortController().signal);
    expect(page.url).toBe(`${base}/article`);
    expect(page.title).toBe("An article");
    expect(page.markdown).toBe(
      [
        "# The title",
        `First *paragraph* with a [relative link](${base}/other?x=1) and a script.`,
        "Written by a script.",
        "Kept text in a form",
        "-   One\n-   Two",
        "```\nlet x = 1;\n```",
      ].join("\n\n"),
    );
  }, 30_000);

  test("several articles: the whole body, without the page's header and footer", async () => {
    const page = await fetcher.fetch(new URL(`${base}/list`), local, new AbortController().signal);
    expect(page.markdown).toBe("## First post\n\nOne.\n\n## Second post\n\nTwo.");
  }, 30_000);

  test("waits for the page to load and its scripts to run", async () => {
    const page = await fetcher.fetch(new URL(`${base}/late`), local, new AbortController().signal);
    expect(page.markdown).toBe("Static.\n\nAdded on load.");
  }, 30_000);

  test("reads a page once its DOM has been quiet for a moment, not after a fixed wait", async () => {
    let started = performance.now();
    let page = await fetcher.fetch(new URL(`${base}/rendering`), local, new AbortController().signal);
    expect(page.markdown).toBe("Shell.\n\nPart 1.\n\nPart 2.\n\nPart 3.");
    expect(performance.now() - started).toBeLessThan(2000);

    started = performance.now();
    page = await fetcher.fetch(new URL(`${base}/list`), local, new AbortController().signal);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(page.markdown).toContain("First post");
  }, 30_000);

  test("a page that never stops changing is read after the longest render wait", async () => {
    const started = performance.now();
    const page = await fetcher.fetch(new URL(`${base}/busy`), local, new AbortController().signal);
    expect(page.markdown).toStartWith("Content.");
    expect(performance.now() - started).toBeGreaterThan(4500);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("Markdown is answered as it is", async () => {
    const page = await fetcher.fetch(new URL(`${base}/doc.md`), local, new AbortController().signal);
    expect(page.markdown).toBe("# Título\n\n*Ünï* — **kept**\n\n- one\n");
  }, 30_000);

  test("plain text is answered as it is", async () => {
    const page = await fetcher.fetch(new URL(`${base}/notes.txt`), local, new AbortController().signal);
    expect(page.markdown).toBe("Line one\n\n  indented <b>not html</b>\n");
  }, 30_000);

  test("Markdown in another charset is decoded by it", async () => {
    const page = await fetcher.fetch(new URL(`${base}/latin1.md`), local, new AbortController().signal);
    expect(page.markdown).toBe("# Café");
  }, 30_000);

  test("a response that is not HTML or Markdown is a WebpageError", async () => {
    const fetching = fetcher.fetch(new URL(`${base}/data.json`), local, new AbortController().signal);
    await expect(fetching).rejects.toThrow("application/json");
  }, 30_000);

  test("a redirect to a host that is not allowed is refused", async () => {
    const fetching = fetcher.fetch(new URL(`${base}/redirect`), local, new AbortController().signal);
    await expect(fetching).rejects.toBeInstanceOf(WebpageForbiddenError);
  }, 30_000);

  test("a page that cannot be reached is a WebpageError", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const url = new URL(`http://127.0.0.1:${closed.port}/`);
    await closed.stop(true);
    await expect(fetcher.fetch(url, local, new AbortController().signal)).rejects.toBeInstanceOf(WebpageError);
  }, 30_000);

  test("an abort stops the fetch", async () => {
    const controller = new AbortController();
    const fetching = fetcher.fetch(new URL(`${base}/article`), local, controller.signal);
    controller.abort();
    await expect(fetching).rejects.toThrow();
  }, 30_000);
});
