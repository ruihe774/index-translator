/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/await-thenable */
// Request parsing, validation, input budget, static files and the error envelope, against the mock
// engine. Complements api.test.ts: each case here is about how a request is read or refused.
// Findings the server gets wrong are written as test.failing and listed in the report.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { type App, startApp } from "../src/app";
import { buildDocumentPrompt, buildPrompt } from "../src/prompt";
import {
  CHAT,
  config,
  DOCUMENT,
  launcher,
  mock,
  postTo,
  readSse,
  resetMock,
  TEMPLATE,
  waitReady,
} from "./helpers/mock-engine";

const MiB = 1024 * 1024;

let app: App;
let base: string;

beforeAll(async () => {
  app = await startApp(config(), launcher);
  base = app.server.url.origin;
  await waitReady(app);
});

afterEach(() => resetMock());

afterAll(() => app.stop());

const post = (path: string, body: unknown, init: RequestInit = {}) => postTo(base, path, body, init);
const json = async (res: Response): Promise<any> => res.json();
const lastUpstreamContent = (): string => mock.requests.at(-1)!.prompt;

/** A translate request body the mock engine accepts. */
const plain = { text: "Hi", target_lang: "zh" };

describe("max_output_tokens", () => {
  test.each([
    ["1.5", 1.5],
    ['the string "5"', "5"],
    ["true", true],
    ["false", false],
    ["a negative number", -1],
    ["zero", 0],
    ["the string NaN", "NaN"],
    ["an object", {}],
  ])("%s is rejected with 400 naming the field", async (_name, value) => {
    const res = await post("/api/v1/translate", { ...plain, max_output_tokens: value });
    expect(res.status).toBe(400);
    const { error } = await json(res);
    expect(error.code).toBe("invalid_request");
    expect(error.details).toStrictEqual({ field: "max_output_tokens" });
  });

  test("1e400 parses to Infinity in JSON and is rejected like any non-integer", async () => {
    const res = await post("/api/v1/translate", '{"text":"Hi","target_lang":"zh","max_output_tokens":1e400}');
    expect(res.status).toBe(400);
    expect((await json(res)).error.details).toStrictEqual({ field: "max_output_tokens" });
  });

  test("null is allowed and means the default budget", async () => {
    const res = await post("/api/v1/translate", { ...plain, max_output_tokens: null });
    expect(res.status).toBe(200);
    await res.text();
    const prompt = buildPrompt({ text: "Hi", targetLang: "zh" });
    const promptTokens = Array.from(prompt).length + TEMPLATE.length;
    expect(mock.requests.at(-1)!.maxTokens).toBe(Math.min(promptTokens * 4 + 512, 1000 - promptTokens - 64));
  });

  test("the smallest legal value is forwarded to the engine as its token limit", async () => {
    const res = await post("/api/v1/translate", { ...plain, max_output_tokens: 1 });
    expect(res.status).toBe(200);
    await res.text();
    expect(mock.requests.at(-1)!.maxTokens).toBe(1);
  });

  test("the smallest legal value is reported as the start event's budget", async () => {
    const events = await readSse(await post("/api/v1/translate", { ...plain, max_output_tokens: 1, stream: true }));
    expect(events.find((e) => e.event === "start")!.data.max_output_tokens).toBe(1);
  });
});

