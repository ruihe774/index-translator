// Static files for the web app. TypeScript modules in the public directory are served as
// JavaScript, transpiled on request by Bun's own transpiler; there is no build step and nothing
// is written to disk. A request for /x.js is answered from x.ts when no real x.js exists.
// The .ts sources themselves are never served.

import { stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";

/** The page loads only same-origin scripts and styles, and nothing can frame it. */
const HTML_CSP = "default-src 'self'; frame-ancestors 'none'";

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

export function createStaticServer(publicDir: string) {
  // Resolved once so the traversal check below compares like with like, whatever form the caller used.
  const dir = resolve(publicDir);
  // Every served path must start with this. "/" already ends in a separator, so it is not doubled.
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  // Keyed by resolved file path; only .ts files that exist under the directory ever get an entry.
  const cache = new Map<string, Transpiled>();

  /** A plain file, revalidated by its ETag. Undefined when the path is not a regular file. */
  async function plainFile(path: string, req: Request): Promise<Response | undefined> {
    // Constructed before the stat: a path with a null byte throws here, and the caller answers that as a 500.
    const file = Bun.file(path);
    let info;
    try {
      info = await stat(path);
    } catch {
      return undefined;
    }
    if (!info.isFile()) return undefined;

    const etag = `W/"${info.mtimeMs}-${info.size}"`;
    const headers = { etag, "cache-control": "no-cache" };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(file, { headers });
  }

  async function transpiled(path: string, req: Request): Promise<Response | undefined> {
    let info;
    try {
      info = await stat(path);
    } catch {
      return undefined;
    }
    if (!info.isFile()) return undefined;

    let entry = cache.get(path);
    if (!entry || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
      let code: string;
      try {
        code = transpiler.transformSync(await Bun.file(path).text());
      } catch (e) {
        // A syntax error is the file's problem, not the server's: log it, answer 500, and keep serving everything else.
        // The previous good entry stays cached; the next request retries because the file's stat still differs from it.
        console.error(`[static] cannot transpile ${path}:`, e);
        return new Response("Internal Server Error", { status: 500 });
      }
      entry = { mtimeMs: info.mtimeMs, size: info.size, etag: `W/"${info.mtimeMs}-${info.size}"`, code };
      cache.set(path, entry);
    }

    // The file is revalidated on every load, so an edit shows up on the next reload.
    const headers = { etag: entry.etag, "cache-control": "no-cache" };
    if (req.headers.get("if-none-match") === entry.etag) return new Response(null, { status: 304, headers });
    return new Response(entry.code, {
      headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
    });
  }

  async function lookup(pathname: string, req: Request): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (rel.endsWith("/")) rel += "index.html";
    const path = normalize(join(dir, rel));
    if (!path.startsWith(prefix)) return notFound();
    // Raw TypeScript is never served, with any MIME type: the app loads its modules as .js, transpiled below.
    if (path.toLowerCase().endsWith(".ts")) return notFound();

    const file = await plainFile(path, req);
    if (file) return file;
    if (path.endsWith(".js")) {
      const res = await transpiled(path.slice(0, -3) + ".ts", req);
      if (res) return res;
    }
    return notFound();
  }

  return async function serveStatic(pathname: string, req: Request): Promise<Response> {
    return withSecurityHeaders(await lookup(pathname, req));
  };
}
