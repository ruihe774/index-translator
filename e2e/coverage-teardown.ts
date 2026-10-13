// Playwright `globalTeardown` of a coverage run: merges what the workers collected into one report.

import { CoverageReport } from "monocart-coverage-reports";

import { REPORT } from "./coverage";

export default async function teardown() {
  await new CoverageReport(REPORT).generate();
}
