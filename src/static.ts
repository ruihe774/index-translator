// Static files for the web app. TypeScript modules in the public directory are served as
// JavaScript, transpiled on request by Bun's own transpiler; there is no build step and nothing
// is written to disk. A request for /x.js is answered from x.ts when no real x.js exists.

import { stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

interface Transpiled {
  mtimeMs: number;
  size: number;
  etag: string;
  code: string;
}

export function createStaticServer(publicDir: string) {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  // Keyed by resolved file path; only .ts files that exist under publicDir ever get an entry.
  const cache = new Map<string, Transpiled>();

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
      const code = transpiler.transformSync(await Bun.file(path).text());
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

  return async function serveStatic(pathname: string, req: Request): Promise<Response> {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (rel.endsWith("/")) rel += "index.html";
    const path = normalize(join(publicDir, rel));
    if (!path.startsWith(publicDir + sep)) return new Response("Not Found", { status: 404 });

    const file = Bun.file(path);
    if (await file.exists()) return new Response(file);
    if (path.endsWith(".js")) {
      const res = await transpiled(path.slice(0, -3) + ".ts", req);
      if (res) return res;
    }
    return new Response("Not Found", { status: 404 });
  };
}
