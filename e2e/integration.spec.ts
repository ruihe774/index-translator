// Integration: the real page and static server, with the API stubbed in the browser (page.route).
// These cover what the mock engine cannot produce on demand: error envelopes, status codes, an
// unreachable server, SSE framing and the health polling.

import { type AppPage, expect, test } from "./fixtures";

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
  await expect(app.meta).toContainText("generated");
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
  await expect(app.meta).toContainText("generated");
  expect(sent).toMatchObject({ text: "Hello", target_lang: "ja", source_lang: "en", stream: true });
});

for (const [name, status, error, message] of [
  ["queue_full", 429, { code: "queue_full" }, "The translator is busy and its queue is full. Try again in a minute."],
  [
    "engine_unavailable",
    503,
    { code: "engine_unavailable" },
    "The engine is loading or switching models. Try again in a moment.",
  ],
  [
    "input_too_long",
    413,
    { code: "input_too_long", details: { prompt_tokens: 30000, max_input_tokens: 28000 } },
    "30,000 tokens, and the limit is 28,000",
  ],
  ["a bare 429", 429, {}, "The translator is busy. Try again in a minute."],
  ["a custom message", 400, { code: "invalid_request", message: "bad field" }, "bad field"],
] as const) {
  test(`shows a readable message for ${name}`, async ({ app }) => {
    await stubTranslate(app, status, JSON.stringify({ error }), "application/json");
    await run(app);
    // Substring match: the exact wording for each code lives in public/errors.ts and its unit tests.
    await expect(app.meta).toContainText(message.replace("The engine", "The translation engine"));
    await expect(app.output).toHaveText("");
    await expect(app.translate).toHaveAttribute("aria-disabled", "false");
  });
}

test("a dropped connection before the done event is reported", async ({ app }) => {
  await stubTranslate(app, 200, sse([["delta", { text: "part" }]]));
  await run(app);
  await expect(app.meta).toContainText("the connection closed before the translation finished");
  await expect(app.output).toHaveText("part");
  await expect(app.meta).toContainText("error interrupted it");
});

test("an unreachable server says so", async ({ app }) => {
  await app.page.route("**/api/v1/translate", (route) => route.abort("connectionrefused"));
  await run(app);
  await expect(app.meta).toHaveText("The server cannot be reached.");
});

test("falls back to three languages when /languages fails", async ({ app }) => {
  await app.page.route("**/api/v1/languages", (route) => route.abort());
  await app.page.goto("/");
  await expect(app.to.locator("option")).toHaveText(["English", "Chinese", "Japanese"]);
  await expect(app.advice).toContainText("Could not load the full language list");
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
  await stubTranslate(
    app,
    200,
    sse([
      ["delta", { text: "你好" }],
      ["done", done],
    ]),
  );
  await run(app);
  await app.copy.click();
  await expect(app.meta).toHaveText("Translation copied to the clipboard.");
  expect(await app.page.evaluate(() => (globalThis as any).navigator.clipboard.readText())).toBe("你好");
});

