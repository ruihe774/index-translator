// A reverse proxy that behaves like a slow link: every request waits one round trip, and the bytes of all responses
// share one bandwidth (first come, first served). It forwards over HTTP/1.1 to the app, and speaks HTTP/1.1 or, with
// `tls`, HTTP/2 to the browser. It sits in front of the page and the service worker alike, which is why it is used
// instead of the DevTools network emulation: that applies to the page's own requests only.
//
// Not modelled: TCP (slow start, loss, connection setup), request priorities.

import type { Cert } from "./cert";
import type { Profile } from "./profiles";

export interface Logged {
  path: string;
  start: number;
  end: number;
  bytes: number;
}

const MANIFEST = "/asset-manifest.json";
/** Bytes are let through in slices, so concurrent responses interleave. */
const SLICE = 16 * 1024;
const HOP_BY_HOP = ["transfer-encoding", "connection", "keep-alive"];

const sleep = (ms: number) => (ms > 0 ? Bun.sleep(ms) : undefined);

/** What a file's ETag becomes after `bump()`; the manifest and the files are changed alike, so they still agree. */
const BUMPED = "-bumped";
const bumped = (etag: string) => etag.replace(/"$/, `${BUMPED}"`);
/** Files that stay as they are: the vendored libraries do not change from one release to the next. */
const stays = (path: string) => path.startsWith("/vendor/");

export function startProxy(options: { port: number; upstream: string; tls?: Cert }) {
  const { upstream } = options;
  let link: Profile = { name: "loopback", mbit: 0, rttMs: 0 };
  let nextFree = 0;
  let released = false;
  const log: Logged[] = [];

  const take = async (bytes: number) => {
    if (link.mbit <= 0) {
      return;
    }
    const now = performance.now();
    nextFree = Math.max(nextFree, now) + (bytes / ((link.mbit * 1_000_000) / 8)) * 1000;
    await sleep(nextFree - now);
  };

  const server = Bun.serve({
    port: options.port,
    hostname: "127.0.0.1",
    ...(options.tls && { tls: options.tls, http2: true }),
    async fetch(req) {
      const { pathname, search } = new URL(req.url);
      const entry: Logged = { path: pathname, start: performance.now(), end: 0, bytes: 0 };
      log.push(entry);
      await sleep(link.rttMs / 2);
      const requestHeaders = new Headers(req.headers);
      requestHeaders.set("host", new URL(upstream).host);
      if (released && !stays(pathname)) {
        // The app knows only the old ETag: a client that holds that one has an outdated file, so it must get the
        // whole answer; one that holds the new one is up to date, and the app is asked with the old.
        const held = requestHeaders.get("if-none-match");
        if (held?.includes(BUMPED)) {
          requestHeaders.set("if-none-match", held.replace(BUMPED, ""));
        } else {
          requestHeaders.delete("if-none-match");
        }
        requestHeaders.delete("if-modified-since");
      }
      const up = await fetch(upstream + pathname + search, {
        method: req.method,
        headers: requestHeaders,
        body: req.body,
        redirect: "manual",
        // The bytes the app sent, so the sizes are those of the wire.
        decompress: false,
      });
      await sleep(link.rttMs / 2);
      const headers = new Headers(up.headers);
      for (const name of HOP_BY_HOP) {
        headers.delete(name);
      }
      let source: ReadableStream<Uint8Array> | null = up.body;
      if (released && pathname === MANIFEST && up.ok) {
        const manifest = (await up.json()) as Record<string, string>;
        for (const [path, etag] of Object.entries(manifest)) {
          if (!stays(path)) {
            manifest[path] = bumped(etag);
          }
        }
        const text = JSON.stringify(manifest);
        source = new Response(text).body;
        headers.delete("content-length");
      } else if (released && !stays(pathname)) {
        const etag = headers.get("etag");
        if (etag) {
          headers.set("etag", bumped(etag));
        }
      }
      const reader = source?.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const read = await reader?.read();
          if (!read || read.done) {
            entry.end = performance.now();
            controller.close();
            return;
          }
          for (let i = 0; i < read.value.length; i += SLICE) {
            const slice = read.value.subarray(i, i + SLICE);
            await take(slice.length);
            entry.bytes += slice.length;
            controller.enqueue(slice);
          }
        },
        cancel: () => reader?.cancel(),
      });
      return new Response(body, { status: up.status, headers });
    },
  });

  return {
    /** The requests seen since the last `mark` or `use`. */
    log,
    /** Sets the link and forgets the log and what was released. */
    use(profile: Profile) {
      link = profile;
      nextFree = 0;
      released = false;
      log.length = 0;
    },
    /** Forgets the log, for the next visit. */
    mark() {
      log.length = 0;
    },
    /** From now on the files outside `/vendor/` have new ETags, as after a release. */
    release() {
      released = true;
    },
    stop: () => server.stop(true),
  };
}

export type Proxy = ReturnType<typeof startProxy>;
