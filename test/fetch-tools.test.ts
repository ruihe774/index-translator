// scripts/fetch_tools.ts without the network (a local server stands in for it): checksums, stamps and "download
// unless the copy here is right".

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { downloadUnlessMatches, fileMatches, readStamp, sha256Hex, writeStamp } from "../scripts/fetch_tools";
import { tempDir } from "./helpers/harness";

describe("checksums and stamps", () => {
  let dir: string;
  beforeAll(() => void (dir = tempDir("fetch-tools-")));

  test("sha256Hex of a known string", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });

  test("fileMatches: false for a missing file and a different one", async () => {
    const path = join(dir, "file.bin");
    await expect(fileMatches(path, sha256Hex("abc"))).resolves.toBe(false);
    await Bun.write(path, "abc");
    await expect(fileMatches(path, sha256Hex("abc"))).resolves.toBe(true);
    await expect(fileMatches(path, sha256Hex("abd"))).resolves.toBe(false);
  });

  test("a stamp reads back as written, and is undefined before", async () => {
    const stamped = join(dir, "stamped");
    await expect(readStamp(stamped)).resolves.toBeUndefined();
    await writeStamp(stamped, "1.2.3 abc\n");
    await expect(readStamp(stamped)).resolves.toBe("1.2.3 abc\n");
  });
});

describe("downloadUnlessMatches", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let requests = 0;
  beforeAll(() => {
    dir = tempDir("fetch-tools-");
    server = Bun.serve({
      port: 0,
      fetch() {
        requests++;
        return new Response("the tool");
      },
    });
  });

  afterAll(() => server.stop(true));

  test("downloads into a new directory, then leaves a matching copy alone", async () => {
    const pin = { url: `http://127.0.0.1:${server.port}/tool`, sha256: sha256Hex("the tool") };
    const path = join(dir, "bin", "tool");
    await downloadUnlessMatches(pin, path);
    await expect(Bun.file(path).text()).resolves.toBe("the tool");
    expect(requests).toBe(1);
    await downloadUnlessMatches(pin, path);
    expect(requests).toBe(1);
  });

  test("replaces a copy with another checksum, and refuses a download that does not match the pin", async () => {
    const url = `http://127.0.0.1:${server.port}/tool`;
    const path = join(dir, "stale");
    await Bun.write(path, "stale");
    await downloadUnlessMatches({ url, sha256: sha256Hex("the tool") }, path);
    await expect(Bun.file(path).text()).resolves.toBe("the tool");
    await expect(downloadUnlessMatches({ url, sha256: sha256Hex("other") }, join(dir, "never"))).rejects.toThrow(
      "checksum mismatch",
    );
    await expect(Bun.file(join(dir, "never")).exists()).resolves.toBe(false);
  });
});
