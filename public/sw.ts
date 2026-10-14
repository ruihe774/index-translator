// The service worker: the app's own files come from a cache and are refreshed in the background,
// so the installed app opens at once and the next open has the newest version. The API is never
// touched: translations, speech and health always go to the server.

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

const sw = self as unknown as WorkerScope;
/** Bump to drop everything cached by an older worker. */
const CACHE = "index-translator-v1";
/** Fetched at install, so the first offline-ish open has a page. */
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png"];

/** Everything the server answers under these prefixes is live data or development tooling. */
function cacheable(req: Request): boolean {
  if (req.method !== "GET") {
    return false;
  }
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) {
    return false;
  }
  return !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__dev/");
}

async function staleWhileRevalidate(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(event.request);
  const refresh = fetch(event.request).then((res) => {
    // A full, ordinary answer only: never an error page, a partial range, or a response marked no-store.
    if (res.status === 200 && !res.headers.get("cache-control")?.includes("no-store")) {
      void cache.put(event.request, res.clone()).catch(() => {});
    }
    return res;
  });
  if (!hit) {
    return refresh;
  }
  // Kept alive after the cached answer went out; offline it simply fails and the cache stays.
  event.waitUntil(refresh.catch(() => {}));
  return hit;
}

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (event) => {
  if (cacheable(event.request)) {
    event.respondWith(staleWhileRevalidate(event));
  }
});
