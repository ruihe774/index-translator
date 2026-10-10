// Entry point: bun src/server.ts

import { startApp } from "./app";
import { loadConfig } from "./config";

const cfg = loadConfig();
const app = await startApp(cfg);
console.error(`[server] listening on ${app.server.url} (default model ${cfg.defaultModel}, context ${cfg.ctxSize})`);

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