describe("string length limits", () => {
  const chars = (n: number) => "a".repeat(n);

  test("target_lang of 64 characters is accepted, 65 is refused with the field", async () => {
    const ok = await post("/api/v1/translate", { text: "Hi", target_lang: chars(64) });
    expect(ok.status).toBe(200);
    await ok.text();

    const long = await post("/api/v1/translate", { text: "Hi", target_lang: chars(65) });
    expect(long.status).toBe(400);
    const { error } = await json(long);
    expect(error.details).toStrictEqual({ field: "target_lang" });
    expect(error.message).toContain("at most 64");
  });

  test("source_lang of 64 characters is accepted, 65 is refused with the field", async () => {
    const ok = await post("/api/v1/translate", { ...plain, source_lang: chars(64) });
    expect(ok.status).toBe(200);
    await ok.text();

    const long = await post("/api/v1/translate", { ...plain, source_lang: chars(65) });
    expect(long.status).toBe(400);
    expect((await json(long)).error.details).toStrictEqual({ field: "source_lang" });
  });

  test("genre of 64 characters is accepted, 65 is refused even without constraints", async () => {
    const ok = await post("/api/v1/translate", { ...plain, glossary: { a: "b" }, genre: chars(64) });
    expect(ok.status).toBe(200);
    await ok.text();

    const long = await post("/api/v1/translate", { ...plain, genre: chars(65) });
    expect(long.status).toBe(400);
    expect((await json(long)).error.details).toStrictEqual({ field: "genre" });
  });

  test("model of 65 characters is refused with the field; 64 characters gets past the length check", async () => {
    const long = await post("/api/v1/translate", { ...plain, model: chars(65) });
    expect(long.status).toBe(400);
    const longBody = await json(long);
    expect(longBody.error.details).toStrictEqual({ field: "model" });
    expect(longBody.error.message).toContain("at most 64");

    // 64 characters is the right shape but no such model exists, so the failure is the unknown-model one.
    const shaped = await post("/api/v1/translate", { ...plain, model: chars(64) });
    expect(shaped.status).toBe(400);
    const shapedBody = await json(shaped);
    expect(shapedBody.error.details).toStrictEqual({ field: "model" });
    expect(shapedBody.error.message).toContain("unknown model");
  });

  test("target_lang maxLength counts code points as JSON Schema does, so 40 emoji (80 UTF-16 units) are accepted", async () => {
    // optionalString counts code points, not UTF-16 units, so 40 emoji are within the spec's maxLength 64.
    const res = await post("/api/v1/translate", { text: "Hi", target_lang: "🌏".repeat(40) });
    expect(res.status).toBe(200);
    await res.text();
  });
});

describe("type validation of scalar fields", () => {
  test.each([
    ["a number", 5],
    ["a boolean", true],
    ["an array", ["zh"]],
    ["an object", { code: "zh" }],
  ])("target_lang as %s is refused with 400 naming the field", async (_name, value) => {
    const res = await post("/api/v1/translate", { text: "Hi", target_lang: value });
    expect(res.status).toBe(400);
    const { error } = await json(res);
    expect(error.code).toBe("invalid_request");
    expect(error.details).toStrictEqual({ field: "target_lang" });
  });

  test("a whitespace-only target_lang is refused as empty", async () => {
    const res = await post("/api/v1/translate", { text: "Hi", target_lang: "   " });
    expect(res.status).toBe(400);
    expect((await json(res)).error.details).toStrictEqual({ field: "target_lang" });
  });

  test("model: null uses the default model", async () => {
    const res = await post("/api/v1/translate", { ...plain, model: null });
    expect(res.status).toBe(200);
    expect((await json(res)).model).toBe(CHAT);
  });
});

describe("document model field rules", () => {
  const doc = { text: "The fox.", source_lang: "en", target_lang: "zh", model: DOCUMENT };

  test("an empty glossary object is accepted, since it expresses no constraint", async () => {
    const res = await post("/api/v1/translate", { ...doc, glossary: {} });
    expect(res.status).toBe(200);
    expect((await json(res)).model).toBe(DOCUMENT);
  });

  test("empty hard and soft constraint lists are accepted", async () => {
    const res = await post("/api/v1/translate", { ...doc, hard_constraints: [], soft_constraints: [] });
    expect(res.status).toBe(200);
    await res.text();
  });

  test.each([
    ["auto", "auto"],
    ["AUTO", "AUTO"],
    ["whitespace", "   "],
    ["the empty string", ""],
  ])("source_lang %s is refused, since the model has no detection", async (_name, source) => {
    const res = await post("/api/v1/translate", { ...doc, source_lang: source });
    expect(res.status).toBe(400);
    const { error } = await json(res);
    expect(error.details).toStrictEqual({ field: "source_lang" });
  });

  test("padded and upper-case codes are accepted and select the en-zh template", async () => {
    const res = await post("/api/v1/translate", { ...doc, source_lang: " EN ", target_lang: "ZH" });
    expect(res.status).toBe(200);
    await res.text();
    expect(lastUpstreamContent()).toBe(buildDocumentPrompt("en-zh", "The fox."));
  });

  test("source equal to target is an unsupported pair, whatever the case", async () => {
    for (const [source, target] of [
      ["zh", "zh"],
      ["EN", "en"],
      [" ZH ", "zh"],
    ]) {
      const res = await post("/api/v1/translate", { ...doc, source_lang: source, target_lang: target });
      expect(res.status).toBe(400);
      const { error } = await json(res);
      expect(error.code).toBe("unsupported_language_pair");
      expect(error.details.field).toBe("target_lang");
    }
  });

  test("the chat model accepts source equal to target", async () => {
    const res = await post("/api/v1/translate", { text: "你好", source_lang: "zh", target_lang: "zh" });
    expect(res.status).toBe(200);
    expect((await json(res)).model).toBe(CHAT);
  });
});

