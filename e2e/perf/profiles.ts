// What the perf suite varies: the link (bandwidth and round trip), the protocol the browser speaks to it, and the
// visit being measured.

export interface Profile {
  name: string;
  /** Megabits per second; 0 is unlimited. */
  mbit: number;
  /** Milliseconds a request waits before the app sees it plus before its answer starts (one round trip). */
  rttMs: number;
}

/** Loopback is how the app is usually served; the others stand for a deployment behind a personal network. */
export const PROFILES: Profile[] = [
  { name: "loopback", mbit: 0, rttMs: 0 },
  { name: "fast", mbit: 20, rttMs: 40 },
  { name: "slow", mbit: 5, rttMs: 100 },
];

/** What the browser speaks to the proxy: plain HTTP/1.1, or HTTP/2 over TLS (as `tailscale serve` does). */
export const PROTOCOLS = ["h1", "h2"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/**
 * - `cold`: first visit, no service worker, empty HTTP cache.
 * - `warm-http`: the next visit of the same context, no service worker: the HTTP cache only.
 * - `first-sw`: first visit with the service worker, which installs while the page loads.
 * - `warm-sw`: the next visit, the first the worker controls: it fills its cache with what the page asks for (the
 *   first visit ran before the worker controlled the page).
 * - `again-sw`: the visit after that: the first answered from the worker's cache.
 * - `sw-update`: the next visit after the server's files changed (every ETag outside `/vendor/`: a full update).
 * - `sw-patch`: after that update has settled, the next visit once only a few files (`PATCH_FILES`) have changed.
 */
export const SCENARIOS = ["cold", "warm-http", "first-sw", "warm-sw", "again-sw", "sw-update", "sw-patch"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface Metrics {
  /** From the start of the navigation until the page shows itself (`visibility-gate.ts` sets the opacity to 1). */
  visibleMs: number;
  fcpMs?: number;
  lcpMs?: number;
  /** Requests the proxy saw, until the page went quiet. */
  requests: number;
  /** Response body bytes the proxy sent in that time. */
  bytes: number;
}

export interface Row {
  scenario: Scenario;
  profile: string;
  protocol: Protocol;
  repeat: number;
  metrics: Metrics;
}
