// Fetch turndown into vendor/turndown/: the library that turns a web page's HTML into Markdown for
// `POST /webpage`. It runs inside the page the server opens (Bun.WebView, src/webpage.ts), so the
// browser build is taken (dist/turndown.js, which defines `TurndownService`), from the npm package
// downloaded from the registry by version and checksum, with its license. Without it fetching a web
// page is unavailable.
// Usage: bun scripts/fetch_turndown.ts
//
// A directory that already holds the pinned version is left alone. Needs nothing besides Bun and tar (`tar.exe` of Windows 10 1803 and later).

import { join, resolve } from "node:path";

import { fetchLibrary, isPresent, type Library } from "./fetch_web_libs";

export const TURNDOWN: Library = {
  dir: "turndown",
  version: "7.2.5",
  url: "https://registry.npmjs.org/turndown/-/turndown-7.2.5.tgz",
  sha256: "7e91c1d36c07a6fd25825734ac71890e89a4113a431e138af8b02b1c99e98e0b",
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