describe("streaming selection", () => {
  test.each([
    ["application/json", false],
    ["*/*", false],
    ["text/event-stream;q=0.9", true],
    ["application/json, text/event-stream", true],
  ])("Accept: %s returns %s", async (accept, sse) => {
    const res = await post("/api/v1/translate", plain, { headers: { accept } });
    expect(res.status).toBe(200);
    if (sse) {
      expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    } else {
      expect(res.headers.get("content-type")).toStartWith("application/json");
    }
    await res.text();
  });

  test("stream: false does not stop an Accept: text/event-stream request from streaming", async () => {
    // Actual behaviour: the Accept header wins over an explicit stream:false (the server ORs the two).
    const res = await post(
      "/api/v1/translate",
      { ...plain, stream: false },
      { headers: { accept: "text/event-stream" } },
    );
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    expect((await readSse(res)).at(-1)!.event).toBe("done");
  });

  test("stream: true with Accept: application/json still streams, because the body field wins", async () => {
    const res = await post(
      "/api/v1/translate",
      { ...plain, stream: true },
      { headers: { accept: "application/json" } },
    );
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    await res.text();
  });
});

describe("request body size", () => {
  // JSON allows trailing whitespace, so padding a body changes its size without changing its meaning.
  function paddedTo(bytes: number, value: unknown = plain): string {
    const body = JSON.stringify(value);
    return body + " ".repeat(bytes - body.length);
  }

  test("a body of exactly 4 MiB (by Content-Length) is parsed", async () => {
    const body = paddedTo(4 * MiB);
    expect(new TextEncoder().encode(body)).toHaveLength(4 * MiB);
    const res = await post("/api/v1/tokenize", body);
    expect(res.status).toBe(200);
    await res.text();
  });

  test("a body one byte over 4 MiB is refused with body_too_large before parsing", async () => {
    const res = await post("/api/v1/translate", paddedTo(4 * MiB + 1));
    expect(res.status).toBe(413);
    const { error } = await json(res);
    expect(error.code).toBe("body_too_large");
    expect(error.message).toContain(String(4 * MiB));
  });

  function chunkedBody(text: string, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          return controller.close();
        }
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });
  }

  /** A streamed body has no Content-Length, so the server cannot check its size up front. */
  function postChunked(path: string, text: string): Promise<Response> {
    return fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunkedBody(text),
      duplex: "half",
    });
  }

  test("a small chunked body is parsed normally", async () => {
    const res = await postChunked("/api/v1/tokenize", JSON.stringify(plain));
    expect(res.status).toBe(200);
    await res.text();
  });

  test("an oversized chunked translate body is refused with 413, and the server stays healthy", async () => {
    // The envelope for this case is not pinned down: it is input_too_long (the text is over the token
    // limit) rather than body_too_large, because the size check only looks at Content-Length. Status only.
    const res = await postChunked(
      "/api/v1/translate",
      JSON.stringify({ text: "a".repeat(5 * MiB), target_lang: "zh" }),
    );
    expect(res.status).toBe(413);
    await res.text();

    const health = await fetch(base + "/api/v1/health");
    expect(health.status).toBe(200);
    await health.text();
  });

  test("a chunked body over Bun's 16 MiB backstop is refused with 413 and the server stays healthy", async () => {
    // Past the backstop the runtime answers before the handler runs, so there is no JSON envelope.
    const res = await postChunked("/api/v1/tokenize", paddedTo(20 * MiB));
    expect(res.status).toBe(413);
    await res.text();

    const health = await fetch(base + "/api/v1/health");
    expect(health.status).toBe(200);
    await health.text();
  });

  test.failing("a chunked body over 4 MiB is refused even when its extra bytes are whitespace", async () => {
    // Bug: the 4 MiB limit is checked only against Content-Length (src/app.ts parseBody). A streamed
    // 5 MiB body that is valid JSON with trailing whitespace is accepted (200), so the documented
    // 413 body_too_large is not enforced for chunked requests. Only the 16 MiB runtime backstop applies.
    const res = await postChunked("/api/v1/tokenize", paddedTo(5 * MiB));
    expect(res.status).toBe(413);
    await res.text();
  });
});

