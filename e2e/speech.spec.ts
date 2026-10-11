// Reading aloud, with the mock speech engine: it answers every utterance with a tenth of a second
// of silence and records what it was asked to say.

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

test("Listen needs a text and a language the model speaks", async ({ app }) => {
  await app.open();
  const listen = app.page.locator("#listen-source");
  await expect(listen).toHaveAttribute("aria-disabled", "true");
  await expect(listen).toHaveAttribute("title", "There is no source text to read aloud yet.");

  await app.text.fill("Bonjour");
  await expect(listen).toHaveAttribute("title", "Choose the language under From to have this text read aloud.");
  await app.from.selectOption("fr");
  await expect(listen).toHaveAttribute("title", /Chinese, English, Japanese, Spanish and Arabic/);
  await app.from.selectOption("es");
  await expect(listen).toHaveAttribute("aria-disabled", "false");
  await expect(listen).toHaveAccessibleName("Listen to the source text");
  await expect(app.page.locator("#listen-output")).toHaveAttribute("aria-disabled", "true");
});

test("Markdown is read from what is rendered, piece by piece, and reading ends by itself", async ({ app, mock }) => {
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  const listen = app.page.locator("#listen-source");
  await listen.click();
  await expect(listen).toHaveAccessibleName("Stop reading the source text");
  await expect(app.page.locator("#pause-source")).toBeVisible();
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  await expect(app.page.locator("#pause-source")).toBeHidden();

  const { speech } = await mock.state();
  expect(speech.requests.map((r) => r.text)).toEqual(SPOKEN);
  expect(speech.requests.every((r) => r.lang === "en" && r.voice === "voice_01" && r.speed === 1)).toBe(true);
});

test("the translation is read in the target language and the block being read is shaded", async ({ app, mock }) => {
  await mock.set({
    chunks: ["# 发布说明\n\n", "我们修复了 **三个** 错误。\n\n", "- 安装\n- 运行\n"],
    speech: { delayMs: 300 },
  });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  const listen = app.page.locator("#listen-output");
  await expect(listen).toHaveAttribute("aria-disabled", "true");
  await app.translate.click();
  await expect(listen).toHaveAttribute("aria-disabled", "false");

  await listen.click();
  await expect(app.output.locator(".speaking")).toHaveText("发布说明");
  await expect(app.output.locator(".speaking")).toHaveText("我们修复了 三个 错误。");
  // Switching the view rebuilds the output; the shade is put back, in Raw on the block's first line.
  await app.page.getByRole("group", { name: "Translation view" }).getByRole("button", { name: "Raw" }).click();
  await expect(app.output.locator(".speaking")).toHaveCount(1);
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  await expect(app.output.locator(".speaking")).toHaveCount(0);

  const { speech } = await mock.state();
  expect(speech.requests.map((r) => [r.lang, r.text])).toEqual([
    ["zh", "发布说明。"],
    ["zh", "我们修复了三个错误。"],
    ["zh", "安装。"],
    ["zh", "运行。"],
  ]);
});

test("Pause holds the reading where it is and Resume goes on; Stop ends it", async ({ app, mock }) => {
  await mock.set({ speech: { delayMs: 200 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  const listen = app.page.locator("#listen-source");
  const pause = app.page.locator("#pause-source");
  await listen.click();
  await expect(listen).toHaveAttribute("data-state", "loading");
  await expect(pause).toHaveAccessibleName("Pause reading");
  await pause.click();
  await expect(listen).toHaveAttribute("data-state", "paused");
  await expect(pause).toHaveAccessibleName("Resume reading");

  // Paused: the audio that was being fetched arrives and the next piece is fetched, but nothing plays on.
  await app.page.waitForTimeout(1500);
  await expect(listen).toHaveAttribute("data-state", "paused");
  expect((await mock.state()).speech.requests.length).toBeLessThanOrEqual(2);

  await pause.click();
  await expect.poll(async () => (await mock.state()).speech.requests.length).toBeGreaterThan(2);
  await listen.click();
  await expect(listen).toHaveAttribute("data-state", "idle");
  await expect(pause).toBeHidden();
  const asked = (await mock.state()).speech.requests.length;
  await app.page.waitForTimeout(600);
  expect((await mock.state()).speech.requests.length).toBe(asked);
});

test("voice and speed apply from the piece being read, and are remembered", async ({ app, mock }) => {
  await mock.set({ speech: { delayMs: 200 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  const listen = app.page.locator("#listen-source");
  await listen.click();
  await expect.poll(async () => (await mock.state()).speech.requests.length).toBeGreaterThan(0);
  await app.page.getByLabel("Reading speed").selectOption("1.5");
  await app.page.getByLabel("Voice for reading aloud").selectOption("voice_02");
  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });

  const { requests } = (await mock.state()).speech;
  expect(requests[0]).toMatchObject({ text: SPOKEN[0], voice: "voice_01", speed: 1 });
  const changed = requests.filter((r) => r.voice === "voice_02" && r.speed === 1.5).map((r) => r.text);
  // Nothing is skipped: the piece that was current at the change is asked for again.
  expect(changed.at(-1)).toBe(SPOKEN.at(-1));
  expect(SPOKEN.slice(-changed.length)).toEqual(changed);

  await app.page.reload();
  await expect(app.page.getByLabel("Reading speed")).toHaveValue("1.5");
  await expect(app.page.getByLabel("Voice for reading aloud")).toHaveValue("voice_02");
});

test("editing the text or translating stops the reading", async ({ app, mock }) => {
  await mock.set({ speech: { delayMs: 400 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  const listen = app.page.locator("#listen-source");
  await listen.click();
  await expect(listen).not.toHaveAttribute("data-state", "idle");
  await app.text.pressSequentially("More.");
  await expect(listen).toHaveAttribute("data-state", "idle");

  await listen.click();
  await expect(listen).not.toHaveAttribute("data-state", "idle");
  await app.translate.click();
  await expect(listen).toHaveAttribute("data-state", "idle");
});

test("a failing speech engine is reported and the buttons return to Listen", async ({ app, mock }) => {
  await mock.set({ chunks: ["你好"], speech: { failWith: "out of memory" } });
  await app.open();
  await app.text.fill("Hello");
  await app.translate.click();
  const listen = app.page.locator("#listen-output");
  await expect(listen).toHaveAttribute("aria-disabled", "false");
  await listen.click();
  await expect(app.meta).toHaveText("Reading aloud failed: out of memory.");
  await expect(listen).toHaveAttribute("data-state", "idle");
  await expect(app.page.locator("#pause-output")).toBeHidden();
});

test("without the speech engine Listen says why and the speech settings stay hidden", async ({ app, mock }) => {
  await mock.set({ speech: { state: "unavailable" } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill("Hello");
  const listen = app.page.locator("#listen-source");
  await expect(listen).toHaveAttribute("title", "Reading aloud is not available: the speech engine is not installed.");
  await expect(listen).toHaveAttribute("aria-disabled", "true");
  await listen.click({ force: true });
  await expect(listen).toHaveAttribute("data-state", "idle");
  await expect(app.page.locator("#speech-settings")).toBeHidden();
  expect((await mock.state()).speech.requests).toEqual([]);
});
