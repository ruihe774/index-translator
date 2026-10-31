// The service worker. The server lists every file it serves with its ETag (/asset-manifest.json).
// The worker fetches that list first, answers a request from the cache only when the cached copy has
// the listed ETag, and otherwise downloads the file and caches it, so a file is cached once the page has
// asked for it. So no stale file is ever served, except the loading page (index.html), which is answered
// from the cache without waiting for the list: it only fetches app.html, which is checked. The price for
// the rest is a slower first render, and the app is no use without its server anyway. (Downloading every
// missing or outdated file at low priority right after the list arrives is written but switched off, see
// `prefetch`.)
// On loopback (development, or the app on its own machine) the worker does nothing.

/** The part of the service worker scope that is used (the DOM library has no `webworker` types). */
interface WorkerScope {
  location: Location;
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: WorkerEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
}
interface WorkerEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends WorkerEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

/** URL path → ETag, as src/static.ts lists it. */
type Manifest = Record<string, string>;

const sw = self as unknown as WorkerScope;
/** Bump to drop everything cached by an older worker. */
const CACHE = "index-translator-v3";
const MANIFEST_PATH = "/asset-manifest.json";

function onLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

async function loadManifest(): Promise<Manifest | undefined> {
  try {
    const res = await fetch(MANIFEST_PATH, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

/** Downloads a file past the browser's HTTP cache (a day-old icon must not stand in for a newer one) and keeps it. */
async function download(path: string, priority: "low" | "auto"): Promise<Response> {
  const res = await fetch(path, { cache: "no-cache", priority });
  // A full, ordinary answer only: never an error page or a response marked no-store.
  if (res.status === 200 && !res.headers.get("cache-control")?.includes("no-store")) {
    // Cloned now: once the response is handed to the page its body is taken, and a later clone() throws.
    const copy = res.clone();
    const stored = caches
      .open(CACHE)
      .then((cache) => cache.put(path, copy))
      .catch(() => {});
    // The page's own request does not wait for the copy; the prefetch does, so it outlasts the worker's idle stop.
    if (priority === "low") {
      await stored;
    }
  }
  return res;
}

/** The cache's entry for `path`, if it is the version the manifest lists. */
async function current(cache: Cache, path: string, manifest: Manifest): Promise<Response | undefined> {
  const hit = await cache.match(path);
  return hit?.headers.get("etag") === manifest[path] ? hit : undefined;
}

/** Drops files the server no longer has and requests, at low priority, every one that is missing or out of date. */
async function prefetch(manifest: Manifest): Promise<void> {
  const cache = await caches.open(CACHE);
  const cached = await cache.keys();
  await Promise.all(cached.filter((req) => !(new URL(req.url).pathname in manifest)).map((req) => cache.delete(req)));
  // Switched off for everyone. e2e/perf measured it: downloading every file only makes the second visit faster, at
  // the price of the whole download on the first one (about 12 MB), a slower first visit on a slow link and a slower
  // update; a visit after a small release is as fast without it. A file is cached when the page asks for it.
  // eslint-disable-next-line no-constant-condition -- the prefetch stays written; this is its switch
  if (false) {
    await Promise.all(
      Object.keys(manifest).map(async (path) => {
        if (!(await current(cache, path, manifest))) {
          await download(path, "low").catch(() => {});
        }
      }),
    );
  }
}

interface Sync {
  manifest: Promise<Manifest | undefined>;
  /** Settles when the low-priority downloads have. */
  done: Promise<void>;
}

function startSync(): Sync {
  const manifest = loadManifest();
  const done = manifest.then((m) => (m ? prefetch(m) : undefined)).catch(() => {});
  return { manifest, done };
}

if (onLoopback(sw.location.hostname)) {
  // No fetch handler: every request goes to the server. Anything an earlier version cached is dropped.
  sw.addEventListener("install", (event) => event.waitUntil(sw.skipWaiting()));
  sw.addEventListener("activate", (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((names) => Promise.all(names.map((n) => caches.delete(n))))
        .then(() => sw.clients.claim()),
    );
  });
} else {
  // Started with the worker; a page load asks again, so a worker that stays alive does not hold an old list.
  let sync = startSync();

  sw.addEventListener("install", (event) => event.waitUntil(sw.skipWaiting()));

  sw.addEventListener("activate", (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
        .then(() => sw.clients.claim()),
    );
    event.waitUntil(sync.done);
  });

  sw.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (
      req.method !== "GET" ||
      req.headers.has("range") ||
      url.origin !== sw.location.origin ||
      url.pathname === MANIFEST_PATH ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/__dev/")
    ) {
      return;
    }
    if (req.mode === "navigate") {
      sync = startSync();
    }
    const { manifest, done } = sync;
    event.waitUntil(done);
    const path = url.pathname;
    event.respondWith(
      (async () => {
        // The loading page may be stale: it only fetches app.html, which is checked against the list. The sync
        // started above brings the copy up to date for the next load.
        if (path === "/" || path === "/index.html") {
          const hit = await caches.open(CACHE).then((cache) => cache.match(path));
          if (hit) {
            return hit;
          }
        }
        return manifest.then(async (m) => {
          // No list, or a file the server does not list: not ours to cache.
          if (!m?.[path]) {
            return fetch(req);
          }
          const cache = await caches.open(CACHE);
          return (await current(cache, path, m)) ?? download(path, "auto");
        });
      })(),
    );
  });
}
