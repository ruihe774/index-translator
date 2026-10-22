/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
// End to end: the web app in a real browser against the real server, with the mock engine.

import type { Health } from "../src/api";
import { CHAT, DOCUMENT, expect, test, THINK } from "./fixtures";

test("the page loads languages and reports a ready engine", async ({ app }) => {
  await app.open();
  await expect(app.engine).toHaveText("Engine ready, Index-Translate-9B loaded.");
  await expect(app.from.locator("option").first()).toHaveText("Detect");
  await expect(app.to).toHaveValue("zh");
  await expect(app.page).toHaveTitle(/Index Translator/);
});

test("translates short text with the chat model and shows the result", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "你好", "，", "世界"] });
  await app.open();
  await app.text.fill("Hello, world");
  await expect(app.page.locator("#count")).toHaveText("10 letters");
  await app.page.locator("#translate").click();

  await expect(app.output).toHaveText("你好，世界");
  await expect(app.meta).toContainText("generated");
  await expect(app.meta).toContainText("Index-Translate-9B");
  await expect(app.meta).toContainText("42 prompt tokens");
  await expect(app.copy).toBeVisible();
  await expect(app.page.locator("#placeholder")).toBeHidden();

  const { requests } = await mock.state();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.prompt).toContain("Hello, world");
});

test("streams the translation as it arrives and lets the user stop it", async ({ app, mock }) => {
  await mock.set({ chunks: ["one ", "two ", "three ", "four ", "five "], delayMs: 300 });
  await app.open();
  await app.text.fill("Count to five");
  await app.page.locator("#translate").click();

  await expect(app.stop).toBeVisible();
  await expect(app.meta).toContainText("Translating with Index-Translate-9B");
  await expect(app.output).toContainText("one");
  await app.stop.click();

  await expect(app.meta).toHaveText("You stopped the translation. The text above is incomplete.");
  await expect(app.meta).toHaveText("You stopped the translation. The text above is incomplete.");
  await expect(app.output).not.toContainText("five");
  await expect(app.translate).toHaveAttribute("aria-disabled", "false");
  await expect.poll(async () => (await mock.state()).aborted).toBeGreaterThan(0);
});

test("the output follows the stream to its end until the user scrolls", async ({ app, mock }) => {
  const line = (n: number) => `line ${n}\n`;
  await mock.set({ chunks: Array.from({ length: 80 }, (_, i) => line(i)), delayMs: 40 });
  await app.open();
  await app.text.fill("Many lines");
  await app.page.locator("#translate").click();

  const area = app.page.locator("#output-area");
  const gap = () => area.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect(app.output).toContainText("line 40");
  expect(await area.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await gap()).toBeLessThanOrEqual(2);

  await area.hover();
  await app.page.mouse.wheel(0, -100_000);
  // The wheel animation may stop a few pixels short of the top; what matters is that it stays away
  // from the end while more text arrives.
  await expect.poll(() => area.evaluate((el) => el.scrollTop)).toBeLessThan(100);
  await expect(app.output).toContainText("line 79");
  await expect(app.stop).toBeHidden();
  expect(await area.evaluate((el) => el.scrollTop)).toBeLessThan(100);
});

test("Markdown output is rendered while it streams: finished blocks stay in place", async ({ app, mock }) => {
  await mock.set({ chunks: ["# 标题\n\n", "第一段。\n\n", "- 甲\n", "- 乙\n\n", "**结束**"], delayMs: 700 });
  await app.open();
  await app.text.fill("# Title\n\nFirst paragraph.\n\n- a\n- b\n\n**End**");
  await app.page.locator("#translate").click();

  const heading = app.output.locator("h3");
  await expect(heading).toHaveText("标题");
  await expect(app.output.locator("li").first()).toHaveText("甲");
  // Checked here, with several chunks still to come: the last chunk ends the run and hides Stop.
  await expect(app.stop).toBeVisible();
  // Later blocks have started, so the heading is finished: its element is kept, not rebuilt.
  await heading.evaluate((el) => ((el as any).dataset.seen = "1"));
  await expect(app.output.locator("li")).toHaveCount(2);
  await expect(app.meta).toContainText("generated");
  await expect(app.output.locator("h3[data-seen]")).toHaveCount(1);
  await expect(app.output.locator("p")).toHaveText(["第一段。", "结束"]);
  await expect(app.output.locator("p strong")).toHaveText("结束");
});

