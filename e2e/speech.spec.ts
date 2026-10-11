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
  await mock.set({ speech: { delayMs: 200, audioSeconds: 1 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  const listen = app.page.locator("#listen-source");
  const pause = app.page.locator("#pause-source");
  await listen.click();
  // While the audio is being made only Stop works, and Pause shows a spinner.
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

test("Previous and Next jump between blocks, say where, and hand focus back when reading ends", async ({
  app,
  mock,
}) => {
  await mock.set({ speech: { delayMs: 400, audioSeconds: 1.5 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  const listen = app.page.locator("#listen-source");
  const prev = app.page.locator("#prev-source");
  const next = app.page.locator("#next-source");
  await expect(prev).toBeHidden();
  await listen.click();
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
  // The new block is being made: both jumps wait until it plays.
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(prev).toHaveAttribute("aria-disabled", "true");
  await expect(listen).toHaveAttribute("data-state", "playing");
  await app.page.keyboard.press("Enter");
  await expect(app.meta).toHaveText("Block 3 of 3");
  await expect(listen).toHaveAttribute("data-state", "playing");
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(prev).toHaveAttribute("aria-disabled", "false");

  await prev.focus();
  await app.page.keyboard.press("Enter");
  await expect(app.meta).toHaveText("Block 2 of 3");

  await expect(listen).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  await expect(next).toBeHidden();
});

test("Next while paused resumes the reading at the next block", async ({ app, mock }) => {
  await mock.set({ speech: { delayMs: 300, audioSeconds: 2 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  const listen = app.page.locator("#listen-source");
  const pause = app.page.locator("#pause-source");
  await listen.click();
  await expect(listen).toHaveAttribute("data-state", "playing");
  await pause.click();
  await expect(listen).toHaveAttribute("data-state", "paused");
  await app.page.locator("#next-source").click();
  await expect(pause).toHaveAccessibleName("Pause reading");
  await expect(listen).not.toHaveAttribute("data-state", "paused");
  await expect.poll(async () => (await mock.state()).speech.requests.map((r) => r.text)).toContain("1. Install it.");
});

test("a blocked Listen says why, to the eye and to assistive technology", async ({ app }) => {
  await app.open();
  const listen = app.page.locator("#listen-source");
  await expect(listen).toHaveAccessibleDescription("There is no source text to read aloud yet.");
  await listen.click({ force: true });
  await expect(app.meta).toHaveText("There is no source text to read aloud yet.");
});

test("voice and speed apply from the piece being read, and are remembered", async ({ app, mock }) => {
  await mock.set({ speech: { delayMs: 200 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MARKDOWN);
  const listen = app.page.locator("#listen-source");
  await listen.click();
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
  expect(SPOKEN.slice(-changed.length)).toEqual(changed);

  await app.page.reload();
  await app.page.getByText("Reading aloud", { exact: true }).click();
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

// Recording a voice sample. Chromium runs with a fake microphone (a tone) and accepts its
// permission prompt (flags in playwright.config.ts).
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
      const gate = new Promise<void>((r) => {
        release = r;
      });
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
    expect(result).toEqual({ streams: 1, live: 0 });
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
