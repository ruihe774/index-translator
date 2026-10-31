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
 * - `first-sw`: first visit with the service worker, which installs and downloads every file.
 * - `warm-sw`: the next visit, answered by the worker from its cache.
 * - `sw-update`: the next visit after the server's files changed (every ETag outside `/vendor/`).
 */
export const SCENARIOS = ["cold", "warm-http", "first-sw", "warm-sw", "sw-update"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface Metrics {
  /** From the start of the navigation until the page shows itself (`visibility-gate.ts` sets the opacity to 1). */
  visibleMs: number;
  fcpMs?: number;
  lcpMs?: number;
  /** Service worker only: until its cache holds every file at the version the server lists. */
  syncMs?: number;
  /** Requests the proxy saw, until the page (and the worker's downloads) went quiet. */
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
