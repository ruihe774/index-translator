// scripts/extract_tools.ts: tar and zip archives unpacked below their top-level directory.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { zip } from "@stdx/zip";

import { extractTar, extractZip } from "../scripts/extract_tools";
import { tempDir } from "./helpers/harness";

/** A ustar archive, gzipped, as npm packs one: a 512-byte header and the padded content per entry. */
function tgz(entries: { name: string; prefix?: string; type?: string; content?: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const content = encoder.encode(e.content ?? "");
    const header = new Uint8Array(512);
    header.set(encoder.encode(e.name), 0);
    header.set(encoder.encode(e.type === "5" ? "0000755\0" : "0000644\0"), 100);
    header.set(encoder.encode(`${content.length.toString(8).padStart(11, "0")}\0`), 124);
    header.set(encoder.encode(e.type ?? "0"), 156);
    header.set(encoder.encode("ustar"), 257);
    header.set(encoder.encode(e.prefix ?? ""), 345);
    header.fill(0x20, 148, 156); // the checksum field counts as spaces while it is summed
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
    padded.set(content);
    blocks.push(header, padded);
  }
  blocks.push(new Uint8Array(1024));
  return Bun.gzipSync(Buffer.concat(blocks));
}

describe("extractTar", () => {
  test("unpacks below the top-level directory", async () => {
    const dir = join(tempDir("extract-tar-"), "out");
    await extractTar(
      tgz([
        { name: "package/", type: "5" },
        { name: "package/LICENSE", content: "MIT" },
        { name: "package/build/pdf.mjs", content: "x".repeat(700) },
        { name: "worker.mjs", prefix: "package/legacy/build", content: "w" },
        { name: "package/empty" },
      ]),
      dir,
      "gz",
    );
    await expect(Bun.file(join(dir, "LICENSE")).text()).resolves.toBe("MIT");
    expect(Bun.file(join(dir, "build/pdf.mjs")).size).toBe(700);
    await expect(Bun.file(join(dir, "legacy/build/worker.mjs")).text()).resolves.toBe("w");
    expect(Bun.file(join(dir, "empty")).size).toBe(0);
  });

  test("fails on an archive tar cannot read", async () => {
    await expect(extractTar(new TextEncoder().encode("not a tar"), tempDir("extract-tar-"), "gz")).rejects.toThrow(
      "tar failed",
    );
  });
});

describe("extractZip", () => {
  test("unpacks below the top-level directory", async () => {
    const dir = join(tempDir("extract-zip-"), "out");
    await extractZip(
      await zip([
        { path: "pkg/lib/a.dll", data: "binary" },
        { path: "pkg/LICENSE", data: "MIT" },
        { path: "pkg/empty", data: "" },
      ]),
      dir,
    );
    await expect(Bun.file(join(dir, "lib/a.dll")).text()).resolves.toBe("binary");
    await expect(Bun.file(join(dir, "LICENSE")).text()).resolves.toBe("MIT");
    expect(Bun.file(join(dir, "empty")).size).toBe(0);
  });

  test("refuses what is not a zip archive, and paths that leave the directory", async () => {
    const dir = tempDir("extract-zip-");
    await expect(extractZip(new Uint8Array(40), dir)).rejects.toThrow("Not a zip archive");
    await expect(extractZip(await zip([{ path: "pkg/../evil", data: "x" }]), dir)).rejects.toThrow("refusing path");
    await expect(Bun.file(join(dir, "evil")).exists()).resolves.toBe(false);
  });
});
