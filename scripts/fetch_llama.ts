// Download the pinned llama.cpp Vulkan build into ./vendor/llama.cpp and verify its checksum.
// Usage: bun scripts/fetch_llama.ts

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const TAG = "b11552";
const ASSET = `llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`;
const SHA256 = "c7bb933f3584b73296fbadea6e0d6273ddb7907699ec59ef08d0bb59e0a8b997";
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${ASSET}`;

const root = resolve(import.meta.dir, "..");
const dest = join(root, "vendor", "llama.cpp");
const tarball = join(root, "vendor", ASSET);

await mkdir(join(root, "vendor"), { recursive: true });

console.log(`downloading ${URL}`);
const res = await fetch(URL);
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const bytes = await res.bytes();

const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
if (got !== SHA256) throw new Error(`checksum mismatch: want ${SHA256}, got ${got}`);
await Bun.write(tarball, bytes);

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
const tar = Bun.spawn(["tar", "xzf", tarball, "-C", dest, "--strip-components=1"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await tar.exited) !== 0) throw new Error("tar extraction failed");
await rm(tarball);
await Bun.write(join(dest, "VERSION"), `${TAG}\n`);

const probe = Bun.spawnSync([join(dest, "llama-server"), "--list-devices"], { stderr: "ignore" });
console.log(probe.stdout.toString().trim());
console.log(`ok ${dest} (${TAG})`);
