// Static files for the web app. TypeScript modules in the public directory are served as
// JavaScript, transpiled on request by Bun's own transpiler; there is no build step and nothing
// is written to disk. A request for /x.ts is the transpiled module, with a JavaScript media type
// (the response sets it, so the extension does not decide it). The .ts sources themselves are
// never served.

import { join, normalize, resolve, sep } from "node:path";

import type { PublicWatcher } from "./public-watch";

/** The page loads only same-origin scripts and styles, and nothing can frame it. */
const HTML_CSP =
  "default-src 'self'; frame-ancestors 'none'; style-src 'self' 'sha256-3UZwvRm3UKR9RB0lE57/ZGxUodThIOqU6t14BTQJ4Wk='; script-src 'self' 'sha256-mPO7V38BOo1RlEecQ/LNj5fR3FFanGg+QCFN4pFYXxg='";

interface Transpiled {
  mtimeMs: number;
  size: number;
  etag: string;
  code: string;
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/** Adds the headers every static response carries, whatever its status. */
function withSecurityHeaders(res: Response): Response {
  res.headers.set("x-content-type-options", "nosniff");
  if (res.headers.get("content-type")?.startsWith("text/html")) {
    res.headers.set("content-security-policy", HTML_CSP);
  }
  return res;
}

/**
 * Pages, scripts and styles change with the code and are revalidated on every load (a 304 is cheap).
 * Icons and the vendored libraries change only with a release or a pinned upgrade, so a day old is fine.
 * So does the loading page, `index.html` at the top: it only fetches `app.html`, which is revalidated.
 */
function cacheControl(relativePath: string): string {
  return relativePath === "index.html" || /^(icons|vendor)[\\/]/.test(relativePath)
    ? "public, max-age=86400"
    : "no-cache";
}

/**
 * Whitespace between tags is dropped from pages, and between attributes reduced to one space: the layout is flex or grid wherever it holds several
 * elements, so none of it is rendered (measured on every element of index.html at five widths, both
 * colour schemes). Text keeps one space where it had any, and elements whose text is literal are left alone.
 * A page that relied on a space between inline elements would need `&#32;`.
 */
function stripWhitespace(html: Response): Response {
  let literal = 0; // depth inside <pre>, <textarea>, <script>, <style>
  let pending = ""; // the current text node, which the rewriter delivers in chunks
  const rewriter = new HTMLRewriter()
    .on("pre, textarea, script, style", {
      element(el) {
        literal++;
        el.onEndTag(() => void literal--);
      },
    })
    .on("*", {
      element(el) {
        // Touching an attribute makes the rewriter write the start tag afresh: one space between attributes.
        const first = el.attributes.next();
        if (!first.done) {
          el.setAttribute(first.value[0], first.value[1]);
        }
      },
    })
    .onDocument({
      text(chunk) {
        if (literal) {
          return;
        }
        pending += chunk.text;
        chunk.remove();
        if (!chunk.lastInTextNode) {
          return;
        }
        const text = pending.replaceAll(/\s+/g, " ").trim();
        pending = "";
        if (text !== " ") {
          chunk.after(text, { html: true });
        }
      },
    });
  return rewriter.transform(html);
}

/** Where the service worker (public/sw.ts) learns the ETag of every file served. */
export const MANIFEST_PATH = "/asset-manifest.json";

/** The validator both the files and the manifest carry, so a client can compare without asking again. */
function etagOf(info: { mtimeMs: number; size: number }): string {
  return `W/"${info.mtimeMs}-${info.size}"`;
}

export function createStaticServer(publicDir: string, watcher?: PublicWatcher) {
  // Resolved once so the traversal check below compares like with like, whatever form the caller used.
  const dir = resolve(publicDir);
  // Every served path must start with this. "/" already ends in a separator, so it is not doubled.
  const prefix = dir.endsWith(sep) ? dir : dir + sep;

  /** URL path → ETag of every file under the directory, as `lookup` would answer it. */
  async function buildManifest(): Promise<Record<string, string>> {
    const manifest: Record<string, string> = {};
    const names: string[] = [];
    try {
      for await (const name of new Bun.Glob("**/*").scan({ cwd: dir, dot: true })) {
        names.push(name);
      }
    } catch {
      // No directory, nothing served.
    }
    await Promise.all(
      names.map(async (name) => {
        const info = await Bun.file(join(dir, name))
          .stat()
          .catch(() => {});
        if (!info?.isFile()) {
          return;
        }
        const etag = etagOf(info);
        const url = "/" + name.replaceAll("\\", "/");
        manifest[url] = etag;
        // A directory's page is also asked for by the directory's own path.
        if (url.endsWith("/index.html")) {
          manifest[url.slice(0, -"index.html".length)] = etag;
        }
      }),
    );
    return manifest;
  }

  // Built at launch and again, on the next request, after any change under the directory. Without a
  // watcher nothing says when files change, so every request builds afresh.
  let manifest = buildManifest();
  let stale = false;
  watcher?.subscribe(() => void (stale = true));

  function manifestResponse(): Promise<Response> {
    if (stale || !watcher?.watching) {
      stale = false;
      manifest = buildManifest();
    }
    return manifest.then((body) => Response.json(body, { headers: { "cache-control": "no-store" } }));
  }
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  // Keyed by resolved file path; only .ts files that exist under the directory ever get an entry.
  const cache = new Map<string, Transpiled>();

  /** A plain file, revalidated by its ETag. Undefined when the path is not a regular file. */
  async function plainFile(path: string, req: Request): Promise<Response | undefined> {
    // Constructed before the stat: a path with a null byte throws here, and the caller answers that as a 500.
    const file = Bun.file(path);
    const info = await file.stat().catch(() => {});
    if (!info?.isFile()) {
      return undefined;
    }

    const etag = etagOf(info);
    const headers = { etag, "cache-control": cacheControl(path.slice(prefix.length)) };
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }
    if (path.endsWith(".html")) {
      return new Response(await stripWhitespace(new Response(file)).text(), {
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(file, { headers });
  }

  async function transpiled(path: string, req: Request): Promise<Response | undefined> {
    const info = await Bun.file(path)
      .stat()
      .catch(() => {});
    if (!info?.isFile()) {
      return undefined;
    }

    let entry = cache.get(path);
    if (entry?.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
      let code: string;
      try {
        code = transpiler.transformSync(await Bun.file(path).text());
      } catch (e) {
        // A syntax error is the file's problem, not the server's: log it, answer 500, and keep serving everything else.
        // The previous good entry stays cached; the next request retries because the file's stat still differs from it.
        console.error(`[static] cannot transpile ${path}:`, e);
        return new Response("Internal Server Error", { status: 500 });
      }
      entry = { mtimeMs: info.mtimeMs, size: info.size, etag: etagOf(info), code };
      cache.set(path, entry);
    }

    // The file is revalidated on every load, so an edit shows up on the next reload.
    const headers = { etag: entry.etag, "cache-control": "no-cache" };
    if (req.headers.get("if-none-match") === entry.etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(entry.code, {
      headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
    });
  }

  async function lookup(pathname: string, req: Request): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (pathname === MANIFEST_PATH) {
      return manifestResponse();
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (rel.endsWith("/")) {
      rel += "index.html";
    }
    const path = normalize(join(dir, rel));
    if (!path.startsWith(prefix)) {
      return notFound();
    }
    // The module's name is .ts, its answer is JavaScript: the transpiled code, never the source.
    if (path.endsWith(".ts")) {
      return (await transpiled(path, req)) ?? notFound();
    }

    return (await plainFile(path, req)) ?? notFound();
  }

  return async function serveStatic(pathname: string, req: Request): Promise<Response> {
    return withSecurityHeaders(await lookup(pathname, req));
  };
}
