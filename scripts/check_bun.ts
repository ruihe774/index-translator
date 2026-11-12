// Checks that a Bun has what the server uses, for the minimal build of scripts/build_bun.ts, which leaves parts of
// Bun out: one small use of each API, without a GPU, models or a browser. Exits non-zero, naming what failed.
// Usage: vendor/bun/bun scripts/check_bun.ts

import { dlopen } from "bun:ffi";

const failures: string[] = [];

async function check(name: string, run: () => unknown): Promise<void> {
  // Said before it runs, so a check that hangs is the last line in the log.
  console.log(`checking ${name}`);
  try {
    const value = await run();
    if (value !== true) {
      throw new Error(`got ${String(value)}`);
    }
    console.log(`ok ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A 2×2 PNG (the example of POST /translate in docs/openapi.yaml). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQAAAABazTCJAAAADElEQVQI12M4wHAAAAMEAYHFO6KpAAAAAElFTkSuQmCC",
  "base64",
);

await check("Bun.serve and fetch", async () => {
  using server = Bun.serve({ port: 0, fetch: () => new Response("served") });
  return (await (await fetch(server.url)).text()) === "served";
});
await check("HTMLRewriter", async () => {
  const rewriter = new HTMLRewriter().on("p", { element: (el) => void el.setAttribute("id", "x") });
  return (await rewriter.transform(new Response("<p>a</p>")).text()) === '<p id="x">a</p>';
});
await check("Bun.Transpiler", async () =>
  (await new Bun.Transpiler({ loader: "ts" }).transform("const a: number = 1; export { a };")).includes("const a = 1"),
);
await check("Bun.Image", async () => {
  const png = await new Bun.Image(PNG).png({ compressionLevel: 0 }).bytes();
  return png.length > 0 && png[1] === 0x50;
});
await check("Bun.WebView", () => typeof Bun.WebView === "function");
await check("bun:ffi", () => {
  const pid =
    process.platform === "win32"
      ? dlopen("kernel32.dll", { GetCurrentProcessId: { args: [], returns: "u32" } }).symbols.GetCurrentProcessId()
      : dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
          getpid: { args: [], returns: "i32" },
        }).symbols.getpid();
  return pid === process.pid;
});
await check("Worker", async () => {
  const url = URL.createObjectURL(new Blob(["self.onmessage = (e) => self.postMessage(e.data * 2);"]));
  const worker = new Worker(url);
  const doubled = await new Promise((done) => {
    worker.onmessage = (e: MessageEvent) => done(e.data);
    worker.postMessage(21);
  });
  worker.terminate();
  return doubled === 42;
});
await check("WebCrypto (ECDH, HKDF, AES-GCM, ECDSA)", async () => {
  const P256 = { name: "ECDH", namedCurve: "P-256" } as const;
  const a = await crypto.subtle.generateKey(P256, true, ["deriveBits"]);
  const b = await crypto.subtle.generateKey(P256, true, ["deriveBits"]);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: b.publicKey }, a.privateKey, 256);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const salt = new Uint8Array(16);
  const cek = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: salt }, ikm, 128);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, aes, salt);
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.privateKey, salt);
  return sealed.byteLength === 32 && signature.byteLength === 64;
});
await check(
  "Intl.Segmenter",
  () => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment("é👍🏽")].length === 2,
);
await check("Bun.Glob", () => new Bun.Glob("*.ts").match("check_bun.ts"));
await check(
  "Bun.spawnSync",
  () => Bun.spawnSync([process.execPath, "--version"]).stdout.toString().trim() === Bun.version,
);

if (failures.length > 0) {
  console.error(`${process.execPath} lacks what the server uses:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`ok ${process.execPath} (bun ${Bun.version}) has what the server uses`);