test("Markdown source: the output is rendered, unsafe links stay text, and copy keeps the raw Markdown", async ({
  app,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const md =
    "# 标题\n\n- **一**\n- [链接](https://example.com)\n- [坏](javascript:alert(1))\n\n```js\nlet a = 1;\n```\n\n<b>原样</b>";
  await stubTranslate(
    app,
    200,
    sse([...[...md].map((c): [string, unknown] => ["delta", { text: c }]), ["done", done]]),
  );
  await run(app, "# Title\n\n- **one**\n- [link](https://example.com)");

  await expect(app.meta).toContainText("generated");
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

test("output links ask for confirmation, with other wording for links that do not pair with the source", async ({
  app,
}) => {
  const source = "[A](https://a.example)\n\n[B](https://b.example)\n\n[C](https://c.example)";
  const md = "[甲](https://a.example)\n\n[乙](https://a.example)\n\n[丙](https://evil.example)";
  await stubTranslate(
    app,
    200,
    sse([
      ["delta", { text: md }],
      ["done", done],
    ]),
  );
  await run(app, source);
  await expect(app.meta).toContainText("generated");

  const dialog = app.page.locator("dialog.link-dialog");
  const open = app.page.evaluate(() => {
    const w = globalThis as any;
    w.opened = [];
    w.open = (url: string) => w.opened.push(url);
  });
  await open;

  await app.output.getByRole("link", { name: "甲" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Open this link?");
  await expect(dialog).toContainText("https://a.example");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await app.page.evaluate(() => (globalThis as any).opened)).toEqual([]);

  await app.output.getByRole("link", { name: "乙" }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Open this unverified link?");
  await dialog.getByRole("button", { name: "Open anyway" }).click();
  await expect(dialog).toBeHidden();
  expect(await app.page.evaluate(() => (globalThis as any).opened)).toEqual(["https://a.example/"]);

  // A target absent from the source is disabled and opens nothing.
  await expect(app.output.locator("a[aria-disabled=true]")).toHaveText(/丙/);
});

test("plain source: Markdown-like output stays plain text", async ({ app }) => {
  await stubTranslate(
    app,
    200,
    sse([
      ["delta", { text: "# 不是标题\n**也不粗**" }],
      ["done", done],
    ]),
  );
  await run(app, "Hello there");
  await expect(app.meta).toContainText("generated");
  await expect(app.output).toHaveText("# 不是标题\n**也不粗**");
  // One span per line, nothing rendered.
  await expect(app.output.locator("> span")).toHaveText(["# 不是标题\n", "**也不粗**"]);
  await expect(app.output.locator(":not(span), span *")).toHaveCount(0);
});

test("Markdown source: rendered in place of the textarea after Translate, with Raw and Preview on each side", async ({
  app,
}) => {
  const md = "# Title\n\nSome **bold** text.";
  await stubTranslate(
    app,
    200,
    sse([
      ["delta", { text: "# 标题\n\n一些**粗体**文字。" }],
      ["done", done],
    ]),
  );
  await run(app, md);
  await expect(app.meta).toContainText("generated");

  const sourceView = app.page.locator("#source-view");
  const sourceSwitch = app.page.locator("#source-switch");
  const outputSwitch = app.page.locator("#output-switch");
  await expect(app.text).toBeHidden();
  await expect(sourceView.locator("h3")).toHaveText("Title");
  await expect(sourceView.locator("p strong")).toHaveText("bold");
  await expect(app.output.locator("h3")).toHaveText("标题");

  // Source: Raw is the editable textarea; Preview renders what it holds now.
  await sourceSwitch.getByRole("button", { name: "Raw" }).click();
  await expect(app.page.locator("#source-area")).toBeHidden();
  await expect(app.text).toBeVisible();
  await expect(app.text).toHaveValue(md);
  await expect(sourceSwitch.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
  await app.text.fill("## Changed");
  await sourceSwitch.getByRole("button", { name: "Preview" }).click();
  await expect(sourceView.locator("h4")).toHaveText("Changed");

  // Output: Raw shows the Markdown as text; the other side is unaffected.
  await outputSwitch.getByRole("button", { name: "Raw" }).click();
  await expect(app.output).toHaveText("# 标题\n\n一些**粗体**文字。");
  await expect(app.output.locator("h3, strong")).toHaveCount(0);
  await expect(sourceView.locator("h4")).toBeVisible();
  await outputSwitch.getByRole("button", { name: "Preview" }).click();
  await expect(app.output.locator("h3")).toHaveText("标题");
});

test("plain source: the textarea stays and the switches are offered", async ({ app }) => {
  await stubTranslate(
    app,
    200,
    sse([
      ["delta", { text: "你好" }],
      ["done", done],
    ]),
  );
  await run(app, "Hello");
  await expect(app.meta).toContainText("generated");
  await expect(app.text).toBeVisible();
  await expect(app.page.locator("#source-switch button[aria-disabled='true']")).toHaveCount(0);
  await expect(app.page.locator("#output-switch button[aria-disabled='true']")).toHaveCount(0);
  await expect(app.copy).toHaveAttribute("aria-disabled", "false");
});

test("Clear empties both sides and returns the source to the plain textarea", async ({ app }) => {
  await stubTranslate(
    app,
    200,
    sse([
      ["delta", { text: "# 标题" }],
      ["done", done],
    ]),
  );
  await run(app, "# Title");
  await expect(app.meta).toContainText("generated");
  await expect(app.text).toBeHidden();

  await app.page.getByRole("button", { name: "Clear" }).click();
  await expect(app.text).toBeVisible();
  await expect(app.text).toHaveValue("");
  await expect(app.text).toBeFocused();
  await expect(app.page.locator("#source-area")).toBeHidden();
  await expect(app.page.locator("#source-switch button[aria-disabled='false']")).toHaveCount(0);
  await expect(app.page.locator("#output-switch button[aria-disabled='false']")).toHaveCount(0);
  await expect(app.output).toBeEmpty();
  await expect(app.page.locator("#placeholder")).toBeVisible();
  await expect(app.meta).toHaveText("");
  await expect(app.copy).toHaveAttribute("aria-disabled", "true");
  await expect(app.page.getByRole("button", { name: "Clear" })).toHaveAttribute("aria-disabled", "true");
  await expect(app.page.locator("#count")).toHaveText("0 letters");
});

/** Top of `el` relative to the top of the box of `scroller`. */
async function offsetIn(app: AppPage, el: string, scroller: string): Promise<number> {
  return app.page.evaluate(
    ({ el, scroller }) =>
      document.querySelector(el)!.getBoundingClientRect().top -
      document.querySelector(scroller)!.getBoundingClientRect().top,
    { el, scroller },
  );
}

const paragraphs = (n: number, make: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => make(i)).join("\n\n");

test("matching paragraphs: a click on either side scrolls the other to the same paragraph", async ({ app }) => {
  await app.page.setViewportSize({ width: 1280, height: 800 });
  const source = "# Doc\n\n" + paragraphs(30, (i) => `Paragraph ${i} ${"word ".repeat(i % 3 ? 8 : 40)}`);
  const translation = "# 文档\n\n" + paragraphs(30, (i) => `第${i}段 ${"字".repeat(i % 2 ? 10 : 90)}`);
  await stubTranslate(
    app,
    200,
    sse([
      ["delta", { text: translation }],
      ["done", done],
    ]),
  );
  await run(app, source);
  await expect(app.meta).toContainText("generated");
  await expect(app.page.locator("#output-area")).toHaveClass(/synced/);

  // Output paragraph 20 is the 21st <p>; the source's matching one is the 21st <p> too.
  await app.output.locator("p").nth(20).click();
  const out = await offsetIn(app, "#output > p:nth-of-type(21)", "#output-area");
  const src = await offsetIn(app, "#source-view > p:nth-of-type(21)", "#source-area");
  expect(Math.abs(out - src)).toBeLessThan(2);

  await app.page.locator("#source-view p").nth(5).click();
  const src2 = await offsetIn(app, "#source-view > p:nth-of-type(6)", "#source-area");
  const out2 = await offsetIn(app, "#output > p:nth-of-type(6)", "#output-area");
  expect(Math.abs(out2 - src2)).toBeLessThan(2);

  // Editing the source in Raw ends the sync.
  await app.page.locator("#source-switch").getByRole("button", { name: "Raw" }).click();
  await expect(app.page.locator("#output-area")).toHaveClass(/synced/);
  await app.text.press("End");
  await app.text.pressSequentially("x");
  await expect(app.page.locator("#output-area")).not.toHaveClass(/synced/);
});

test("matching lines in plain text: the raw textarea and the output sync both ways", async ({ app }) => {
  await app.page.setViewportSize({ width: 1280, height: 800 });
  const source = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n");
  const translation = Array.from({ length: 80 }, (_, i) => `第${i}行`).join("\n");
  await stubTranslate(
    app,
    200,
    sse([
      ["delta", { text: translation }],
      ["done", done],
    ]),
  );
  await run(app, source);
  await expect(app.meta).toContainText("generated");
  await expect(app.page.locator("#output-area")).toHaveClass(/synced/);

  await app.output.locator('span[data-line="60"]').click();
  // The lines are short and do not wrap, so line 60 starts 60 line heights below the first.
  const inTextarea = await app.text.evaluate((t) => {
    const style = getComputedStyle(t);
    return (
      parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) + 60 * parseFloat(style.lineHeight) - t.scrollTop
    );
  });
  expect(await app.text.evaluate((t) => t.scrollTop)).toBeGreaterThan(0);
  const inOutput = await offsetIn(app, '#output > span[data-line="60"]', "#output-area");
  expect(Math.abs(inTextarea - inOutput)).toBeLessThan(2);

  // The caret line in the textarea moves the output to that line.
  await app.page.locator("#output-area").evaluate((el) => (el.scrollTop = 0));
  const caret = source.indexOf("Line 40");
  await app.text.evaluate((t: HTMLTextAreaElement, c) => {
    t.focus();
    t.setSelectionRange(c, c);
  }, caret);
  await app.text.dispatchEvent("click");
  expect(await app.page.locator("#output-area").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("paragraphs that do not match: no sync", async ({ app }) => {
  await app.page.setViewportSize({ width: 1280, height: 800 });
  const source = "# Doc\n\n" + paragraphs(30, (i) => `Paragraph ${i}`);
  const translation = "# 文档\n\n" + paragraphs(25, (i) => `第${i}段`);
  await stubTranslate(
    app,
    200,
    sse([
      ["delta", { text: translation }],
      ["done", done],
    ]),
  );
  await run(app, source);
  await expect(app.meta).toContainText("generated");
  await expect(app.page.locator("#output-area")).not.toHaveClass(/synced/);
  await app.output.locator("p").nth(20).click();
  expect(await app.page.locator("#source-area").evaluate((el) => el.scrollTop)).toBe(0);
});
