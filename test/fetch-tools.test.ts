// scripts/fetch_tools.ts without the network (a local server stands in for it): checksums, stamps, the
// archive readers and "download unless the copy here is right".

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadUnlessMatches,
  fileMatches,
  readStamp,
  sha256Hex,
  untar,
  unzip,
  writeStamp,
} from "../scripts/fetch_tools";

/** A ustar archive, gzipped, as npm packs one: a 512-byte header and the padded content per entry. */
function tgz(entries: { name: string; prefix?: string; type?: string; content?: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const content = encoder.encode(e.content ?? "");
    const header = new Uint8Array(512);
    header.set(encoder.encode(e.name), 0);
    header.set(encoder.encode(`${content.length.toString(8).padStart(11, "0")}\0`), 124);
    header.set(encoder.encode(e.type ?? "0"), 156);
    header.set(encoder.encode("ustar"), 257);
    header.set(encoder.encode(e.prefix ?? ""), 345);
    const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
    padded.set(content);
    blocks.push(header, padded);
  }
  blocks.push(new Uint8Array(1024));
  return Bun.gzipSync(Buffer.concat(blocks));
}

const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);

describe("untar", () => {
  test("gives the files by their path below the top-level directory", () => {
    const files = untar(
      tgz([
        { name: "package/", type: "5" },
        { name: "package/LICENSE", content: "MIT" },
        { name: "package/build/pdf.mjs", content: "x".repeat(700) },
        { name: "worker.mjs", prefix: "package/legacy/build", content: "w" },
        { name: "package/empty" },
      ]),
    );
    expect([...files.keys()]).toStrictEqual(["LICENSE", "build/pdf.mjs", "legacy/build/worker.mjs", "empty"]);
    expect(text(files.get("LICENSE"))).toBe("MIT");
    expect(files.get("build/pdf.mjs")).toHaveLength(700);
    expect(text(files.get("legacy/build/worker.mjs"))).toBe("w");
    expect(files.get("empty")).toHaveLength(0);
  });

  test("refuses paths that leave the directory and entries that are not files", () => {
    expect(() => untar(tgz([{ name: "package/../../etc/passwd", content: "x" }]))).toThrow("refusing path");
    expect(() => untar(tgz([{ name: "package/link", type: "2" }]))).toThrow("unexpected entry type");
  });
});

/** A zip archive of stored (method 0) or deflated (8) entries, with the central directory unzip reads. */
function zip(entries: { name: string; content: string; deflate?: boolean }[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = encoder.encode(e.name);
    const raw = encoder.encode(e.content);
    const data = e.deflate ? Bun.deflateSync(raw) : raw;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04_03_4b_50, true);
    lv.setUint16(8, e.deflate ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02_01_4b_50, true);
    cv.setUint16(10, e.deflate ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);
    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06_05_4b_50, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directory.length, true);
  ev.setUint32(16, offset, true);
  return Buffer.concat([...parts, directory, end]);
}

describe("unzip", () => {
  test("gives the wanted files, stored or deflated, by their path below the top-level directory", () => {
    const files = unzip(
      zip([
        { name: "pkg/", content: "" },
        { name: "pkg/lib/a.dll", content: "binary", deflate: true },
        { name: "pkg/LICENSE", content: "MIT" },
        { name: "pkg/other.txt", content: "left out" },
      ]),
      (path) => path === "lib/a.dll" || path === "LICENSE",
    );
    expect([...files.keys()]).toStrictEqual(["lib/a.dll", "LICENSE"]);
    expect(text(files.get("lib/a.dll"))).toBe("binary");
    expect(text(files.get("LICENSE"))).toBe("MIT");
  });

  test("refuses what is not a zip archive, and paths that leave the directory", () => {
    expect(() => unzip(new Uint8Array(40), () => true)).toThrow("not a zip archive");
    expect([...unzip(zip([{ name: "pkg/../evil", content: "x" }]), () => true).keys()]).toStrictEqual([]);
  });
});

describe("checksums and stamps", () => {
  let dir: string;
  beforeAll(async () => void (dir = await mkdtemp(join(tmpdir(), "fetch-tools-"))));

  afterAll(() => rm(dir, { recursive: true, force: true }));

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
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fetch-tools-"));
    server = Bun.serve({
      port: 0,
      fetch() {
        requests++;
        return new Response("the tool");
      },
    });
  });

  afterAll(async () => {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

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
