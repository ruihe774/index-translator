// SubRip subtitles: sent without their times, shown as a table of cues on both sides, matched cue by
// cue for click-to-sync, kept in the history and read aloud by cue.

import type { Page } from "@playwright/test";

import { expect, test, THINK } from "./fixtures";

const SRT = `1
00:00:01,000 --> 00:00:02,500
Hello there.

2
00:00:03,000 --> 00:00:04,000
<i>How are</i>
you?

3
00:00:05,000 --> 00:00:06,000
Fine, thanks.
`;

/** The model put cue 2's text under cue 1 and left 2 empty. */
const OUTPUT = ["1\n你好，", "你好吗？\n\n", "2\n\n", "3\n很好，谢谢。"];

const rows = (page: Page, view: string) => page.locator(`${view} tbody tr`);
const SWITCH = (page: Page, group: string, name: string) =>
  page.getByRole("group", { name: group }).getByRole("button", { name, exact: true });

test("subtitles are sent without their times and come back as a table with the source's times", async ({
  app,
  mock,
}) => {
  await mock.set({ chunks: [THINK, ...OUTPUT], delayMs: 50 });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(SRT);
  await expect(app.page.locator("#count")).toHaveText(/^3 cues, \d+ letters$/);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  const { requests } = await mock.state();
  expect(requests[0]!.prompt).toContain("1\nHello there.\n\n2\n<i>How are</i>\nyou?\n\n3\nFine, thanks.");
  expect(requests[0]!.prompt).not.toContain("-->");
  expect(requests[0]!.prompt).toContain("逐条翻译");

  // Both sides are tables; the joined cue runs from cue 1's start to cue 2's end.
  await expect(rows(app.page, "#source-view")).toHaveCount(3);
  await expect(rows(app.page, "#source-view").nth(1).locator(".cue-text i")).toHaveText("How are");
  await expect(rows(app.page, "#output")).toHaveCount(2);
  await expect(rows(app.page, "#output").first().locator(".cue-time")).toHaveText("0:00:01 – 0:00:04");
  await expect(rows(app.page, "#output").first().locator(".cue-text")).toHaveText("你好，你好吗？");
  await expect(app.notes.first()).toContainText("The translation put cue 2 together with the cue before it");

  // Hovering the second source cue shades its counterpart, the first cue of the translation.
  await expect(app.page.locator("#output-area")).toHaveClass(/synced/);
  await rows(app.page, "#source-view").nth(1).hover();
  await expect(app.output.locator(".linked")).toHaveCount(1);
  await expect(rows(app.page, "#output").first()).toHaveClass(/linked/);
  await app.page.mouse.move(0, 0);

  // Raw shows (and Copy puts) the translation as SubRip.
  await SWITCH(app.page, "Translation view", "Raw").click();
  await expect(app.output).toHaveText(
    "1\n00:00:01,000 --> 00:00:04,000\n你好，你好吗？\n\n3\n00:00:05,000 --> 00:00:06,000\n很好，谢谢。\n",
  );
});

test("rows appear with their times as the translation streams", async ({ app, mock }) => {
  await mock.set({ chunks: ["1\n你好。\n\n", "2\n你好吗？\n\n", "3\n很好。"], delayMs: 600 });
  await app.open();
  await app.text.fill(SRT);
  await app.translate.click();
  await expect(rows(app.page, "#output")).toHaveCount(1);
  await expect(rows(app.page, "#output").first().locator(".cue-time")).toHaveText("0:00:01 – 0:00:02");
  await expect(app.stop).toBeVisible();
  await expect(rows(app.page, "#output")).toHaveCount(3);
});

test("a stopped translation keeps the cues it reached and says which were not translated", async ({ app, mock }) => {
  await mock.set({ chunks: ["1\n你好。\n\n", "2\n你好吗？\n\n", "3\n很好。"], delayMs: 800 });
  await app.open();
  await app.text.fill(SRT);
  await app.translate.click();
  await expect(rows(app.page, "#output")).toHaveCount(1);
  await app.stop.click();
  await expect(app.meta).toHaveText("You stopped the translation. The text above is incomplete.");
  await expect(app.notes.last()).toHaveText(/^Cues? [23]( to 3)? (was|were) not translated\.$/);
  await expect(app.page.locator("#output-area")).toHaveClass(/synced/);
});

test("an opened .srt file is shown as a table, and a restored one is matched again", async ({ app, mock }) => {
  await mock.set({ chunks: OUTPUT });
  await app.open();
  await app.page.locator("#open-file").setInputFiles({ name: "episode.srt", mimeType: "", buffer: Buffer.from(SRT) });
  await expect(rows(app.page, "#source-view")).toHaveCount(3);
  const headers = app.page.locator("#source-view").getByRole("columnheader");
  expect(await headers.evaluateAll((ths) => ths.map((th) => th.textContent))).toStrictEqual(["#Cue", "Time", "Text"]);
  await expect(app.page.locator("#source-view").getByRole("columnheader", { name: "Cue", exact: true })).toBeVisible();
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  await app.page.reload();
  await expect(app.from.locator("option")).not.toHaveCount(0);
  await app.page.getByRole("link", { name: /^Restore translation/ }).click();
  await expect(rows(app.page, "#output")).toHaveCount(2);
  await expect(app.page.locator("#output-area")).toHaveClass(/synced/);
  await rows(app.page, "#output").first().hover();
  await expect(app.page.locator("#source-view .linked")).toHaveCount(2);
});

test("subtitles always go to Index-Translate-9B, and more than 200 cues are warned about", async ({ app, mock }) => {
  await mock.set({ chunks: ["1\n一"] });
  await app.open();
  const many = Array.from(
    { length: 201 },
    (_, i) =>
      `${i + 1}\n00:00:${String(i % 60).padStart(2, "0")},000 --> 00:00:${String(i % 60).padStart(2, "0")},500\nLine ${i}.`,
  ).join("\n\n");
  await app.model("Index-NativeLong-9B").click();
  await app.text.fill(many);
  await expect(app.advice).toContainText("these subtitles have 201 cues");
  await expect(app.advice).toContainText("Index-NativeLong-9B does not translate subtitles");
  await app.translate.click();
  await expect(app.meta).toContainText("Index-Translate-9B");
});

test("reading a subtitle translation aloud reads the cues' text only", async ({ app, mock }) => {
  await mock.set({ chunks: ["1\nHola.\n\n", "2\n¿Cómo\nestás?\n\n", "3\nBien."] });
  await app.open();
  await app.to.selectOption("es");
  await app.text.fill(SRT);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await app.page.locator("#listen-output").click();
  await app.page.getByRole("button", { name: "Read from: Hola." }).click();
  await expect
    .poll(async () => (await mock.state()).speech.requests.map((r) => r.text))
    .toStrictEqual(["Hola.", "¿Cómo estás?", "Bien."]);
});
