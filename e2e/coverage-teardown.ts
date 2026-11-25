// Playwright `globalTeardown` of a coverage run: merges what the workers collected into one report.

import { MCR } from "monocart-coverage-reports";

import { REPORT } from "./coverage";

export default async function teardown() {
  await MCR(REPORT).generate();
}
