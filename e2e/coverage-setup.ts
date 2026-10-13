// Playwright `globalSetup` of a coverage run: clears the old reports and writes `public/**/*.ts` with inline
// source maps for `coverage.ts` (see there for why).

import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";

import { MAPPED, OUT, ROOT } from "./coverage";

export default function setup() {
  // Only this run's own output: `coverage/unit` may be from the unit tests before.
  for (const dir of [MAPPED, `${OUT}/e2e-web`, `${OUT}/e2e-server`]) {
    rmSync(dir, { recursive: true, force: true });
  }
  const entries = readdirSync(`${ROOT}/public`, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.startsWith("vendor/"))
    .map((path) => `public/${path}`);
  const build = spawnSync(
    "bun",
    ["build", "--no-bundle", "--sourcemap=inline", "--root=public", `--outdir=${MAPPED}`, ...entries],
    { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (build.status !== 0) {
    throw new Error("bun build of public/ failed");
  }
}
