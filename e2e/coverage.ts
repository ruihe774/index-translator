// Coverage of the browser tests (`bun run e2e:coverage`, `E2E_COVERAGE=1`).
//
// - Web app: Chromium's own JS coverage of every page, mapped back to `public/*.ts` and merged over all workers
//   by monocart-coverage-reports. The server transpiles `.ts` on request without a source map, so under
//   coverage the page gets the same modules from `coverage-setup.ts` (`bun build --no-bundle`, inline source
//   maps) instead. Workers started by the page (PDF, Word) are not measured.
// - Server: each mock server runs under `bun test --coverage` (`e2e/mock-server.coverage.test.ts`; see the
//   Playwright config), one report per worker in `coverage/e2e-server/<n>/lcov.info`.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CoverageReportOptions } from "monocart-coverage-reports";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export const COVERAGE = Boolean(process.env.E2E_COVERAGE);
export const ROOT = at("..");
export const OUT = at("../coverage");
/** `public/*.ts` with inline source maps, written by `coverage-setup.ts`. */
export const MAPPED = at("../coverage/.public");

export const REPORT: CoverageReportOptions = {
  name: "Web app (browser tests)",
  outputDir: `${OUT}/e2e-web`,
  reports: ["lcov", "text-summary"],
  // The page is on 127.0.0.1; its modules are the ones under public/ (the PDF and Word libraries are not ours).
  entryFilter: (entry) => new URL(entry.url).hostname === "127.0.0.1",
  // A module's source map names it relative to the page, which monocart prefixes with the host and port.
  sourceFilter: (path) => /^127\.0\.0\.1-\d+\/(?!vendor\/)/.test(path),
  sourcePath: (path) => path.replace(/^127\.0\.0\.1-\d+\//, "public/"),
};

/** The mapped module for a request path (`/app.ts` or `/app.js`), if the page's file is one of ours. */
export function mappedModule(pathname: string): string | undefined {
  const file = `${MAPPED}${pathname.replace(/\.(ts|js)$/, "")}.js`;
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}