test("an empty submission shows a field error and sends nothing", async ({ app, mock }) => {
  await app.open();
  await app.page.locator("#translate").click();
  await expect(app.page.locator("#text-error")).toHaveText("Enter some text to translate.");
  await expect(app.text).toHaveAttribute("aria-invalid", "true");
  await app.text.fill("x");
  await expect(app.page.locator("#text-error")).toBeHidden();
  expect((await mock.state()).requests).toHaveLength(0);
});

test("remembers the language choice across reloads", async ({ app }) => {
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("ja");
  await app.text.fill("Hi");
  await app.page.locator("#translate").click();
  await expect(app.meta).toContainText("generated");
  await app.page.reload();
  await expect(app.to).toHaveValue("ja");
  await expect(app.from).toHaveValue("en");
});

test("a glossary reaches the engine and a bad glossary line is rejected in the page", async ({ app, mock }) => {
  await app.open();
  await app.text.fill("The cat sat.");
  await app.openAdvanced();
  await app.page.getByLabel("Glossary", { exact: true }).fill("no equals sign here");
  await app.page.locator("#translate").click();
  await expect(app.page.locator("#glossary-error")).toBeVisible();
  expect((await mock.state()).requests).toHaveLength(0);

  await app.page.getByLabel("Glossary", { exact: true }).fill("cat = 猫");
  await app.page.locator("#translate").click();
  await expect(app.meta).toContainText("generated");
  const { requests } = await mock.state();
  expect(requests[0]!.prompt).toContain("cat");
  expect(requests[0]!.prompt).toContain("猫");
});

test("a long English text selects the document model, swaps the engine and warns on lost paragraphs", async ({
  app,
  mock,
}) => {
  await mock.set({ chunks: ["[1]\n", "只有一段"] });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("zh");
  const paragraph = "word ".repeat(1000).trim();
  await app.text.fill([paragraph, paragraph, paragraph].join("\n\n"));
  await expect(app.advice).toBeEmpty(); // the model is named in the status line instead

  await app.page.locator("#translate").click();
  await expect(app.meta).toContainText("generated");
  await expect(app.meta).toContainText("Index-NativeLong-9B");
  await expect(app.notes.first()).toContainText(/paragraph/i);
  await expect(app.engine).toHaveText("Engine ready, Index-NativeLong-9B loaded.");
  expect((await mock.state()).launches).toContain(DOCUMENT);
});

test("the manual model choice overrides the length rule", async ({ app }) => {
  await app.open();
  await app.text.fill("short");
  await app.model("Index-NativeLong-9B").click();
  await expect(app.advice).toContainText("cannot translate this");
  await app.page.locator("#translate").click();
  await expect(app.meta).toContainText("Index-NativeLong-9B cannot translate this");
  await app.model("Index-Translate-9B").click();
  await expect(app.advice).toBeEmpty();
});

test("a truncated translation is flagged as incomplete", async ({ app, mock }) => {
  await mock.set({ chunks: ["cut o"], finish: "length" });
  await app.open();
  await app.text.fill("A sentence.");
  await app.page.locator("#translate").click();
  await expect(app.notes.first()).toContainText("cut off because it reached the output limit");
  await expect(app.meta).toContainText("generated");
});

test("an engine error mid-stream keeps the partial text and says it is incomplete", async ({ app, mock }) => {
  await mock.set({ chunks: ["partial"], failWith: "boom" });
  await app.open();
  await app.text.fill("A sentence.");
  await app.page.locator("#translate").click();
  await expect(app.meta).not.toBeEmpty();
  await expect(app.output).toHaveText("partial");
  await expect(app.meta).toContainText("error interrupted it");
});

