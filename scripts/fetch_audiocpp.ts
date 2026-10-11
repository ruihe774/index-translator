// Download the pinned audio.cpp Vulkan build (the speech engine that runs IndexTTS-2.5) into
// ./vendor/audio.cpp and verify its checksum.
// Usage: bun scripts/fetch_audiocpp.ts
//
// The "portable" archive picks its CPU code path at run time. The plain Vulkan archive is built for
// AVX-512 and dies with SIGILL on CPUs without it.

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const TAG = "v0.9.1";
const ASSET = `audio-${TAG}-bin-ubuntu-x64-vulkan-portable.tar.gz`;
const SHA256 = "1aae59b03d10c0fa289fe11f4529ef8325bec4dad5c003652b99c23f3d9f5e32";
const URL = `https://github.com/0xShug0/audio.cpp/releases/download/${TAG}/${ASSET}`;

const root = resolve(import.meta.dir, "..");
const dest = join(root, "vendor", "audio.cpp");
const tarball = join(root, "vendor", ASSET);

console.log(`downloading ${URL}`);
const res = await fetch(URL);
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const archive = await res.bytes();
const got = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
if (got !== SHA256) throw new Error(`checksum mismatch for ${URL}: want ${SHA256}, got ${got}`);

// Fetched and verified before the existing copy is replaced.
await mkdir(join(root, "vendor"), { recursive: true });
await Bun.write(tarball, archive);
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
const tar = Bun.spawn(["tar", "xzf", tarball, "-C", dest], { stdout: "inherit", stderr: "inherit" });
if ((await tar.exited) !== 0) throw new Error("tar extraction failed");
await rm(tarball);
await Bun.write(join(dest, "VERSION"), `${TAG}\n`);

const probe = Bun.spawnSync([join(dest, "audiocpp_server"), "--backend", "vulkan", "--list-devices"], {
  stderr: "ignore",
});
console.log(probe.stdout.toString().trim());
console.log(`ok ${dest} (${TAG})`);
