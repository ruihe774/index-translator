// scripts/fetch_models.ts against a local server that stands in for Hugging Face, with the real curl.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acceptNotices,
  type Download,
  FetchError,
  fetchFile,
  fetchModels,
  MODEL_IDS,
  NOTICES,
  parseArgs,
  plan,
} from "../scripts/fetch_models";
import { EMBED_MODEL_FILE, MODELS } from "../src/models";

const curl = Bun.which("curl");
const sha256 = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** 300 kB that no prefix of can be mistaken for the whole. */
const CONTENT = new Uint8Array(300_000).map((_, i) => (i * 31 + (i >> 8)) & 0xff);

let server: ReturnType<typeof Bun.serve>;
let endpoint = "";
let dir = "";
/** Range headers of the requests for /file, in order. */
let ranges: (string | null)[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/redirect") {
        return Response.redirect("/file", 302);
      }
      if (path !== "/file") {
        return new Response("not here", { status: 404 });
      }
      const range = req.headers.get("range");
      ranges.push(range);
      const from = Number(range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
      if (!range) {
        return new Response(CONTENT);
      }
      if (from >= CONTENT.length) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${CONTENT.length}` } });
      }
      return new Response(CONTENT.subarray(from), {
        status: 206,
        headers: { "content-range": `bytes ${from}-${CONTENT.length - 1}/${CONTENT.length}` },
      });
    },
  });
  endpoint = `http://127.0.0.1:${server.port}`;
});

beforeEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = mkdtempSync(join(tmpdir(), "fetch-models-"));
  ranges = [];
});

afterAll(() => server.stop(true));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const file = (overrides: Partial<Download> = {}): Download => ({
  url: "/file",
  sha256: sha256(CONTENT),
  dest: join(dir, "sub", "model.gguf"),
  ...overrides,
});

async function run(download: Download): Promise<{ error?: FetchError; log: string[] }> {
  const log: string[] = [];
  try {
    await fetchFile(download, endpoint, curl!, (line) => void log.push(line));
    return { log };
  } catch (e) {
    if (!(e instanceof FetchError)) {
      throw e;
    }
    return { error: e, log };
  }
}

describe("parseArgs", () => {
  test("no --model means every model", () => {
    expect(parseArgs([])).toStrictEqual({ ids: MODEL_IDS, rest: [] });
  });

  test("--model is repeatable, in both spellings, and the rest is left for the server's settings", () => {
    expect(parseArgs(["--model", "index-nailong-9b", "--models-dir", "/m", "--model=index-tts-2.5"])).toStrictEqual({
      ids: ["index-nailong-9b", "index-tts-2.5"],
      rest: ["--models-dir", "/m"],
    });
  });

  test("an unknown model and a missing value are refused", () => {
    expect(() => parseArgs(["--model", "nope"])).toThrow(FetchError);
    expect(() => parseArgs(["--model"])).toThrow("--model needs a value");
  });
});

