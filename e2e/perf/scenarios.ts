// The visits that are measured. Two chains, each in one fresh browser context so that what an earlier visit left
// behind (HTTP cache, service worker, its cache) is what the next one starts with.

import type { Browser, Page } from "@playwright/test";

import type { Metrics, Scenario } from "./profiles";
import type { Proxy } from "./proxy";

const VISIT_TIMEOUT_MS = 180_000;

/** The files a small release changes: ones the page loads at start, so they are on the way to showing it. */
const PATCH_FILES = ["/app.ts", "/render.ts", "/state.ts", "/messages.ts", "/css/layout.css"];

type Results = Partial<Record<Scenario, Metrics>>;

/** The time, on the page's clock (zero at the start of the navigation), at which the page showed itself. */
async function whenVisible(page: Page): Promise<number> {
  const handle = await page.waitForFunction(
    () => (document.body?.style.opacity === "1" ? performance.now() : false),
    undefined,
    {
      polling: "raf",
      timeout: VISIT_TIMEOUT_MS,
    },
  );
  return (await handle.jsonValue()) as number;
}

async function paints(page: Page): Promise<{ fcpMs?: number; lcpMs?: number }> {
  return page.evaluate(async () => {
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
    // Largest contentful paint is only offered to an observer; the buffered flag hands over what already happened.
    const lcp = await new Promise<number | undefined>((resolve) => {
      new PerformanceObserver((list) => resolve(list.getEntries().at(-1)?.startTime)).observe({
        type: "largest-contentful-paint",
        buffered: true,
      });
      setTimeout(() => resolve(undefined), 1000);
    });
    return { fcpMs: fcp, lcpMs: lcp };
  });
}

/** The time at which the service worker's cache held every file at the version the server lists. */
async function whenSynced(page: Page): Promise<number> {
  return page.evaluate(async (limitMs) => {
    await navigator.serviceWorker.ready;
    const res = await fetch("/asset-manifest.json", { cache: "no-store" });
    const manifest = (await res.json()) as Record<string, string>;
    const start = performance.now();
    for (;;) {
      const current = await Promise.all(
        Object.entries(manifest).map(async ([path, etag]) => (await caches.match(path))?.headers.get("etag") === etag),
      );
      if (current.every(Boolean)) {
        return performance.now();
      }
      if (performance.now() - start > limitMs) {
        throw new Error("the service worker did not finish downloading");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }, VISIT_TIMEOUT_MS);
}

/** Opens `url` and measures it; with `sync`, also waits for the service worker's cache to be up to date. */
async function visit(page: Page, proxy: Proxy, url: string, sync: boolean): Promise<Metrics> {
  proxy.mark();
  await page.goto(url, { waitUntil: "commit" });
  const visibleMs = await whenVisible(page);
  const metrics: Metrics = { visibleMs, requests: 0, bytes: 0 };
  if (sync) {
    metrics.syncMs = await whenSynced(page);
  } else {
    await page.waitForLoadState("networkidle");
  }
  Object.assign(metrics, await paints(page));
  metrics.requests = proxy.log.length;
  metrics.bytes = proxy.log.reduce((sum, entry) => sum + entry.bytes, 0);
  return metrics;
}

/** No service worker: `cold`, then `warm-http` with what the first visit left in the HTTP cache. */
export async function plainChain(browser: Browser, proxy: Proxy, url: string): Promise<Results> {
  const context = await browser.newContext({ serviceWorkers: "block", locale: "en-US" });
  try {
    const page = await context.newPage();
    return {
      cold: await visit(page, proxy, url, false),
      "warm-http": await visit(page, proxy, url, false),
    };
  } finally {
    await context.close();
  }
}

/**
 * With the service worker: `first-sw`, `warm-sw`, `again-sw`, `sw-update` after all the server's files changed and, once that has settled,
 * `sw-patch` after only `PATCH_FILES` did. A worker that
 * prefetches is waited for until its cache is complete; one that does not (`lazy`) never is, so the visit ends when
 * the page's own requests have.
 */
export async function workerChain(browser: Browser, proxy: Proxy, url: string, prefetch: boolean): Promise<Results> {
  const context = await browser.newContext({ serviceWorkers: "allow", locale: "en-US" });
  try {
    const page = await context.newPage();
    const first = await visit(page, proxy, url, prefetch);
    const warm = await visit(page, proxy, url, prefetch);
    const again = await visit(page, proxy, url, prefetch);
    // A visit that the worker did not answer would measure the network and call it the cache.
    if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
      throw new Error("the second visit was not controlled by the service worker");
    }
    proxy.release();
    const update = await visit(page, proxy, url, prefetch);
    // A visit to settle: a lazy worker brings a file up to date only when the page asks for it.
    await visit(page, proxy, url, prefetch);
    proxy.release(PATCH_FILES);
    return {
      "first-sw": first,
      "warm-sw": warm,
      "again-sw": again,
      "sw-update": update,
      "sw-patch": await visit(page, proxy, url, prefetch),
    };
  } finally {
    await context.close();
  }
}