describe("request body shape", () => {
  test.each([
    ["an empty body", "", /valid JSON/],
    ["the JSON null", "null", /JSON object/],
    ["a JSON string", '"str"', /JSON object/],
    ["a JSON number", "123", /JSON object/],
    ["a JSON array", "[1]", /JSON object/],
  ])("%s is refused with 400 invalid_request", async (_name, body, message) => {
    const res = await post("/api/v1/translate", body);
    expect(res.status).toBe(400);
    const { error } = await json(res);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toMatch(message);
  });

  test("the same shape errors come from /tokenize", async () => {
    for (const body of ["", "null", '"str"', "123"]) {
      const res = await post("/api/v1/tokenize", body);
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("invalid_request");
    }
  });
});

describe("unicode and replacement patterns", () => {
  test("CJK and emoji text reaches the engine intact and comes back intact", async () => {
    const text = "你好，世界 🌏 𝒳 é";
    mock.chunks = ["Hello 🌏 ", "世界"];
    const res = await post("/api/v1/translate", { text, target_lang: "en" });
    expect(res.status).toBe(200);
    expect((await json(res)).translation).toBe("Hello 🌏 世界");
    expect(lastUpstreamContent()).toBe(buildPrompt({ text, targetLang: "en" }));
  });

  test("$& and $1 sequences survive in a chat prompt and in a streamed translation", async () => {
    const text = "价格 $& 和 $1 与 $$ 以及 $' 和 $`";
    mock.chunks = ["$&", " $1 ", "$$"];
    const events = await readSse(await post("/api/v1/translate", { text, target_lang: "en", stream: true }));
    expect(lastUpstreamContent()).toBe(buildPrompt({ text, targetLang: "en" }));
    expect(
      events
        .filter((e) => e.event === "delta")
        .map((e) => e.data.text)
        .join(""),
    ).toBe("$& $1 $$");
  });

  test("$& and $1 sequences survive in the fixed document template", async () => {
    const text = "Price $& and $1 and $$ and $' and $`";
    await (await post("/api/v1/translate", { text, source_lang: "en", target_lang: "zh", model: DOCUMENT })).text();
    expect(lastUpstreamContent()).toBe(buildDocumentPrompt("en-zh", text));
    expect(lastUpstreamContent()).toContain(text);
  });
});

