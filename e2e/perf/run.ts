// Page load measurements under a throttled link, with and without the service worker, over HTTP/1.1 and HTTP/2.
//
//   bun run e2e:perf [--profile fast,slow] [--protocol h2] [--scenario cold,warm-sw] [--repeats 3]
//
// Starts the mock server (e2e/mock-server.ts) on PERF_PORT (3200), a throttling proxy for each protocol on the next
// two ports, and drives Chromium. Results go to stdout and to perf-results/<time>.json. Nothing is asserted: the
// numbers depend on the machine, so compare runs of the same one. e2e/README.md has the details.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "@playwright/test";

import { selfSignedCert } from "./cert";
import { PROFILES, PROTOCOLS, SCENARIOS } from "./profiles";
import type { Metrics, Protocol, Row, Scenario } from "./profiles";
import { startProxy } from "./proxy";
import { table } from "./report";
import { plainChain, workerChain } from "./scenarios";

const root = join(import.meta.dir, "..", "..");
const PORT = Number(process.env.PERF_PORT ?? 3200);
const HOST = "app.test";
const upstream = `http://127.0.0.1:${PORT}`;
const origins: Record<Protocol, string> = { h1: `http://${HOST}:${PORT + 1}/`, h2: `https://${HOST}:${PORT + 2}/` };

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    protocol: { type: "string" },
    scenario: { type: "string" },
    repeats: { type: "string", default: "3" },
  },
});

/** The comma-separated `--name` value as a subset of `all`; every name must be one of them. */
function choose<T extends string>(name: string, given: string | undefined, all: readonly T[]): T[] {
  if (given === undefined) {
    return [...all];
  }
  const names = given.split(",");
  const unknown = names.filter((n) => !all.includes(n as T));
  if (unknown.length) {
    throw new Error(`--${name}: unknown ${unknown.join(", ")}; known: ${all.join(", ")}`);
  }
  return names as T[];
}

const profiles = choose(
  "profile",
  values.profile,
  PROFILES.map((p) => p.name),
).map((name) => PROFILES.find((p) => p.name === name)!);
const protocols = choose("protocol", values.protocol, PROTOCOLS);
const scenarios = choose("scenario", values.scenario, SCENARIOS);
const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1) {
  throw new Error("--repeats must be a positive integer");
}
const wants = (list: readonly Scenario[]) => list.some((s) => scenarios.includes(s));

if (!existsSync(join(root, "public", "vendor", "pdfjs"))) {
  console.error(
    "warning: public/vendor is empty (bun scripts/fetch_web_libs.ts); the page is lighter than the real one",
  );
}

const scratch = mkdtempSync(join(tmpdir(), "perf-"));
const app = Bun.spawn(["bun", "e2e/mock-server.ts"], {
  cwd: root,
  env: { ...process.env, E2E_PORT: String(PORT), E2E_CONTROL_PORT: String(PORT + 100) },
  stdout: "ignore",
  stderr: "inherit",
});
const rows: Row[] = [];
let proxies: ReturnType<typeof startProxy>[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let i = 0; ; i++) {
    if ((await fetch(`${upstream}/api/v1/health`).catch(() => null))?.ok) {
      break;
    }
    if (i === 150 || app.exitCode !== null) {
      throw new Error("the mock server did not start");
    }
    await Bun.sleep(200);
  }
  const cert = await selfSignedCert(scratch, HOST);
  const proxy = {
    h1: startProxy({ port: PORT + 1, upstream }),
    h2: startProxy({ port: PORT + 2, upstream, tls: cert }),
  };
  proxies = Object.values(proxy);
  browser = await chromium.launch({
    // The service worker needs a secure context, which http://app.test is not: the flag makes it one. The headless
    // shell (Playwright's default for headless) ignores the flag; the "chromium" channel is the full browser. An
    // explicit CHROMIUM_PATH should be a full Chromium too.
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }),
    args: [
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
      `--unsafely-treat-insecure-origin-as-secure=${origins.h1.slice(0, -1)}`,
      "--ignore-certificate-errors",
    ],
  });

  // Repeats outermost, so a drift of the machine spreads over the cells instead of landing on one.
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const protocol of protocols) {
      for (const profile of profiles) {
        const url = origins[protocol];
        const record = (results: Partial<Record<Scenario, Metrics>>) => {
          for (const scenario of scenarios) {
            const metrics = results[scenario];
            if (metrics) {
              rows.push({ scenario, profile: profile.name, protocol, repeat, metrics });
            }
          }
        };
        if (wants(["cold", "warm-http"])) {
          proxy[protocol].use(profile);
          record(await plainChain(browser, proxy[protocol], url));
        }
        if (wants(["first-sw", "warm-sw", "again-sw", "sw-update", "sw-patch"])) {
          proxy[protocol].use(profile);
          record(await workerChain(browser, proxy[protocol], url));
        }
        console.error(`repeat ${repeat}/${repeats} ${protocol} ${profile.name} done`);
      }
    }
  }
} finally {
  await browser?.close();
  for (const p of proxies) {
    await p.stop();
  }
  app.kill();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(table(rows));
const dir = join(root, "perf-results");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().replaceAll(":", "-")}.json`);
await Bun.write(file, JSON.stringify({ repeats, rows }, null, 2));
console.error(`written to ${file}`);