test("text over the input limit shows the server's input_too_long message", async ({ app, mock }) => {
  await app.open();
  await app.text.fill("a".repeat(30_000));
  await app.model("Index-Translate-9B").click();
  await app.page.locator("#translate").click();
  await expect(app.meta).toContainText("The text is too long for one translation");
  expect((await mock.state()).requests).toHaveLength(0);
});

test("a full queue shows the busy message", async ({ app, mock, request, baseURL }) => {
  await mock.set({ chunks: ["slow"], delayMs: 1500 });
  await app.open();
  const call = () =>
    request.post(`${baseURL}/api/v1/translate`, { data: { text: "hi", target_lang: "zh" }, timeout: 30_000 });
  const first = call(); // runs
  await expect.poll(async () => (await mock.state()).requests.length).toBe(1);
  const second = call(); // waits (max_queue is 1)
  await expect(app.engine).toBeVisible();
  await expect
    .poll(async () => ((await (await request.get(`${baseURL}/api/v1/health`)).json()) as Health).queue.waiting)
    .toBe(1);

  await app.text.fill("third");
  await app.page.locator("#translate").click();
  await expect(app.meta).toHaveText("The translator is busy and its queue is full. Try again in a minute.");
  await Promise.all([first, second]);
});

test("the model switches back to chat for a short text after a document load", async ({ app, mock }) => {
  await app.open();
  await app.from.selectOption("en");
  await app.model("Index-NativeLong-9B").click();
  await app.text.fill("Short text.");
  await app.page.locator("#translate").click();
  await expect(app.meta).toContainText("generated");
  await expect(app.engine).toContainText("NativeLong");
  await app.model("Automatic").click();
  await app.page.locator("#translate").click();
  await expect(app.engine).toHaveText("Engine ready, Index-Translate-9B loaded.");
  // The mock was reset after the startup load of the chat model, so only the swaps are recorded.
  expect((await mock.state()).launches).toStrictEqual([DOCUMENT, CHAT]);
});

test("a translation typed in the Raw output panel can be matched with the source instead of translated", async ({
  app,
  mock,
}) => {
  await mock.set({ chunks: ["译文"] });
  await app.open();
  const target = app.page.locator("#target");
  const dialog = app.page.locator("dialog.link-dialog");
  await expect(target).toBeHidden();
  await app.page.locator("#output-switch").getByRole("button", { name: "Raw" }).click();
  await expect(target).toBeVisible();

  await app.text.fill("First paragraph.\n\nSecond paragraph.");
  await expect(app.page.locator("#translate")).toHaveText("Translate");
  await target.fill("第一段。\n\n第二段。");
  await expect(app.page.locator("#translate")).toHaveText("Match");

  // Cancel changes nothing.
  await app.page.locator("#translate").click();
  await expect(dialog.getByRole("button")).toHaveText(["Cancel", "Clear output and translate", "Match"]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(target).toHaveValue("第一段。\n\n第二段。");

  // Match keeps the typed text as the translation, with no request to the engine.
  await app.page.locator("#translate").click();
  await dialog.getByRole("button", { name: "Match", exact: true }).click();
  await expect(target).toBeHidden();
  await expect(app.output).toHaveText("第一段。 第二段。".replace(" ", "\n\n"));
  await expect(app.page.locator("#translate")).toHaveText("Translate");
  await expect(app.copy).toHaveAttribute("aria-disabled", "false");
  expect((await mock.state()).requests).toHaveLength(0);

  // Clear brings the box back, still Raw.
  await app.page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(target).toBeVisible();
  await expect(target).toHaveValue("");
});

test("Clear output and translate in the Match dialog translates and drops the typed text", async ({ app, mock }) => {
  await mock.set({ chunks: ["你好"] });
  await app.open();
  await app.page.locator("#output-switch").getByRole("button", { name: "Raw" }).click();
  await app.text.fill("Hello");
  await app.page.locator("#target").fill("typed");
  await app.page.locator("#translate").click();
  await app.page.locator("dialog.link-dialog").getByRole("button", { name: "Clear output and translate" }).click();
  await expect(app.output).toHaveText("你好");
  await expect(app.page.locator("#target")).toBeHidden();
  expect((await mock.state()).requests).toHaveLength(1);
});
