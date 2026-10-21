// Fetch turndown into vendor/turndown/: the library that turns a web page's HTML into Markdown for
// `POST /webpage`. It runs inside the page the server opens (Bun.WebView, src/webpage.ts), so the
// browser build is taken (dist/turndown.js, which defines `TurndownService`), from the npm package
// downloaded from the registry by version and checksum, with its license. Without it fetching a web
// page is unavailable.
// Usage: bun scripts/fetch_turndown.ts
//
// A directory that already holds the pinned version is left alone. Needs nothing besides Bun.

import { join, resolve } from "node:path";

import { fetchLibrary, isPresent, type Library } from "./fetch_web_libs";

export const TURNDOWN: Library = {
  dir: "turndown",
  version: "7.2.4",
  url: "https://registry.npmjs.org/turndown/-/turndown-7.2.4.tgz",
  sha256: "05f61bc3f0aeca5e5cd7f1b5492e26b9040bb00708cd41fb1b0f7b216e296fa0",
  place: (path) => (path === "dist/turndown.js" ? "turndown.js" : path === "LICENSE" ? path : undefined),
  expect: ["turndown.js", "LICENSE"],
};

/** Throws, naming this script, unless `vendor` holds the pinned turndown. */
export async function requireTurndown(vendor: string): Promise<void> {
  if (!(await isPresent(TURNDOWN, vendor))) {
    throw new Error(
      `${join(vendor, TURNDOWN.dir)} is missing or not ${TURNDOWN.version}; run: bun scripts/fetch_turndown.ts`,
    );
  }
}

if (import.meta.main) {
  if (Bun.argv.length > 2) {
    throw new Error(`unknown option ${Bun.argv[2]}; this script takes none`);
  }
  await fetchLibrary(TURNDOWN, resolve(import.meta.dir, "..", "vendor"));
}
