// End to end: the web app in a real browser against the real server, with the mock llama-server.

import { CHAT, DOCUMENT, THINK, expect, test } from "./fixtures";

test("the page loads languages and reports a ready engine", async ({ app }) => {
  await app.open();
  await expect(app.engine).toHaveText("Engine ready, Index-Translate-9B loaded.");
  await expect(app.from.locator("option").first()).toHaveText("Detect language");
  await expect(app.to).toHaveValue("zh");
  await expect(app.page).toHaveTitle(/Index Translator/);
});

test("translates short text with the chat model and shows the result", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "你好", "，", "世界"] });
  await app.open();
  await app.text.fill("Hello, world");
  await expect(app.page.locator("#count")).toHaveText("10 letters");
  await app.translate.click();

  await expect(app.output).toHaveText("你好，世界");
  await expect(app.progress).toHaveText("Done.");
  await expect(app.meta).toContainText("Index-Translate-9B");
  await expect(app.meta).toContainText("42 prompt tokens");
  await expect(app.copy).toBeVisible();
  await expect(app.page.locator("#placeholder")).toBeHidden();

  const { requests } = await mock.state();
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0].messages)).toContain("Hello, world");
});

test("streams the translation as it arrives and lets the user stop it", async ({ app, mock }) => {
  await mock.set({ chunks: ["one ", "two ", "three ", "four ", "five "], delayMs: 300 });
  await app.open();
  await app.text.fill("Count to five");
  await app.translate.click();

  await expect(app.stop).toBeVisible();
  await expect(app.progress).toContainText("Translating with Index-Translate-9B");
  await expect(app.output).toContainText("one");
  await app.stop.click();

  await expect(app.progress).toHaveText("Stopped.");
  await expect(app.notes).toHaveText("You stopped the translation. The text above is incomplete.");
  await expect(app.output).not.toContainText("five");
  await expect(app.translate).toHaveAttribute("aria-disabled", "false");
  await expect.poll(async () => (await mock.state()).aborted).toBeGreaterThan(0);
});

test("an empty submission shows a field error and sends nothing", async ({ app, mock }) => {
  await app.open();
  await app.translate.click();
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
  await app.translate.click();
  await expect(app.progress).toHaveText("Done.");
  await app.page.reload();
  await expect(app.to).toHaveValue("ja");
  await expect(app.from).toHaveValue("en");
});

test("a glossary reaches the engine and a bad glossary line is rejected in the page", async ({ app, mock }) => {
  await app.open();
  await app.text.fill("The cat sat.");
  await app.openAdvanced();
  await app.page.getByLabel("Glossary", { exact: true }).fill("no equals sign here");
  await app.translate.click();
  await expect(app.page.locator("#glossary-error")).toBeVisible();
  expect((await mock.state()).requests).toHaveLength(0);

  await app.page.getByLabel("Glossary", { exact: true }).fill("cat = 猫");
  await app.translate.click();
  await expect(app.progress).toHaveText("Done.");
  const { requests } = await mock.state();
  expect(JSON.stringify(requests[0].messages)).toContain("cat");
  expect(JSON.stringify(requests[0].messages)).toContain("猫");
});

test("a long English text selects the document model, swaps the engine and warns on lost paragraphs", async ({ app, mock }) => {
  await mock.set({ chunks: ["[1]\n", "只有一段"] });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("zh");
  const paragraph = "word ".repeat(1000).trim();
  await app.text.fill([paragraph, paragraph, paragraph].join("\n\n"));
  await expect(app.selection).toContainText("whole-document model is used");

  await app.translate.click();
  await expect(app.progress).toContainText("Done, with");
  await expect(app.meta).toContainText("Index-NativeLong-9B");
  await expect(app.notes.first()).toContainText(/paragraph/i);
  await expect(app.engine).toHaveText("Engine ready, Index-NativeLong-9B loaded.");
  expect((await mock.state()).launches).toContain(DOCUMENT);
});

test("the manual model choice overrides the length rule", async ({ app }) => {
  await app.open();
  await app.text.fill("short");
  await app.model("Index-NativeLong-9B").check();
  await expect(app.selection).toContainText("cannot translate this");
  await app.translate.click();
  await expect(app.error).toContainText("Index-NativeLong-9B cannot translate this");
  await app.model("Index-Translate-9B").check();
  await expect(app.selection).toHaveText("Model: Index-Translate-9B, as you chose.");
});

test("a truncated translation is flagged as incomplete", async ({ app, mock }) => {
  await mock.set({ chunks: ["cut o"], finish: "length" });
  await app.open();
  await app.text.fill("A sentence.");
  await app.translate.click();
  await expect(app.notes.first()).toContainText("cut off because it reached the output limit");
  await expect(app.progress).toContainText("Done, with a warning");
});

test("an engine error mid-stream keeps the partial text and says it is incomplete", async ({ app, mock }) => {
  await mock.set({ chunks: ["partial"], failWith: "boom" });
  await app.open();
  await app.text.fill("A sentence.");
  await app.translate.click();
  await expect(app.error).not.toBeEmpty();
  await expect(app.output).toHaveText("partial");
  await expect(app.notes.first()).toContainText("error interrupted it");
});

test("text over the input limit shows the server's input_too_long message", async ({ app, mock }) => {
  await app.open();
  await app.text.fill("a".repeat(30_000));
  await app.model("Index-Translate-9B").check();
  await app.translate.click();
  await expect(app.error).toContainText("The text is too long for one translation");
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
    .poll(async () => (await (await request.get(`${baseURL}/api/v1/health`)).json()).queue.waiting)
    .toBe(1);

  await app.text.fill("third");
  await app.translate.click();
  await expect(app.error).toHaveText("The translator is busy and its queue is full. Try again in a minute.");
  await Promise.all([first, second]);
});

test("the model switches back to chat for a short text after a document load", async ({ app, mock }) => {
  await app.open();
  await app.from.selectOption("en");
  await app.model("Index-NativeLong-9B").check();
  await app.text.fill("Short text.");
  await app.translate.click();
  await expect(app.progress).toContainText("Done");
  await expect(app.engine).toContainText("NativeLong");
  await app.model("Automatic").check();
  await app.translate.click();
  await expect(app.engine).toHaveText("Engine ready, Index-Translate-9B loaded.");
  // The mock was reset after the startup load of the chat model, so only the swaps are recorded.
  expect((await mock.state()).launches).toEqual([DOCUMENT, CHAT]);
});