describe("POST /tokenize budget at the default limits (context 1000, max input 400)", () => {
  // The mock counts one token per code point of the content, and the template adds TEMPLATE.length.
  // The prefix is whatever the prompt is with no text, so a text of n characters gives prefix + n.
  const prefixTokens = Array.from(buildPrompt({ text: "", targetLang: "en" })).length + TEMPLATE.length;
  const textFor = (promptTokens: number) => "a".repeat(promptTokens - prefixTokens);
  const exactCount = (text: string) => Array.from(buildPrompt({ text, targetLang: "en" })).length + TEMPLATE.length;

  test("the test text sizes are exact", () => {
    expect(exactCount(textFor(400))).toBe(400);
    expect(exactCount(textFor(401))).toBe(401);
  });

  test("tokenize reports fits at exactly the input limit and not one token over", async () => {
    const at = await json(await post("/api/v1/tokenize", { text: textFor(400), target_lang: "en" }));
    expect(at).toMatchObject({ prompt_tokens: 400, fits: true, max_output_tokens: 536 });

    const over = await json(await post("/api/v1/tokenize", { text: textFor(401), target_lang: "en" }));
    expect(over).toMatchObject({ prompt_tokens: 401, fits: false, max_output_tokens: 535 });
  });

  test("translate accepts a prompt of exactly the input limit and gives it the rest of the context", async () => {
    const events = await readSse(
      await post("/api/v1/translate", { text: textFor(400), target_lang: "en", stream: true }),
    );
    expect(events.find((e) => e.event === "start")!.data).toMatchObject({ prompt_tokens: 400, max_output_tokens: 536 });
  });

  test("translate refuses a prompt one token over the limit with the measured count, and does not generate", async () => {
    const before = mock.requests.length;
    const res = await post("/api/v1/translate", { text: textFor(401), target_lang: "en" });
    expect(res.status).toBe(413);
    const { error } = await json(res);
    expect(error.code).toBe("input_too_long");
    expect(error.details).toStrictEqual({ prompt_tokens: 401, max_input_tokens: 400 });
    expect(mock.requests).toHaveLength(before);
  });

  test("tokenize ignores stream and max_output_tokens and always answers JSON", async () => {
    const plainBody = await json(await post("/api/v1/tokenize", { text: "Hi", target_lang: "zh" }));
    const withIgnored = await post(
      "/api/v1/tokenize",
      { text: "Hi", target_lang: "zh", stream: true, max_output_tokens: 7 },
      { headers: { accept: "text/event-stream" } },
    );
    expect(withIgnored.status).toBe(200);
    expect(withIgnored.headers.get("content-type")).toStartWith("application/json");
    await expect(json(withIgnored)).resolves.toStrictEqual(plainBody);
  });

  test.each([
    ["empty text", { text: "", target_lang: "en" }, "text"],
    ["missing target", { text: "Hi" }, "target_lang"],
    ["unknown model", { text: "Hi", target_lang: "en", model: "gpt" }, "model"],
    ["fractional output cap", { text: "Hi", target_lang: "en", max_output_tokens: 1.5 }, "max_output_tokens"],
    ["non-boolean stream", { text: "Hi", target_lang: "en", stream: "yes" }, "stream"],
    [
      "glossary on the document model",
      { text: "Hi", source_lang: "en", target_lang: "zh", model: DOCUMENT, glossary: { a: "b" } },
      "glossary",
    ],
    [
      "document pair not supported",
      { text: "Hi", source_lang: "en", target_lang: "fr", model: DOCUMENT },
      "target_lang",
    ],
  ])("validates like /translate: %s is a 400", async (_name, body, field) => {
    const res = await post("/api/v1/tokenize", body);
    expect(res.status).toBe(400);
    expect((await json(res)).error.details?.field).toBe(field);
  });
});

