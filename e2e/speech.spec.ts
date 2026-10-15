/* eslint-disable no-underscore-dangle */
// Reading aloud, with the mock speech engine: it answers every utterance with a tenth of a second
// of silence and records what it was asked to say.

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

const MARKDOWN = `# Release notes

We fixed **three** bugs in [the parser](https://example.com/docs) and \`bun test\`.

1. Install it.
2. Run it.

\`\`\`bash
bun install
\`\`\`
`;
const SPOKEN = ["Release notes.", "We fixed three bugs in the parser and bun test.", "1. Install it.", "2. Run it."];

test("Read aloud needs a text, a language the model speaks and the source in Preview", async ({ app }) => {
  await app.open();
  const listen = app.page.locator("#listen-source");
  await expect(listen).toHaveAttribute("aria-disabled", "true");
  await expect(listen).toHaveAttribute("title", "There is no source text to read aloud yet.");

  await app.text.fill("Bonjour");
  await expect(listen).toHaveAttribute("title", "Choose the language under From to have this text read aloud.");
  await app.from.selectOption("fr");
  await expect(listen).toHaveAttribute("title", /Chinese, English, Japanese, Spanish and Arabic/);
  await app.from.selectOption("es");
  // The text box is for writing: it is read from Preview.
  await expect(listen).toHaveAccessibleDescription("Switch the source text to Preview to have it read aloud.");
  await expect(listen).toHaveAttribute("aria-disabled", "true");
  await listen.click({ force: true });
  await expect(app.meta).toHaveText("Switch the source text to Preview to have it read aloud.");
  await expect(app.gutter("source")).toHaveCount(0);
  await app.previewSource();
  await expect(listen).toHaveAttribute("aria-disabled", "false");
  await expect(listen).toHaveAccessibleName("Read the source text aloud");
  await expect(listen).toHaveAttribute("aria-pressed", "false");
  await expect(app.page.locator("#listen-output")).toHaveAttribute("aria-disabled", "true");
});

test("Read aloud shows a button per block and starts nothing; the button starts the reading", async ({ app, mock }) => {
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  await listen.click();
  await expect(listen).toHaveAttribute("aria-pressed", "true");
  const toolbar = app.page.getByRole("toolbar", { name: "Read the source text aloud from" });
  await expect(toolbar.getByRole("button").first()).toBeVisible();
  // One per block that is spoken: the code block has none.
  expect(
    await toolbar.getByRole("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label"))),
  ).toStrictEqual([
    "Read from: Release notes.",
    "Read from: We fixed three bugs in the parser and bun test.",
    "Read from: 1. Install it.",
  ]);
  await expect(toolbar.getByRole("button", { name: "Read from: 1. Install it." })).toBeVisible();
  // Each sits beside its block (the first three of the view; the fourth, the code, has none).
  const blocks = app.page.locator("#source-view > [data-line]");
  for (let i = 0; i < 3; i++) {
    const button = (await app.gutter("source").nth(i).boundingBox())!;
    const block = (await blocks.nth(i).boundingBox())!;
    expect(Math.abs(button.y - block.y)).toBeLessThan(2);
    expect(button.x + button.width).toBeLessThanOrEqual(block.x);
  }
  await app.page.waitForTimeout(300);
  expect((await mock.state()).speech.requests).toStrictEqual([]);
  await expect(app.page.locator("#pause-source")).toBeHidden();

  await app.gutter("source").first().click();
  await expect(app.page.locator("#pause-source")).toBeVisible();
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  await expect(app.page.locator("#pause-source")).toBeHidden();
  // The reading ended by itself: the buttons stay for another choice.
  await expect(listen).toHaveAttribute("aria-pressed", "true");
  await expect(toolbar.getByRole("button").first()).toBeVisible();

  const { speech } = await mock.state();
  expect(speech.requests.map((r) => r.text)).toStrictEqual(SPOKEN);
  expect(speech.requests.every((r) => r.lang === "en" && r.voice === "voice_01" && r.speed === 1)).toBe(true);

  // Released: the buttons go, and the text takes its room back.
  const indented = (await blocks.first().boundingBox())!.x;
  await listen.click();
  await expect(listen).toHaveAttribute("aria-pressed", "false");
  await expect(toolbar.getByRole("button").first()).toBeHidden();
  expect((await blocks.first().boundingBox())!.x).toBeLessThan(indented);
});

