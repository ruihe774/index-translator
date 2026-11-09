// The service worker. The server lists every file it serves with its ETag (/asset-manifest.json).
// The worker fetches that list first, answers a request from the cache only when the cached copy has
// the listed ETag, and otherwise downloads the file and caches it, so a file is cached once the page has
// asked for it. So no stale file is ever served, except the loading page (index.html), which is answered
// from the cache without waiting for the list: it only fetches app.html, which is checked. The price for
// the rest is a slower first render, and the app is no use without its server anyway. (Downloading every
// missing or outdated file at low priority right after the list arrives is written but switched off, see
// `prefetch`.)
// On loopback (development, or the app on its own machine) the worker caches nothing. Neither does it when the
// list's request fails with an error status or answers something that is not JSON: the server is then not ours, and
// the worker does not assume it is.
// On every origin it shows the notification of a push message (src/push.ts, public/push.ts): a job
// that ended while no page was reading it.

import type { PushMessage } from "../src/api.ts";

/** The part of the service worker scope that is used (the DOM library has no `webworker` types). */
interface WorkerScope {
  location: Location;
  registration: ServiceWorkerRegistration;
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: WorkerEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEvent) => void): void;
}
interface WorkerEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends WorkerEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
interface PushEvent extends WorkerEvent {
  data: { json(): unknown } | null;
}
interface NotificationEvent extends WorkerEvent {
  notification: Notification;
}
interface WindowClient {
  url: string;
  focus(): Promise<unknown>;
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

/** The list; `null` when the server answers but not with a list (not our server); undefined when it cannot be reached. */
async function loadManifest(): Promise<Manifest | null | undefined> {
  let res: Response;
  try {
    res = await fetch(MANIFEST_PATH, { cache: "no-store" });
  } catch {
    return undefined;
  }
  if (!res.ok) {
    return null;
  }
  try {
    return (await res.json()) as Manifest;
  } catch {
    // Ok, but not JSON (a fallback page): not our server. A body cut off by the network lands here too.
    return null;
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
}

interface Sync {
  manifest: Promise<Manifest | null | undefined>;
  /** Settles when the low-priority downloads have. */
  done: Promise<void>;
}

/** Set when the server answered the list with an error: it is not ours, so nothing is cached or served from the cache. */
let foreign = false;

function startSync(): Sync {
  const manifest = loadManifest();
  const done = manifest
    .then(async (m) => {
      foreign = m === null;
      if (m) {
        await prefetch(m);
      } else if (foreign) {
        await caches.delete(CACHE);
      }
    })
    .catch(() => {});
  return { manifest, done };
}

const TITLES: Record<PushMessage["job"], Record<PushMessage["outcome"], string>> = {
  translation: { done: "Translation finished", error: "Translation failed" },
  transcription: { done: "Transcription finished", error: "Transcription failed" },
};

// Chrome counts a push that shows no notification against the site, so every message shows one.
sw.addEventListener("push", (event) => {
  let message: PushMessage | undefined;
  try {
    message = event.data?.json() as PushMessage | undefined;
  } catch {}
  const title = (message && TITLES[message.job]?.[message.outcome]) ?? "A job ended";
  event.waitUntil(
    sw.registration.showNotification(title, {
      body: message?.text ?? "Open Index Translator to see it.",
      icon: "/icons/icon-192.png",
      // A second message about the same job replaces the first.
      tag: message?.id ?? "job",
    }),
  );
});

// The page reconnects to the job by itself when it is shown again (resume.ts), so a click only brings it up.
sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const page = windows.find((w) => new URL(w.url).origin === sw.location.origin);
      return page ? page.focus() : sw.clients.openWindow("/");
    }),
  );
});

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
        if (!foreign && (path === "/" || path === "/index.html")) {
          const hit = await caches.open(CACHE).then((cache) => cache.match(path));
          if (hit) {
            return hit;
          }
        }
        return manifest.then(async (m) => {
          // No list (unreachable, or not our server), or a file the server does not list: not ours to cache.
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
