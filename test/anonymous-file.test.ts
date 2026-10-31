// Uploads kept in anonymous files (src/anonymous-file.ts): nothing named on disk, readable by descriptor.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { anonymousFile, openAnonymousFiles, readAnonymousFile } from "../src/anonymous-file";
import { tempDir } from "./helpers/harness";

const windows = process.platform === "win32";
// No TMPDIR is set for the tests, so the files go to /var/tmp, or on Windows the system's temporary directory.
// eslint-disable-next-line bun/no-literal-temp-dir -- the directory src/anonymous-file.ts writes to
const fallback = windows ? tmpdir() : "/var/tmp";
const ours = () => readdirSync(fallback).filter((name) => name.startsWith("index-translator-"));

test("the bytes are read back by descriptor, and no file name is left behind", async () => {
  const before = { names: ours(), open: openAnonymousFiles() };
  const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251);
  const file = await anonymousFile(bytes);
  expect(ours()).toStrictEqual(before.names);
  expect(openAnonymousFiles()).toBe(before.open + 1);
  expect(readAnonymousFile(file.fd)).toStrictEqual(bytes);
  // From the start again, whatever was read before.
  expect(readAnonymousFile(file.fd)).toStrictEqual(bytes);
  await file.close();
  await file.close();
  expect(openAnonymousFiles()).toBe(before.open);
  expect(() => readAnonymousFile(file.fd)).toThrow();
});

describe("a directory that cannot be written is passed over", () => {
  const saved = process.env.TMPDIR;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = saved;
    }
  });

  test.each([
    ["missing", () => join(tempDir("anonymous-file-"), "gone")],
    [
      "not ours to write",
      () => {
        const dir = tempDir("anonymous-file-");
        chmodSync(dir, 0o500);
        return dir;
      },
    ],
  ])("a TMPDIR that is %s falls back to the next directory", async (kind, make) => {
    // Root writes anywhere, and Windows ignores a folder's mode, so the read-only case would not be one.
    if (process.getuid?.() === 0 || (windows && kind === "not ours to write")) {
      return;
    }
    process.env.TMPDIR = make();
    const before = ours();
    const file = await anonymousFile(new Uint8Array([1, 2, 3]));
    try {
      expect(readAnonymousFile(file.fd)).toStrictEqual(new Uint8Array([1, 2, 3]));
      expect(ours()).toStrictEqual(before);
    } finally {
      await file.close();
    }
  });
});