test("a distant block is read from its button, by keyboard alone, and another button jumps", async ({ app, mock }) => {
  await mock.set({ speech: { delayMs: 300, audioSeconds: 3 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  const gutter = app.gutter("source");
  await listen.focus();
  await app.page.keyboard.press("Enter");
  // Focus goes to the first block in view; the column is one tab stop.
  await expect(gutter.first()).toBeFocused();
  expect(await gutter.evaluateAll((bs) => bs.map((b) => (b as HTMLElement).tabIndex))).toStrictEqual([0, -1, -1]);
  await app.page.keyboard.press("End");
  await expect(gutter.nth(2)).toBeFocused();
  await app.page.keyboard.press("ArrowDown");
  await expect(gutter.nth(2)).toBeFocused();
  await app.page.keyboard.press("Home");
  await app.page.keyboard.press("ArrowDown");
  await app.page.keyboard.press("ArrowDown");
  await expect(gutter.nth(2)).toBeFocused();
  await app.page.keyboard.press("Enter");

  const view = app.page.locator("#source-view");
  await expect(view.locator(".speaking")).toContainText("Install it.");
  await expect(gutter.nth(2)).toHaveAttribute("aria-current", "true");
  await expect(listen).toHaveAttribute("data-state", "playing");
  expect((await mock.state()).speech.requests[0]!.text).toBe("1. Install it.");

  // Another block while reading: a jump, said in the status line.
  await app.page.keyboard.press("ArrowUp");
  await app.page.keyboard.press("Space");
  await expect(app.meta).toHaveText("Block 2 of 3");
  await expect(view.locator(".speaking")).toHaveText("We fixed three bugs in the parser and bun test.");
  await expect(gutter.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(gutter.nth(2)).not.toHaveAttribute("aria-current");

  // Tab leaves the column at once, for the text (its link); released, Read aloud stops the reading.
  await app.page.keyboard.press("Tab");
  await expect(view.getByRole("link", { name: "the parser" })).toBeFocused();
  await listen.focus();
  await app.page.keyboard.press("Enter");
  await expect(listen).toHaveAttribute("data-state", "idle");
  await expect(gutter.first()).toBeHidden();
  await expect(listen).toBeFocused();
});

test("the translation is read in the target language and the block being read is shaded", async ({ app, mock }) => {
  await mock.set({
    chunks: ["# 发布说明\n\n", "我们修复了 **三个** 错误。\n\n", "- 安装\n- 运行\n"],
    speech: { delayMs: 300, audioSeconds: 1 },
  });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  const listen = app.page.locator("#listen-output");
  await expect(listen).toHaveAttribute("aria-disabled", "true");
  await app.translate.click();
  await expect(listen).toHaveAttribute("aria-disabled", "false");

  await app.readAloud("output");
  await expect(app.output.locator(".speaking")).toHaveText("发布说明");
  await expect(app.output.locator(".speaking")).toHaveText("我们修复了 三个 错误。");
  // Switching the view rebuilds the output; the shade and the buttons are put back.
  await app.page.getByRole("group", { name: "Translation view" }).getByRole("button", { name: "Raw" }).click();
  await expect(app.output.locator(".speaking")).toHaveCount(1);
  await expect(app.gutter("output")).toHaveCount(3);
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  await expect(app.output.locator(".speaking")).toHaveCount(0);

  const { speech } = await mock.state();
  expect(speech.requests.map((r) => [r.lang, r.text])).toStrictEqual([
    ["zh", "发布说明。"],
    ["zh", "我们修复了三个错误。"],
    ["zh", "安装。"],
    ["zh", "运行。"],
  ]);
});

test("in Raw every line of the block being read is shaded, and its button spans them", async ({ app, mock }) => {
  await mock.set({
    chunks: ["# 发布说明\n\n", "- 安装\n- 运行\n"],
    speech: { delayMs: 200, audioSeconds: 3 },
  });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await app.page.getByRole("group", { name: "Translation view" }).getByRole("button", { name: "Raw" }).click();
  await app.readAloud("output", 1);
  const shaded = app.output.locator(".speaking");
  await expect(shaded).toHaveText(["- 安装\n", "- 运行\n"]);
  await expect(shaded.first()).toHaveAttribute("aria-current", "true");
  await expect(shaded.nth(1)).not.toHaveAttribute("aria-current");
  const button = (await app.gutter("output").nth(1).boundingBox())!;
  const first = (await shaded.first().boundingBox())!;
  const last = (await shaded.nth(1).boundingBox())!;
  expect(button.height).toBeGreaterThanOrEqual(last.y + last.height - first.y - 2);
  await app.page.locator("#listen-output").click();
});

test("Pause holds the reading where it is and Resume goes on; Read aloud ends it", async ({ app, mock }) => {
  await mock.set({ speech: { delayMs: 200, audioSeconds: 1 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  const pause = app.page.locator("#pause-source");
  await app.readAloud("source");
  // While the audio is being made Pause shows a spinner, and Previous and Next wait.
  await expect(listen).toHaveAttribute("data-state", "loading");
  await expect(pause).toHaveAttribute("aria-disabled", "true");
  await expect(pause.locator(".when-loading")).toBeVisible();
  await expect(app.page.locator("#prev-source")).toHaveAttribute("aria-disabled", "true");
  await expect(app.page.locator("#next-source")).toHaveAttribute("aria-disabled", "true");
  await expect(listen).toHaveAttribute("data-state", "playing");
  await expect(pause).toHaveAttribute("aria-disabled", "false");
  await expect(pause).toHaveAccessibleName("Pause reading");
  await pause.click();
  await expect(listen).toHaveAttribute("data-state", "paused");
  await expect(pause).toHaveAccessibleName("Resume reading");

  // Paused: the audio of the rest is made meanwhile, one piece after the other, but nothing plays on.
  await expect.poll(async () => (await mock.state()).speech.requests.length).toBe(SPOKEN.length);
  await app.page.waitForTimeout(1500);
  await expect(listen).toHaveAttribute("data-state", "paused");
  await expect(app.meta).toHaveText("");
  expect((await mock.state()).speech.requests.length).toBe(SPOKEN.length);

  await pause.click();
  await expect(listen).toHaveAttribute("data-state", "playing");
  await listen.click();
  await expect(listen).toHaveAttribute("data-state", "idle");
  await expect(pause).toBeHidden();
  const asked = (await mock.state()).speech.requests.length;
  await app.page.waitForTimeout(600);
  expect((await mock.state()).speech.requests.length).toBe(asked);
});

test("Previous and Next jump between blocks, say where, and hand focus back when reading ends", async ({
  app,
  mock,
}) => {
  // Slow enough that the block after the one being read is still being made when Next is pressed.
  await mock.set({ speech: { delayMs: 1000, audioSeconds: 1.5 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  const prev = app.page.locator("#prev-source");
  const next = app.page.locator("#next-source");
  await expect(prev).toBeHidden();
  await app.readAloud("source");
  await expect(prev).toHaveAccessibleName("Previous block");
  await expect(next).toHaveAccessibleName("Next block");
  await expect(prev).toHaveAttribute("aria-disabled", "true");
  // Nothing plays yet, so Next is blocked too; it opens when the first piece plays.
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(listen).toHaveAttribute("data-state", "playing");

  // Blocks of MARKDOWN: heading, paragraph, list. Keyboard only.
  await next.focus();
  await app.page.keyboard.press("Enter");
  await expect(app.meta).toHaveText("Block 2 of 3");
  // The new block is still being made: both jumps wait until it plays.
  await expect(listen).toHaveAttribute("data-state", "loading");
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(prev).toHaveAttribute("aria-disabled", "true");
  await expect(listen).toHaveAttribute("data-state", "playing");
  await app.page.keyboard.press("Enter");
  await expect(app.meta).toHaveText("Block 3 of 3");
  await expect(listen).toHaveAttribute("data-state", "playing");
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(prev).toHaveAttribute("aria-disabled", "false");

  // Back to a block that was heard: its audio was kept, so it plays at once.
  await prev.focus();
  await app.page.keyboard.press("Enter");
  await expect(app.meta).toHaveText("Block 2 of 3");
  await expect(listen).toHaveAttribute("data-state", "playing", { timeout: 300 });

  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  await expect(next).toBeHidden();
  await expect(listen).toBeFocused();
  // Every piece was made once: no jump asked for audio again or threw away a request.
  expect((await mock.state()).speech.requests.map((r) => r.text)).toStrictEqual(SPOKEN);
});

test("Next while paused resumes the reading at the next block", async ({ app, mock }) => {
  await mock.set({ speech: { delayMs: 300, audioSeconds: 2 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  const pause = app.page.locator("#pause-source");
  await app.readAloud("source");
  await expect(listen).toHaveAttribute("data-state", "playing");
  await pause.click();
  await expect(listen).toHaveAttribute("data-state", "paused");
  await app.page.locator("#next-source").click();
  await expect(pause).toHaveAccessibleName("Pause reading");
  await expect(listen).not.toHaveAttribute("data-state", "paused");
  await expect.poll(async () => (await mock.state()).speech.requests.map((r) => r.text)).toContain("1. Install it.");
});

test("a blocked Read aloud says why, to the eye and to assistive technology", async ({ app }) => {
  await app.open();
  const listen = app.page.locator("#listen-source");
  await expect(listen).toHaveAccessibleDescription("There is no source text to read aloud yet.");
  await listen.click({ force: true });
  await expect(app.meta).toHaveText("There is no source text to read aloud yet.");
  await expect(listen).toHaveAttribute("aria-pressed", "false");
});

test("voice and speed apply from the piece being read, and are remembered", async ({ app, mock }) => {
  await mock.set({ speech: { delayMs: 200 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  await app.readAloud("source");
  await expect.poll(async () => (await mock.state()).speech.requests.length).toBeGreaterThan(0);
  await app.page.getByText("Reading aloud", { exact: true }).click();
  await app.page.getByLabel("Reading speed").selectOption("1.5");
  await app.page.getByLabel("Voice for reading aloud").selectOption("voice_02");
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });

  const { requests } = (await mock.state()).speech;
  expect(requests[0]).toMatchObject({ text: SPOKEN[0], voice: "voice_01", speed: 1 });
  const changed = requests.filter((r) => r.voice === "voice_02" && r.speed === 1.5).map((r) => r.text);
  // Nothing is skipped: the piece that was current at the change is asked for again.
  expect(changed.at(-1)).toBe(SPOKEN.at(-1));
  expect(SPOKEN.slice(-changed.length)).toStrictEqual(changed);

  await app.page.reload();
  await app.page.getByText("Reading aloud", { exact: true }).click();
  await expect(app.page.getByLabel("Reading speed")).toHaveValue("1.5");
  await expect(app.page.getByLabel("Voice for reading aloud")).toHaveValue("voice_02");
});

test("switching the source to Raw or translating stops the reading and hides the buttons", async ({ app, mock }) => {
  await mock.set({ speech: { delayMs: 400 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  await app.readAloud("source");
  await expect(listen).not.toHaveAttribute("data-state", "idle");
  await app.page.getByRole("group", { name: "Source view" }).getByRole("button", { name: "Raw" }).click();
  await expect(listen).toHaveAttribute("data-state", "idle");
  await expect(listen).toHaveAttribute("aria-pressed", "false");
  await expect(listen).toHaveAttribute("aria-disabled", "true");
  await expect(app.gutter("source").first()).toBeHidden();

  await app.previewSource();
  await app.readAloud("source");
  await expect(listen).not.toHaveAttribute("data-state", "idle");
  await app.translate.click();
  await expect(listen).toHaveAttribute("data-state", "idle");
  await expect(listen).toHaveAttribute("aria-pressed", "false");
});

test("one side is open at a time: Read aloud on the other side stops the reading", async ({ app, mock }) => {
  await mock.set({ chunks: ["你好。"], speech: { delayMs: 300, audioSeconds: 3 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill("Hello.");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await app.previewSource();
  await app.readAloud("source");
  await expect(app.page.locator("#listen-source")).toHaveAttribute("data-state", "playing");
  await app.page.locator("#listen-output").click();
  await expect(app.page.locator("#listen-source")).toHaveAttribute("aria-pressed", "false");
  await expect(app.page.locator("#listen-source")).toHaveAttribute("data-state", "idle");
  await expect(app.page.locator("#listen-output")).toHaveAttribute("aria-pressed", "true");
  await expect(app.gutter("source").first()).toBeHidden();
  await expect(app.gutter("output").first()).toBeFocused();
});

test("a failing speech engine is reported and the buttons return to idle", async ({ app, mock }) => {
  await mock.set({ chunks: ["你好"], speech: { failWith: "out of memory" } });
  await app.open();
  await app.text.fill("Hello");
  await app.translate.click();
  const listen = app.page.locator("#listen-output");
  await expect(listen).toHaveAttribute("aria-disabled", "false");
  await app.readAloud("output");
  await expect(app.meta).toHaveText("Reading aloud failed: out of memory.");
  await expect(listen).toHaveAttribute("data-state", "idle");
  await expect(app.page.locator("#pause-output")).toBeHidden();
});

test("without the speech engine Read aloud says why and the speech settings stay hidden", async ({ app, mock }) => {
  await mock.set({ speech: { state: "unavailable" } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill("Hello");
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  await expect(listen).toHaveAttribute("title", "Reading aloud is not available: the speech engine is not installed.");
  await expect(listen).toHaveAttribute("aria-disabled", "true");
  await listen.click({ force: true });
  await expect(listen).toHaveAttribute("aria-pressed", "false");
  await expect(app.page.locator("#speech-settings")).toBeHidden();
  expect((await mock.state()).speech.requests).toStrictEqual([]);
});

test("the rendered source is read from Preview, and the shade follows in it", async ({ app, mock }) => {
  await mock.set({ chunks: ["# 发布说明\n\n", "完成。\n"], speech: { delayMs: 300, audioSeconds: 1 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  const view = app.page.locator("#source-view");
  await expect(view).toBeVisible();
  await app.readAloud("source");
  await expect(view.locator(".speaking")).toHaveText("Release notes");
  await expect(view.locator(".speaking")).toHaveAttribute("aria-current", "true");
  await expect(app.page.locator("#listen-source")).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  expect((await mock.state()).speech.requests.map((r) => r.text)).toStrictEqual(SPOKEN);
});

test("switching the translation's Raw and Preview while reading keeps the reading, the shade and the buttons", async ({
  app,
  mock,
}) => {
  await mock.set({ chunks: ["# 发布说明\n\n", "完成。\n"], speech: { delayMs: 200, audioSeconds: 1 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  const listen = app.page.locator("#listen-output");
  const outputSwitch = app.page.getByRole("group", { name: "Translation view" });
  await app.readAloud("output");
  await expect(listen).toHaveAttribute("data-state", "playing");
  await expect(app.output.locator(".speaking")).toHaveCount(1);
  await outputSwitch.getByRole("button", { name: "Raw" }).click();
  await expect(listen).not.toHaveAttribute("data-state", "idle");
  await expect(app.output.locator(".speaking")).toHaveCount(1);
  await outputSwitch.getByRole("button", { name: "Preview" }).click();
  await expect(app.output.locator(".speaking")).toHaveCount(1);
  await expect(app.gutter("output")).toHaveCount(2);
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  await expect(app.output.locator(".speaking")).toHaveCount(0);
  // The same reading all the way: nothing was asked twice or skipped.
  expect((await mock.state()).speech.requests.map((r) => r.text)).toStrictEqual(["发布说明。", "完成。"]);
});

test("a 429 in the middle of a reading is explained and the buttons return to idle", async ({ app, mock }) => {
  await mock.set({ speech: { audioSeconds: 0.6 } });
  let calls = 0;
  await app.page.route("**/api/v1/speech", (route) => {
    if (++calls < 2) {
      return route.continue();
    }
    return route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "queue_full", message: "queue is full" } }),
    });
  });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  await app.readAloud("source");
  await expect(app.meta).toHaveText("The translator is busy and its queue is full. Try again in a minute.");
  await expect(listen).toHaveAttribute("data-state", "idle");
  await expect(app.page.locator("#pause-source")).toBeHidden();
  await expect(listen).toHaveAttribute("aria-disabled", "false");
});

test("a speech_error in the middle of a reading is shown the same way", async ({ app, mock }) => {
  // The audio is made ahead of the reader, so the failure is that of a later piece: it is shown
  // when the reading gets there.
  await mock.set({ speech: { delayMs: 300, audioSeconds: 0.6 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  await app.readAloud("source");
  await expect(listen).toHaveAttribute("data-state", "playing");
  await mock.set({ speech: { failWith: "out of memory" } });
  await expect(app.meta).toHaveText("Reading aloud failed: out of memory.");
  await expect(listen).toHaveAttribute("data-state", "idle");
});

/** What each speech request asked for and was answered with, in order. */
function watchSpeech(page: Page) {
  const seen: { accept: string | undefined; type: string | undefined }[] = [];
  page.on("response", (res) => {
    if (!res.url().endsWith("/api/v1/speech")) {
      return;
    }
    seen.push({ accept: res.request().headers().accept, type: res.headers()["content-type"] });
  });
  return seen;
}

test("speech arrives as a QOA stream, decoded in the worker, and plays to its end", async ({ app, mock }) => {
  // Longer than a QOA frame (5,120 samples is 0.23 s), so the stream has several.
  await mock.set({ speech: { audioSeconds: 1.5 } });
  const seen = watchSpeech(app.page);
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill("Hello there. Goodbye now.");
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  await app.readAloud("source");
  await expect(listen).toHaveAttribute("data-state", "playing");
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  expect(seen.length).toBeGreaterThan(0);
  for (const s of seen) {
    expect(s.accept).toContain("audio/qoa");
    expect(s.type).toBe("audio/qoa");
  }
  await expect(app.meta).toHaveText("");
});

test("without the QOA codec the page reads from WAV", async ({ app, mock }) => {
  await app.page.context().route("**/vendor/qoa/**", (route) => route.abort());
  const seen = watchSpeech(app.page);
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill("Hello there.");
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  await app.readAloud("source");
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  expect((await mock.state()).speech.requests).toHaveLength(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.accept).not.toContain("qoa");
  expect(seen[0]!.type).toBe("audio/wav");
  await expect(app.meta).toHaveText("");
});

test("a QOA stream that cannot be decoded is asked for again as WAV, and QOA is given up", async ({ app, mock }) => {
  let calls = 0;
  await app.page.route("**/api/v1/speech", (route) => {
    if (calls++ > 0) {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: "audio/qoa",
      body: Buffer.from("qoaf\0\0\0\0not a frame at all"),
    });
  });
  const seen = watchSpeech(app.page);
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  await app.readAloud("source");
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  // The broken answer never reached the engine, so every piece was made once; the page asked for
  // the first one again, and nothing after it named QOA.
  expect((await mock.state()).speech.requests.map((r) => r.text)).toStrictEqual(SPOKEN);
  expect(seen.length).toBe(SPOKEN.length + 1);
  expect(seen[0]).toMatchObject({ type: "audio/qoa" });
  expect(seen.slice(1).every((s) => s.type === "audio/wav" && !s.accept?.includes("qoa"))).toBe(true);
  await expect(app.meta).toHaveText("");
});

test("with no voice Read aloud says so, and a recorded voice is not needed to see the settings", async ({
  app,
  mock,
}) => {
  await mock.set({ speech: { voices: [] } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill("Hello");
  await app.previewSource();
  const listen = app.page.locator("#listen-source");
  const why = "Reading aloud needs a voice: upload or record a sample under Model and options.";
  await expect(listen).toHaveAttribute("aria-disabled", "true");
  await expect(listen).toHaveAccessibleDescription(why);
  await listen.click({ force: true });
  await expect(app.meta).toHaveText(why);
  await app.page.getByText("Reading aloud", { exact: true }).click();
  await expect(app.page.getByLabel("Voice for reading aloud").locator("option")).toHaveCount(0);
  await expect(app.page.locator("#voice-record")).toBeVisible();
  expect((await mock.state()).speech.requests).toStrictEqual([]);
});

test("a saved voice that the server no longer has gives way to the first one", async ({ app, mock }) => {
  await app.page.addInitScript(() => localStorage.setItem("voice", "gone_voice"));
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill("Hello there.");
  await app.previewSource();
  await app.page.getByText("Reading aloud", { exact: true }).click();
  await expect(app.page.getByLabel("Voice for reading aloud")).toHaveValue("voice_01");
  const listen = app.page.locator("#listen-source");
  await expect(listen).toHaveAttribute("aria-disabled", "false");
  await app.readAloud("source");
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  expect((await mock.state()).speech.requests.map((r) => r.voice)).toStrictEqual(["voice_01"]);
});

test.describe("reading aloud that becomes available later", () => {
  const unavailable = "Reading aloud is not available: the speech engine is not installed.";

  test("pressing a blocked Read aloud looks again and says when it works", async ({ app, mock }) => {
    await mock.set({ speech: { state: "unavailable" } });
    await app.open();
    await app.from.selectOption("en");
    await app.text.fill("Hello there.");
    await app.previewSource();
    const listen = app.page.locator("#listen-source");
    await expect(listen).toHaveAccessibleDescription(unavailable);
    await expect(app.page.locator("#speech-settings")).toBeHidden();

    await mock.set({ speech: { state: "stopped" } });
    await listen.click({ force: true });
    await expect(app.meta).toHaveText("Reading aloud is available now. Press Read aloud to start.");
    await expect(listen).toHaveAttribute("aria-disabled", "false");
    await expect(listen).toHaveAccessibleDescription("");
    await expect(app.page.locator("#speech-settings")).toBeVisible();
    await app.readAloud("source");
    await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
    expect((await mock.state()).speech.requests.map((r) => r.text)).toStrictEqual(["Hello there."]);
  });

  test("regaining focus looks again once, without polling", async ({ app, mock }) => {
    await mock.set({ speech: { state: "unavailable" } });
    let asked = 0;
    app.page.on("request", (r) => {
      if (r.url().endsWith("/api/v1/voices")) {
        asked++;
      }
    });
    await app.open();
    await app.from.selectOption("en");
    await app.text.fill("Hello there.");
    await app.previewSource();
    const listen = app.page.locator("#listen-source");
    await expect(listen).toHaveAttribute("aria-disabled", "true");
    expect(asked).toBe(1);

    await mock.set({ speech: { state: "stopped" } });
    // Nothing asks by itself.
    await app.page.waitForTimeout(3500);
    expect(asked).toBe(1);
    await expect(listen).toHaveAttribute("aria-disabled", "true");

    // A burst of events is one look.
    await app.page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(listen).toHaveAttribute("aria-disabled", "false");
    expect(asked).toBe(2);
    // Working now: further focus events ask nothing.
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.page.waitForTimeout(300);
    expect(asked).toBe(2);
  });

  test("a voice that appears (none at first) enables Read aloud and fills the list", async ({ app, mock }) => {
    await mock.set({ speech: { voices: [] } });
    await app.open();
    await app.from.selectOption("en");
    await app.text.fill("Hello there.");
    await app.previewSource();
    const listen = app.page.locator("#listen-source");
    await expect(listen).toHaveAttribute("aria-disabled", "true");
    await mock.set({ speech: { voices: [{ id: "late", name: "Late voice" }] } });
    await listen.click({ force: true });
    await expect(listen).toHaveAttribute("aria-disabled", "false");
    await expect(app.page.getByLabel("Voice for reading aloud").locator("option")).toHaveText(["Late voice"]);
  });

  test("after a failed reading the voice list is refreshed when a block is chosen again", async ({ app, mock }) => {
    await mock.set({ speech: { failWith: "out of memory" } });
    await app.open();
    await app.from.selectOption("en");
    await app.text.fill("Hello there.");
    await app.previewSource();
    const listen = app.page.locator("#listen-source");
    await app.readAloud("source");
    await expect(app.meta).toHaveText("Reading aloud failed: out of memory.");
    await mock.set({
      speech: {
        failWith: "",
        voices: [
          { id: "voice_01", name: "Voice 01" },
          { id: "voice_03", name: "Voice 03" },
        ],
      },
    });
    // The buttons stayed after the failure.
    await app.gutter("source").first().click();
    await expect(app.page.getByLabel("Voice for reading aloud").locator("option")).toHaveText(["Voice 01", "Voice 03"]);
    await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  });
});

// Recording a voice sample. Chromium runs with a fake microphone (a tone) and accepts its
// permission prompt (flags in e2e/playwright.config.ts).
test.describe("recording a voice sample", () => {
  test("Record, Stop and the new voice is selected", async ({ app }) => {
    await app.open();
    await app.page.getByText("Reading aloud", { exact: true }).click();
    const record = app.page.locator("#voice-record");
    const status = app.page.locator("#clone-status");
    await record.click();
    await expect(record).toHaveText("Stop recording");
    await expect(status).toContainText("Recording");
    await app.page.waitForTimeout(1500); // the sample must be at least a second long
    await record.click();
    await expect(record).toHaveText("Record");
    await expect(status).toContainText(/Voice "Recording .*" added/);
    await expect(app.page.getByLabel("Voice for reading aloud").locator("option:checked")).toContainText("Recording");
  });

  test("a second click during the permission prompt opens no second stream, and every track ends", async ({ app }) => {
    await app.page.addInitScript(() => {
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const w = window as unknown as { __streams: MediaStream[]; __release: () => void };
      w.__streams = [];
      let release = () => {};
      const gate = new Promise<void>((r) => void (release = r));
      w.__release = release;
      navigator.mediaDevices.getUserMedia = async (c) => {
        await gate;
        const s = await real(c);
        w.__streams.push(s);
        return s;
      };
    });
    await app.open();
    await app.page.getByText("Reading aloud", { exact: true }).click();
    const record = app.page.locator("#voice-record");
    await record.click();
    await record.click(); // the prompt is still open
    await app.page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await expect(record).toHaveText("Stop recording");
    await app.page.waitForTimeout(1200);
    await record.click();
    await expect(record).toHaveText("Record");
    await expect(app.page.locator("#clone-status")).toContainText(/added/);
    const result = await app.page.evaluate(() => {
      const streams = (window as unknown as { __streams: MediaStream[] }).__streams;
      const live = streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live");
      return { streams: streams.length, live: live.length };
    });
    expect(result).toStrictEqual({ streams: 1, live: 0 });
  });

  test("a denied microphone is explained and Record works again", async ({ app }) => {
    await app.page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    await app.open();
    await app.page.getByText("Reading aloud", { exact: true }).click();
    const record = app.page.locator("#voice-record");
    await record.click();
    await expect(app.page.locator("#clone-status")).toContainText("Microphone access was denied");
    await expect(record).toHaveText("Record");
    await record.click();
    await expect(app.page.locator("#clone-status")).toContainText("Microphone access was denied");
  });
});
