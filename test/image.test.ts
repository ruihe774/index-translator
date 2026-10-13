// An uploaded image on its way to the engine (src/image.ts) and through the API (mock engine): every
// format takes the same path through Bun.Image and reaches the engine as a PNG.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type App, startApp } from "../src/app";
import { ImageRejected, MAX_IMAGE_BYTES, prepareImage } from "../src/image";
import { imageChatPrompt } from "../src/llama-ffi";
import {
  CHAT,
  config,
  DOCUMENT,
  IMAGE_TOKENS,
  launcher,
  mock,
  PNG,
  postTo,
  readSse,
  resetMock,
  speechLauncher,
  TEMPLATE,
  waitReady,
} from "./helpers/mock-engine";

/** A white 2 × 2 GIF: an image, but not one the API takes. */
const GIF = Buffer.from("R0lGODlhAgACAPAAAP///wAAACH5BAAAAAAALAAAAAACAAIAAAIChFEAOw==", "base64");
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (bytes: Uint8Array) => PNG_MAGIC.every((b, i) => bytes[i] === b);
const rejection = async (file: Uint8Array) => {
  try {
    await prepareImage(file);
  } catch (e) {
    if (e instanceof ImageRejected) return e;
    throw e;
  }
  throw new Error("the image was accepted");
};

describe("prepareImage", () => {
  test("JPEG, WebP and PNG all come out as a PNG of the same size", async () => {
    const jpeg = await new Bun.Image(PNG).jpeg().bytes();
    const webp = await new Bun.Image(PNG).webp().bytes();
    for (const file of [PNG, jpeg, webp]) {
      const png = await prepareImage(file);
      expect(isPng(png)).toBe(true);
      expect(await new Bun.Image(png).metadata()).toEqual({ width: 2, height: 2, format: "png" });
    }
  });

  test("a PNG is written again, not passed through", async () => {
    // With bytes after its end the upload is still a PNG to Bun; what the engine gets has none of them.
    const padded = Buffer.concat([PNG, Buffer.from("not part of the image")]);
    const png = await prepareImage(padded);
    expect(isPng(png)).toBe(true);
    expect(Buffer.from(png).includes("not part of the image")).toBe(false);
  });

  test("a very large picture is scaled down in proportion; one the engine can take is left as it is", async () => {
    const big = await new Bun.Image(PNG).resize(6000, 4000).jpeg().bytes();
    const scaled = await new Bun.Image(await prepareImage(big)).metadata();
    expect(scaled.width * scaled.height).toBeLessThanOrEqual(16_100_000);
    expect(scaled.width * scaled.height).toBeGreaterThan(15_900_000);
    expect(scaled.width / scaled.height).toBeCloseTo(1.5, 2);

    // A long screenshot: many pixels on one side, few in all.
    const long = await new Bun.Image(PNG).resize(400, 9000).png().bytes();
    expect(await new Bun.Image(await prepareImage(long)).metadata()).toMatchObject({ width: 400, height: 9000 });
  });

  test("what is not a JPEG, PNG or WebP image is refused as invalid", async () => {
    expect(await rejection(Buffer.from("hello world, this is text"))).toMatchObject({ code: "invalid_request" });
    const gif = await rejection(GIF);
    expect(gif.code).toBe("invalid_request");
    expect(gif.message).toContain("gif");
  });

  test("a file over the size limit is refused before it is decoded", async () => {
    expect(await rejection(new Uint8Array(MAX_IMAGE_BYTES + 1))).toMatchObject({ code: "image_too_large" });
  });
});

describe("imageChatPrompt", () => {
  test("splits the chat prompt where the image stands: after the content, before the end of the turn", () => {
    expect(imageChatPrompt("  translate this ", true)).toEqual([
      "<|im_start|>user\ntranslate this ",
      "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
    ]);
    expect(imageChatPrompt("a\0b", false)).toEqual(["<|im_start|>user\na\0b", "<|im_end|>\n<|im_start|>assistant\n"]);
  });
});

