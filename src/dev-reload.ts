// Development only (DEV_RELOAD=1): refreshes the open page when a file in the public directory changes
// and after the server restarts (`bun run dev` runs the server under `bun --watch`).
//
// The page connects to an SSE stream. A public file change sends a `reload` event; a server restart
// drops the connection, and the page reloads when the browser reconnects. The page's CSP only allows
// same-origin scripts, so the client is a script served by the server, not an inline one.

import { watch } from "node:fs";

export const DEV_PREFIX = "/__dev/";
const EVENTS_PATH = `${DEV_PREFIX}reload`;
const CLIENT_PATH = `${DEV_PREFIX}reload.js`;
const SCRIPT_TAG = `<script src="${CLIENT_PATH}"></script>`;
const DEBOUNCE_MS = 50;
const KEEPALIVE_MS = 15_000;

const CLIENT = `const events = new EventSource("${EVENTS_PATH}");
let dropped = false;
events.onopen = () => {
  if (dropped) location.reload();
};
events.onerror = () => {
  dropped = true;
};
events.addEventListener("reload", () => location.reload());
`;

export function createDevReload(publicDir: string) {
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  function send(chunk: string): void {
    for (const c of clients) {
      try {
        c.enqueue(encoder.encode(chunk));
      } catch {
        clients.delete(c);
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(publicDir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => send("event: reload\ndata: \n\n"), DEBOUNCE_MS);
  });
  const keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
  keepalive.unref();

  return {
    /** Answers the /__dev/ routes; undefined for any other path. */
    handle(path: string, req: Request, server: { timeout(req: Request, seconds: number): void }): Response | undefined {
      if (path === CLIENT_PATH) {
        return new Response(CLIENT, {
          headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (path !== EVENTS_PATH) return undefined;
      server.timeout(req, 0);
      let self: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          self = c;
          clients.add(c);
          c.enqueue(encoder.encode(": connected\n\n"));
        },
        cancel() {
          clients.delete(self);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
      });
    },

    /** Adds the client script to HTML responses; every other response passes through. */
    async inject(res: Response): Promise<Response> {
      if (res.status !== 200 || !res.headers.get("content-type")?.startsWith("text/html")) return res;
      const html = await res.text();
      const body = html.includes("</body>") ? html.replace("</body>", `${SCRIPT_TAG}</body>`) : html + SCRIPT_TAG;
      const headers = new Headers(res.headers);
      headers.delete("etag");
      headers.delete("content-length");
      headers.set("cache-control", "no-store");
      return new Response(body, { status: res.status, headers });
    },

    close(): void {
      watcher.close();
      clearInterval(keepalive);
      clearTimeout(timer);
      for (const c of clients) {
        try {
          c.close();
        } catch {}
      }
      clients.clear();
    },
  };
}