describe("static files", () => {
  test("HEAD / returns 200 with no body", async () => {
    const res = await fetch(base + "/", { method: "HEAD" });
    expect(res.status).toBe(200);
    // Bun sends no Content-Type on a HEAD answer, so only the status and the empty body are pinned.
    await expect(res.text()).resolves.toBe("");
  });

  test("POST / is refused with 405 and plain text", async () => {
    const res = await fetch(base + "/", { method: "POST", body: "x" });
    expect(res.status).toBe(405);
    await expect(res.text()).resolves.toBe("Method Not Allowed");
  });

  test("/index.html is served", async () => {
    const res = await fetch(base + "/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    await res.text();
  });

  test("/app.ts is the transpiled module: JavaScript, relative imports intact, revalidated by ETag", async () => {
    const res = await fetch(base + "/app.ts");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const code = await res.text();
    expect(code).toContain('from "./select-model.ts"');
    expect(code).not.toContain(": HTMLElement");

    const etag = res.headers.get("etag")!;
    const again = await fetch(base + "/app.ts", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    await expect(again.text()).resolves.toBe("");
  });

  test("/select-model.ts is served so the browser and bun test share one module", async () => {
    const res = await fetch(base + "/select-model.ts");
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("LONG_THRESHOLD_LETTERS");
  });

  test("a .js request with no .ts behind it is a 404, including traversal to src/*.ts", async () => {
    for (const path of ["/nothing.js", "/..%2fsrc%2fapp.js", "/%2e%2e%2fsrc%2fapp.js"]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(404);
      await expect(res.text()).resolves.not.toContain("startApp");
    }
  });

  test("a percent-encoded traversal stays inside the public directory", async () => {
    for (const path of ["/%2e%2e%2f", "/..%2f..%2fsrc%2fapp.ts", "/%2e%2e%2f%2e%2e%2fdocs%2fopenapi.yaml"]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain("startApp");
      expect(body).not.toContain("openapi: 3.1");
    }
  });

  test("an undecodable path is a 400, not a server error", async () => {
    const res = await fetch(base + "/%ff");
    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toBe("Bad Request");
  });

  test("a trailing slash on a file name is a 404", async () => {
    const res = await fetch(base + "/index.html/");
    expect(res.status).toBe(404);
    await res.text();
  });

  test("/api/v1 without a trailing slash falls through to static files and is a plain 404", async () => {
    // Actual behaviour: only paths under /api/v1/ reach the API switch, so the bare prefix is static.
    const res = await fetch(base + "/api/v1");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    await res.text();
  });

  test("/api/v1/ is an API path and gets the JSON not_found envelope", async () => {
    const res = await fetch(base + "/api/v1/");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    expect((await json(res)).error.code).toBe("not_found");
  });

  test.failing("a null byte in the path is a 400 or 404, not a 500", async () => {
    // Bug: src/app.ts serveStatic passes the decoded path to Bun.file, which throws on a null byte.
    // The throw is answered as an internal error.
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(base + "/%00");
      expect([400, 404]).toContain(res.status);
      await res.text();
    } finally {
      spy.mockRestore();
    }
  });

  test("an unexpected error gets the internal_error envelope, and the server keeps serving", async () => {
    // A null byte in a static path is the one reliable way to reach the unexpected-error branch.
    // The status is pinned to today's behaviour; see the test.failing above for the intended answer.
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(base + "/%00");
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toStartWith("application/json");
      expect((await json(res)).error).toStrictEqual({ code: "internal_error", message: "internal server error" });
    } finally {
      spy.mockRestore();
    }
    const health = await fetch(base + "/api/v1/health");
    expect(health.status).toBe(200);
    await health.text();
  });
});