describe("POST /translate with an image", () => {
  let app: App;
  let base: string;
  const post = (body: unknown) => postTo(base, "/api/v1/translate", body);
  const image = PNG.toString("base64");

  beforeAll(async () => {
    app = await startApp(config(), launcher, speechLauncher);
    base = app.server.url.origin;
    await waitReady(app);
  });
  afterEach(resetMock);
  afterAll(() => app.stop());

  test("translates without a text: the image prompt, and the image as a PNG, reach the engine", async () => {
    mock.requests.length = 0;
    const res = await post({ image, target_lang: "zh", source_lang: "en" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { translation: string }).translation).toBe("Hello, world");
    expect(mock.requests).toHaveLength(1);
    const sent = mock.requests[0]!;
    expect(sent.prompt).toBe("请将图片中的英语文本翻译为中文，直接输出翻译结果，不要进行任何解释。");
    expect(isPng(sent.image!)).toBe(true);
  });

  test("a data: URL and a JPEG are taken the same way", async () => {
    mock.requests.length = 0;
    const jpeg = Buffer.from(await new Bun.Image(PNG).jpeg().bytes()).toString("base64");
    const res = await post({ image: `data:image/jpeg;base64,${jpeg}`, target_lang: "zh" });
    expect(res.status).toBe(200);
    expect(isPng(mock.requests[0]!.image!)).toBe(true);
  });

  test("the image counts towards the prompt, and glossary and constraints go into its prompt", async () => {
    mock.requests.length = 0;
    const res = await post({
      image,
      text: "the menu",
      target_lang: "en",
      glossary: { 拉面: "ramen" },
      hard_constraints: ["保留数字"],
      soft_constraints: ["口语化"],
      stream: true,
    });
    const events = await readSse(res);
    const prompt = mock.requests[0]!.prompt;
    expect(prompt).toBe(
      "请将图片中的文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n" +
        "【参考文本/关注内容】\nthe menu\n\n【硬性要求】保留数字\n\n【软性要求】口语化\n\n【专名/术语对照】拉面→ramen\n\n" +
        "只输出翻译结果，不要进行任何解释。",
    );
    expect(events[0]).toMatchObject({
      event: "start",
      data: { prompt_tokens: Array.from(prompt).length + TEMPLATE.length + IMAGE_TOKENS },
    });
    expect(events.at(-1)!.event).toBe("done");
  });

  test("what is not an image is a 400 on the image field, before anything is queued", async () => {
    mock.requests.length = 0;
    for (const bad of [Buffer.from("plain text, not an image").toString("base64"), GIF.toString("base64"), "", 7]) {
      const res = await post({ image: bad, target_lang: "zh" });
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: { code: string; details: { field: string } } };
      expect(error.code).toBe("invalid_request");
      expect(error.details.field).toBe("image");
    }
    expect(mock.requests).toHaveLength(0);
  });

  test("an image over 8 MiB is a 413 image_too_large; a body that is too large without it stays body_too_large", async () => {
    const big = await post({ image: Buffer.alloc(MAX_IMAGE_BYTES + 100, 1).toString("base64"), target_lang: "zh" });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("image_too_large");

    const padded = await post({ image, target_lang: "zh", text: "x".repeat(4 * 1024 * 1024) });
    expect(padded.status).toBe(413);
    expect(((await padded.json()) as { error: { code: string } }).error.code).toBe("body_too_large");
  });

  test("a large image fits although the body is over 4 MiB", async () => {
    // Bytes after the image's end: still the same picture, but a body of more than 5 MiB.
    const large = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]).toString("base64");
    expect(large.length).toBeGreaterThan(5 * 1024 * 1024);
    expect((await post({ image: large, target_lang: "zh" })).status).toBe(200);
  });

  test("the document model takes no image, and genre does not go with one", async () => {
    const doc = await post({ model: DOCUMENT, image, source_lang: "en", target_lang: "zh" });
    expect(doc.status).toBe(400);
    expect(((await doc.json()) as { error: { details: { field: string } } }).error.details.field).toBe("image");
    const genre = await post({ image, target_lang: "zh", genre: "字幕", hard_constraints: ["x"] });
    expect(genre.status).toBe(400);
    expect(((await genre.json()) as { error: { details: { field: string } } }).error.details.field).toBe("genre");
  });

  test("a missing image encoder is 503 image_unavailable, in JSON and as an SSE error", async () => {
    mock.imageUnavailable = "the image encoder of index-translate-9b is not at /models/x.gguf";
    const res = await post({ image, target_lang: "zh" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("image_unavailable");
    const events = await readSse(await post({ image, target_lang: "zh", stream: true }));
    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "image_unavailable" } });
  });

  test("an image the engine cannot read is the client's error, not an engine failure", async () => {
    mock.imageFailWith = "the image could not be decoded";
    const res = await post({ image, target_lang: "zh" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    // The engine is fine: the next request is served.
    resetMock();
    expect((await post({ text: "hello", target_lang: "zh" })).status).toBe(200);
  });

  test("/tokenize refuses an image; /models says which model takes one and what it may be", async () => {
    const res = await postTo(base, "/api/v1/tokenize", { image, target_lang: "zh" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { details: { field: string } } }).error.details.field).toBe("image");

    const models = (await (await fetch(`${base}/api/v1/models`)).json()) as {
      models: { id: string; image: boolean }[];
      image: unknown;
    };
    expect(models.models.map((m) => [m.id, m.image])).toEqual([
      [CHAT, true],
      [DOCUMENT, false],
    ]);
    expect(models.image).toEqual({
      formats: ["image/jpeg", "image/png", "image/webp"],
      max_bytes: MAX_IMAGE_BYTES,
      max_pixels: 50_000_000,
    });
  });
});
