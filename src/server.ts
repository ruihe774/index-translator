// Entry point: bun src/server.ts

import { startApp } from "./app";
import { loadConfig } from "./config";
import { openBrowser } from "./open-browser";

const cfg = loadConfig();
const app = await startApp(cfg);
console.error(`[server] listening on ${app.server.url} (default model ${cfg.defaultModel}, context ${cfg.ctxSize})`);

if (cfg.openBrowser) {
  // A wildcard bind address is not browsable; use loopback instead.
  const wildcard = cfg.host === "0.0.0.0" || cfg.host === "::";
  openBrowser(wildcard ? `http://127.0.0.1:${app.server.port}/` : app.server.url.href);
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    console.error(`[server] ${sig}, shutting down`);
    await app.stop();
    process.exit(0);
  });
}
