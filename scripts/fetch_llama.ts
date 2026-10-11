// Download the pinned llama.cpp Vulkan build into ./vendor/llama.cpp, with the C headers of the
// same tag in ./vendor/llama.cpp/include (the release archive has none), and verify checksums.
// Usage: bun scripts/fetch_llama.ts

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const TAG = "b11552";
const ASSET = `llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`;
const SHA256 = "c7bb933f3584b73296fbadea6e0d6273ddb7907699ec59ef08d0bb59e0a8b997";
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${ASSET}`;

// llama.h and everything it includes; src/llama-shim.c is compiled against them.
const RAW = `https://raw.githubusercontent.com/ggml-org/llama.cpp/${TAG}`;
const HEADERS: Record<string, string> = {
  "include/llama.h": "948cc00d355471c4309aa58d9f05410a58a27122ef419af439c0d17215065a92",
  "ggml/include/ggml.h": "12ee71f99db7db9b353bc02b1fbb57c344ee17c01ac5fb7952b41a637a747ea9",
  "ggml/include/ggml-alloc.h": "d114067f9099c4a0e2bbc0625c676d4894d9cf0ea27168ee072c7de0e71bb51d",
  "ggml/include/ggml-backend.h": "6f10f2abca95dd3e7040c650b1bc005111a495c2f2d8ceea57dfe3a438b8b412",
  "ggml/include/ggml-cpu.h": "316279e004cdeb8e6ef78599acb602bf79a8abdf897fed9fd1914808c1518c6e",
  "ggml/include/ggml-opt.h": "3586de1bc8a934b5c72339e2b6937b0641e8f149b512231e666f67de0736eea2",
  "ggml/include/gguf.h": "e56714aab702e5ce62ee587a409643c08f7e93e8fbb77f48ef7cc85075f96fa4",
};

const root = resolve(import.meta.dir, "..");
const dest = join(root, "vendor", "llama.cpp");
const tarball = join(root, "vendor", ASSET);

async function download(url: string, sha256: string): Promise<Uint8Array> {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = await res.bytes();
  const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (got !== sha256) throw new Error(`checksum mismatch for ${url}: want ${sha256}, got ${got}`);
  return bytes;
}

await mkdir(join(root, "vendor"), { recursive: true });

// Everything is fetched and verified before the existing copy is replaced.
const archive = await download(URL, SHA256);
const headers = await Promise.all(
  Object.entries(HEADERS).map(async ([path, sha256]) => ({
    name: path.slice(path.lastIndexOf("/") + 1),
    bytes: await download(`${RAW}/${path}`, sha256),
  })),
);

await Bun.write(tarball, archive);
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
const tar = Bun.spawn(["tar", "xzf", tarball, "-C", dest, "--strip-components=1"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await tar.exited) !== 0) throw new Error("tar extraction failed");
await rm(tarball);
for (const { name, bytes } of headers) await Bun.write(join(dest, "include", name), bytes);
await Bun.write(join(dest, "VERSION"), `${TAG}\n`);

const probe = Bun.spawnSync([join(dest, "llama-server"), "--list-devices"], { stderr: "ignore" });
console.log(probe.stdout.toString().trim());
console.log(`ok ${dest} (${TAG})`);