describe("plan", () => {
  const dirs = { models: "/m", speechModel: "/s", separationModel: "/b", voices: "/v" };

  test("every model the server knows has a pinned download named like its file", () => {
    for (const model of MODELS) {
      const [download] = plan([model.id], dirs);
      expect(download!.dest).toBe(join("/m", model.file));
      expect(download!.url).toEndWith(`/${model.file}`);
      expect(download!.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("a model's image encoder is downloaded with it, from the same revision", () => {
    for (const model of MODELS) {
      const files = plan([model.id], dirs);
      expect(files).toHaveLength(model.mmproj ? 2 : 1);
      if (!model.mmproj) {
        continue;
      }
      expect(files[1]!.dest).toBe(join("/m", model.mmproj));
      expect(files[1]!.url).toBe(files[0]!.url.replace(model.file, model.mmproj));
      expect(files[1]!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(files[1]!.sha256).not.toBe(files[0]!.sha256);
    }
  });

  test("the separation model is one pinned file in its own directory", () => {
    const files = plan(["bs-roformer"], dirs);
    expect(files).toHaveLength(1);
    expect(files[0]!.dest).toBe(join("/b", "bs-roformer-ep368-q8_0.gguf"));
    expect(files[0]!.url).toContain("/audio-cpp/audio.cpp-gguf/resolve/");
    expect(files[0]!.url).toEndWith("/BS-RoFormer-ep368-GGUF/bs-roformer-ep368-q8_0.gguf");
    expect(files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0]!.keep).toBeUndefined();
    expect(MODEL_IDS).toContain("bs-roformer");
  });

  test("the embedding model is one pinned file in the models directory, named as the server expects", () => {
    const files = plan(["bge-m3"], dirs);
    expect(files).toHaveLength(1);
    expect(files[0]!.dest).toBe(join("/m", EMBED_MODEL_FILE));
    expect(files[0]!.url).toContain("/ggml-org/bge-m3-Q8_0-GGUF/resolve/");
    expect(files[0]!.url).toEndWith(`/${EMBED_MODEL_FILE}`);
    expect(files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0]!.keep).toBeUndefined();
    expect(MODEL_IDS).toContain("bge-m3");
  });

  test("the speech model comes with the example voices, which never replace a file of the user's", () => {
    const files = plan(["index-tts-2.5"], dirs);
    expect(files[0]!.dest).toBe(join("/s", "index-tts2_5-q8_0.gguf"));
    const voices = files.slice(1);
    expect(voices.length).toBeGreaterThan(0);
    for (const voice of voices) {
      expect(voice.dest).toStartWith(join("/v", "voice_"));
      expect(voice.keep).toBe(true);
    }
  });
});

describe.skipIf(!curl)("fetchFile", () => {
  test("downloads into a new directory, through a redirect, and leaves no .part file", async () => {
    const download = file({ url: "/redirect" });
    const { error, log } = await run(download);
    expect(error).toBeUndefined();
    expect(sha256(await Bun.file(download.dest).bytes())).toBe(download.sha256);
    expect(existsSync(`${download.dest}.part`)).toBe(false);
    expect(log.at(-1)).toBe(`ok ${download.dest}`);
  });

  test("a file that is already there and right is not downloaded again", async () => {
    const download = file();
    mkdirSync(join(dir, "sub"));
    await Bun.write(download.dest, CONTENT);
    expect((await run(download)).log).toStrictEqual([`ok ${download.dest}`]);
    expect(ranges).toStrictEqual([]);
  });

  test("a wrong file under the name is reported and left alone", async () => {
    const download = file();
    mkdirSync(join(dir, "sub"));
    await Bun.write(download.dest, "something else");
    const { error } = await run(download);
    expect(error?.message).toContain("is not the expected file");
    expect(error?.message).toContain("delete it");
    await expect(Bun.file(download.dest).text()).resolves.toBe("something else");
    expect(ranges).toStrictEqual([]);
  });

  test("a file of the user's under a voice's name is kept", async () => {
    const download = file({ keep: true });
    mkdirSync(join(dir, "sub"));
    await Bun.write(download.dest, "my own voice");
    const { error, log } = await run(download);
    expect(error).toBeUndefined();
    expect(log[0]).toStartWith("kept ");
    await expect(Bun.file(download.dest).text()).resolves.toBe("my own voice");
  });

  test("an interrupted download continues where it stopped", async () => {
    const download = file();
    mkdirSync(join(dir, "sub"));
    await Bun.write(`${download.dest}.part`, CONTENT.subarray(0, 100_000));
    expect((await run(download)).error).toBeUndefined();
    expect(ranges).toStrictEqual(["bytes=100000-"]);
    expect(sha256(await Bun.file(download.dest).bytes())).toBe(download.sha256);
  });

  test("a .part file that is already complete is taken as it is", async () => {
    const download = file();
    mkdirSync(join(dir, "sub"));
    await Bun.write(`${download.dest}.part`, CONTENT);
    expect((await run(download)).error).toBeUndefined();
    expect(sha256(await Bun.file(download.dest).bytes())).toBe(download.sha256);
    expect(existsSync(`${download.dest}.part`)).toBe(false);
  });

  test("a download with the wrong checksum is deleted and never gets the real name", async () => {
    const download = file({ sha256: sha256("another file") });
    const { error } = await run(download);
    expect(error?.message).toContain("is not the expected file");
    expect(existsSync(download.dest)).toBe(false);
    expect(existsSync(`${download.dest}.part`)).toBe(false);
  });

  test("a failed request says so with curl's exit code, and keeps what was already downloaded", async () => {
    const download = file({ url: "/missing" });
    mkdirSync(join(dir, "sub"));
    await Bun.write(`${download.dest}.part`, CONTENT.subarray(0, 100_000));
    const { error } = await run(download);
    expect(error?.message).toContain("failed (curl exit code 22)");
    expect(error?.message).toContain("continues where it stopped");
    expect(existsSync(download.dest)).toBe(false);
    expect(Bun.file(`${download.dest}.part`).size).toBe(100_000);
  });

  test("a host that cannot be reached fails without a stack of retries", async () => {
    const log: string[] = [];
    const attempt = fetchFile(file(), "http://127.0.0.1:9", curl!, (line) => void log.push(line));
    await expect(attempt).rejects.toThrow(/failed \(curl exit code 7\); check the network connection/);
  });
});

describe("notices", () => {
  const dirs = () => ({
    models: join(dir, "m"),
    speechModel: join(dir, "s"),
    separationModel: join(dir, "b"),
    voices: join(dir, "v"),
  });

  test("every model has a notice, and THIRD_PARTY_NOTICES.md covers it", async () => {
    const doc = await Bun.file(join(import.meta.dir, "..", "THIRD_PARTY_NOTICES.md")).text();
    for (const id of MODEL_IDS) {
      expect(NOTICES[id]).toBeTruthy();
      expect(doc).toContain(`\`${id}\``);
    }
    expect(NOTICES["index-tts-2.5"]).toContain("bilibili Model Use License");
    expect(NOTICES["bge-m3"]).toContain("MIT");
  });

  test('the notices of what is missing are printed, then only "yes" lets the download go on', async () => {
    for (const answer of ["yes", " YES \n"]) {
      const log: string[] = [];
      const questions: string[] = [];
      await acceptNotices(
        ["index-translate-9b", "bs-roformer"],
        dirs(),
        (l) => void log.push(l),
        (q) => {
          questions.push(q);
          return Promise.resolve(answer);
        },
      );
      expect(log.join("\n")).toContain(NOTICES["index-translate-9b"]!);
      expect(log.join("\n")).toContain(NOTICES["bs-roformer"]!);
      expect(log.join("\n")).not.toContain(NOTICES["index-tts-2.5"]!);
      expect(questions).toHaveLength(1);
    }
  });

  test("anything but yes, and an empty answer, stops with nothing downloaded", async () => {
    for (const answer of ["", "y", "no", "yes please"]) {
      const attempt = acceptNotices(
        ["index-tts-2.5"],
        dirs(),
        () => {},
        () => Promise.resolve(answer),
      );
      await expect(attempt).rejects.toThrow("not accepted");
    }
  });

  test("a model whose files are all there asks nothing", async () => {
    const d = dirs();
    mkdirSync(d.separationModel, { recursive: true });
    const [f] = plan(["bs-roformer"], d);
    await Bun.write(f!.dest, "x");
    const log: string[] = [];
    await acceptNotices(
      ["bs-roformer"],
      d,
      (l) => void log.push(l),
      () => Promise.reject(new Error("asked")),
    );
    expect(log).toStrictEqual([]);
  });

  test("fetchModels asks before it writes anything", async () => {
    if (!curl) {
      return;
    }
    const models = join(dir, "models");
    const attempt = fetchModels(
      ["--model", "index-translate-9b", "--models-dir", models],
      Bun.env,
      () => {},
      () => Promise.resolve("no"),
    );
    await expect(attempt).rejects.toThrow("not accepted");
    expect(existsSync(models)).toBe(false);
  });
});

describe("fetchModels", () => {
  test("without curl it stops with an instruction, before anything is written", async () => {
    const models = join(dir, "models");
    const attempt = fetchModels(["--models-dir", models], { PATH: join(dir, "no-such-bin") });
    await expect(attempt).rejects.toThrow(/curl is needed .* install it/);
    expect(existsSync(models)).toBe(false);
  });

  test("a bad setting is a plain error, not a crash", async () => {
    await expect(fetchModels(["--no-such-flag"], {})).rejects.toBeInstanceOf(FetchError);
  });
});
