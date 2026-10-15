// Playwright `globalSetup` of a coverage run: clears the old reports and writes `public/**/*.ts` with inline
// source maps for `coverage.ts` (see there for why).

import { readdirSync, rmSync } from "node:fs";

import { $ } from "bun";

import { MAPPED, OUT, ROOT } from "./coverage";

export default async function setup() {
  // Only this run's own output: `coverage/unit` may be from the unit tests before.
  for (const dir of [MAPPED, `${OUT}/e2e-web`, `${OUT}/e2e-server`]) {
    rmSync(dir, { recursive: true, force: true });
  }
  const entries = readdirSync(`${ROOT}/public`, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.startsWith("vendor/"))
    .map((path) => `public/${path}`);
  const build = await $`bun build --no-bundle --sourcemap=inline --root=public --outdir=${MAPPED} ${entries}`
    .cwd(ROOT)
    .quiet()
    .nothrow();
  if (build.exitCode !== 0) {
    process.stderr.write(build.stderr);
    throw new Error("bun build of public/ failed");
  }
}