describe("error envelope", () => {
  function expectEnvelope(body: any, code: string): void {
    expect(Object.keys(body)).toStrictEqual(["error"]);
    expect(body.error.code).toBeTypeOf("string");
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBeTypeOf("string");
  }

  test("every API error is application/json with {error:{code,message}}", async () => {
    const cases: [string, Promise<Response>, string, number][] = [
      ["400 invalid body", post("/api/v1/translate", { text: "", target_lang: "en" }), "invalid_request", 400],
      ["404 unknown endpoint", fetch(base + "/api/v1/nope"), "not_found", 404],
      [
        "405 wrong method",
        fetch(base + "/api/v1/models", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
        "method_not_allowed",
        405,
      ],
      [
        "415 wrong content type",
        post("/api/v1/translate", plain, { headers: { "content-type": "text/plain" } }),
        "unsupported_media_type",
        415,
      ],
      [
        "403 foreign origin",
        post("/api/v1/translate", plain, { headers: { origin: "https://evil.example" } }),
        "forbidden_origin",
        403,
      ],
      [
        "403 foreign host",
        fetch(base + "/api/v1/health", { headers: { host: "rebind.example" } }),
        "forbidden_host",
        403,
      ],
      ["413 body too large", post("/api/v1/translate", paddedBody(4 * MiB + 1)), "body_too_large", 413],
      [
        "413 input too long",
        post("/api/v1/translate", { text: "x".repeat(500), target_lang: "zh" }),
        "input_too_long",
        413,
      ],
    ];
    for (const [label, pending, code, status] of cases) {
      const res = await pending;
      expect({ label, status: res.status }).toStrictEqual({ label, status });
      expect(res.headers.get("content-type")).toStartWith("application/json");
      expectEnvelope(await json(res), code);
    }
  });

  function paddedBody(bytes: number): string {
    const body = JSON.stringify(plain);
    return body + " ".repeat(bytes - body.length);
  }

  test.each([
    ["/api/v1/health", "GET"],
    ["/api/v1/models", "GET"],
    ["/api/v1/languages", "GET"],
    ["/api/v1/openapi.yaml", "GET"],
    ["/api/v1/translate", "POST"],
    ["/api/v1/tokenize", "POST"],
  ])("%s answers DELETE and PUT with 405 and Allow: %s", async (path, allow) => {
    for (const method of ["DELETE", "PUT"]) {
      const res = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "PUT" ? "{}" : undefined,
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
      expect(res.headers.get("content-type")).toStartWith("application/json");
      expectEnvelope(await json(res), "method_not_allowed");
    }
  });

  test("HEAD on /api/v1/health is a 405 that allows GET (documented; unlike HEAD on static files)", async () => {
    const res = await fetch(base + "/api/v1/health", { method: "HEAD" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    await res.text();
  });
});

describe("resumable streams", () => {
  const start = (extra: Record<string, unknown> = {}) =>
    post("/api/v1/translate", { text: "你好", target_lang: "en", stream: true, resumable: true, ...extra });

  test("events are numbered and can be read again from any point", async () => {
    const res = await start();
    const id = res.headers.get("x-translation-id")!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const text = await res.text();
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((m) => m[1])).toStrictEqual(["1", "2", "3", "4", "5"]);

    const rest = await fetch(`${base}/api/v1/translations/${id}/events`, { headers: { "last-event-id": "3" } });
    expect((await readSse(rest)).map((e) => e.event)).toStrictEqual(["delta", "done"]);
    const all = await fetch(`${base}/api/v1/translations/${id}/events`);
    expect((await readSse(all)).map((e) => e.event)).toStrictEqual(["start", "delta", "delta", "delta", "done"]);
  });

  test("keeps running when the reader leaves, and the next reader gets the whole translation", async () => {
    mock.delayMs = 40;
    try {
      const res = await start();
      const id = res.headers.get("x-translation-id")!;
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      await Bun.sleep(300);
      const again = await fetch(`${base}/api/v1/translations/${id}/events`, { headers: { "last-event-id": "1" } });
      const events = await readSse(again);
      expect(events.at(-1)!.event).toBe("done");
    } finally {
      mock.delayMs = 0;
    }
  });

  test("DELETE cancels it, and an unknown or non-resumable id is a 404", async () => {
    mock.delayMs = 100;
    try {
      const res = await start();
      const id = res.headers.get("x-translation-id")!;
      const reader = res.body!.getReader();
      await reader.read();
      const gone = await fetch(`${base}/api/v1/translations/${id}`, { method: "DELETE" });
      expect(gone.status).toBe(204);
      const events: string[] = [];
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          break;
        }
      }
      expect(events).toStrictEqual([]);
      const plain = await post("/api/v1/translate", { text: "你好", target_lang: "en", stream: true });
      expect(plain.headers.get("x-translation-id")).toBeNull();
      await plain.text();
    } finally {
      mock.delayMs = 0;
    }
    const missing = await fetch(`${base}/api/v1/translations/00000000-0000-4000-8000-000000000000/events`);
    expect(missing.status).toBe(404);
  });

  test("resumable must be a boolean", async () => {
    const res = await start({ resumable: "yes" });
    expect(res.status).toBe(400);
  });
});
