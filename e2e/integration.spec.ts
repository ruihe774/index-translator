// Integration: the real page and static server, with the API stubbed in the browser (page.route).
// These cover what the mock engine cannot produce on demand: error envelopes, status codes, an
// unreachable server, SSE framing and the health polling.

import { expect, test, AppPage } from "./fixtures";

const sse = (events: [string, unknown][]) =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const done = {
  finish_reason: "stop",
  usage: { prompt_tokens: 10, completion_tokens: 3 },
  timings: { queue_ms: 0, generation_ms: 500 },
};

const health = (over: object = {}) => ({
  status: "ready",
  model: "index-translate-9b",
  limits: { context_tokens: 65536, max_input_tokens: 28000 },
  queue: { running: false, waiting: 0, max_waiting: 8 },
  ...over,
});

async function stubTranslate(app: AppPage, status: number, body: string, type = "text/event-stream") {
  await app.page.route("**/api/v1/translate", (route) => route.fulfill({ status, body, contentType: type }));
}

async function run(app: AppPage, text = "Hello") {
  await app.open();
  await app.text.fill(text);
  await app.translate.click();
}

test("queued, start and delta events drive the progress line and output", async ({ app }) => {
  await stubTranslate(
    app,
    200,
    sse([
      ["queued", { position: 2 }],
      ["start", { model: "index-translate-9b" }],
      ["delta", { text: "你" }],
      ["delta", { text: "好" }],
      ["done", done],
    ]),
  );
  await run(app);
  await expect(app.output).toHaveText("你好");
  await expect(app.progress).toHaveText("Done.");
  await expect(app.meta).toHaveText("Index-Translate-9B · 10 prompt tokens · 3 generated · 0.5 s");
});

test("sends stream:true and the chosen languages", async ({ app }) => {
  let sent: any;
  await app.page.route("**/api/v1/translate", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse([["done", done]]) });
  });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("ja");
  await app.text.fill("Hello");
  await app.translate.click();
  await expect(app.progress).toHaveText("Done.");
  expect(sent).toMatchObject({ text: "Hello", target_lang: "ja", source_lang: "en", stream: true });
});

for (const [name, status, error, message] of [
  ["queue_full", 429, { code: "queue_full" }, "The translator is busy and its queue is full. Try again in a minute."],
  ["engine_unavailable", 503, { code: "engine_unavailable" }, "The engine is loading or switching models. Try again in a moment."],
  ["input_too_long", 413, { code: "input_too_long", details: { prompt_tokens: 30000, max_input_tokens: 28000 } }, "30,000 tokens, and the limit is 28,000"],
  ["a bare 429", 429, {}, "The translator is busy. Try again in a minute."],
  ["a custom message", 400, { code: "invalid_request", message: "bad field" }, "bad field"],
] as const) {
  test(`shows a readable message for ${name}`, async ({ app }) => {
    await stubTranslate(app, status, JSON.stringify({ error }), "application/json");
    await run(app);
    // Substring match: the exact wording for each code lives in public/errors.ts and its unit tests.
    await expect(app.error).toContainText(message.replace("The engine", "The translation engine"));
    await expect(app.output).toHaveText("");
    await expect(app.translate).toHaveAttribute("aria-disabled", "false");
  });
}

test("a dropped connection before the done event is reported", async ({ app }) => {
  await stubTranslate(app, 200, sse([["delta", { text: "part" }]]));
  await run(app);
  await expect(app.error).toHaveText("the connection closed before the translation finished");
  await expect(app.output).toHaveText("part");
  await expect(app.notes.first()).toContainText("error interrupted it");
});

test("an unreachable server says so", async ({ app }) => {
  await app.page.route("**/api/v1/translate", (route) => route.abort("connectionrefused"));
  await run(app);
  await expect(app.error).toHaveText("The server cannot be reached.");
});

test("falls back to three languages when /languages fails", async ({ app }) => {
  await app.page.route("**/api/v1/languages", (route) => route.abort());
  await app.page.goto("/");
  await expect(app.to.locator("option")).toHaveText(["English", "Chinese", "Japanese"]);
  await expect(app.selection).toContainText("Could not load the full language list");
});

test("health: loading is polled until ready", async ({ app }) => {
  let calls = 0;
  await app.page.route("**/api/v1/health", (route) => {
    calls++;
    return route.fulfill({ json: calls < 2 ? health({ status: "loading", model: null }) : health() });
  });
  await app.page.goto("/");
  await expect(app.engine).toHaveText("Engine loading a model…");
  await expect(app.engine).toHaveText("Engine ready, Index-Translate-9B loaded.", { timeout: 10_000 });
});

test("health: an unreachable server and an engine error", async ({ app }) => {
  await app.page.route("**/api/v1/health", (route) => route.abort());
  await app.page.goto("/");
  await expect(app.engine).toHaveText("The server cannot be reached.");

  await app.page.unroute("**/api/v1/health");
  await app.page.route("**/api/v1/health", (route) =>
    route.fulfill({ json: health({ status: "error", error: "no GPU" }) }),
  );
  await app.page.reload();
  await expect(app.engine).toHaveText("Engine error: no GPU.");
});

test("copy puts the translation on the clipboard", async ({ app, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stubTranslate(app, 200, sse([["delta", { text: "你好" }], ["done", done]]));
  await run(app);
  await app.copy.click();
  await expect(app.progress).toHaveText("Translation copied to the clipboard.");
  expect(await app.page.evaluate(() => (globalThis as any).navigator.clipboard.readText())).toBe("你好");
});

test("Markdown source: the output is rendered, unsafe links stay text, and copy keeps the raw Markdown", async ({ app, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const md = "# 标题\n\n- **一**\n- [链接](https://example.com)\n- [坏](javascript:alert(1))\n\n```js\nlet a = 1;\n```\n\n<b>原样</b>";
  await stubTranslate(app, 200, sse([...[...md].map((c): [string, unknown] => ["delta", { text: c }]), ["done", done]]));
  await run(app, "# Title\n\n- **one**\n- [link](https://example.com)");

  await expect(app.progress).toHaveText("Done.");
  await expect(app.output.locator("h3")).toHaveText("标题");
  await expect(app.output.locator("ul > li")).toHaveCount(3);
  await expect(app.output.locator("li strong")).toHaveText("一");
  const link = app.output.getByRole("link", { name: "链接" });
  await expect(link).toHaveAttribute("href", "https://example.com");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(app.output.locator("a")).toHaveCount(1);
  await expect(app.output.locator("li").nth(2)).toHaveText("坏");
  await expect(app.output.locator("pre > code.language-js")).toHaveText("let a = 1;");
  await expect(app.output.locator("b")).toHaveCount(0);
  await expect(app.output.locator("p").last()).toHaveText("<b>原样</b>");

  await app.copy.click();
  expect(await app.page.evaluate(() => (globalThis as any).navigator.clipboard.readText())).toBe(md);
});

test("plain source: Markdown-like output stays plain text", async ({ app }) => {
  await stubTranslate(app, 200, sse([["delta", { text: "# 不是标题\n**也不粗**" }], ["done", done]]));
  await run(app, "Hello there");
  await expect(app.progress).toHaveText("Done.");
  await expect(app.output).toHaveText("# 不是标题\n**也不粗**");
  await expect(app.output.locator("*")).toHaveCount(0);
});
