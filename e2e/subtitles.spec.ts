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

test("subtitles always go to Index-Translate-9B", async ({ app, mock }) => {
  await mock.set({ chunks: ["1\n一"] });
  await app.open();
  await app.model("Index-NativeLong-9B").click();
  await app.text.fill(SRT);
  await expect(app.advice).toHaveText(
    "Warning: Index-NativeLong-9B does not translate subtitles. Index-Translate-9B will be used.",
  );
  await app.translate.click();
  await expect(app.meta).toContainText("Index-Translate-9B");
});

/** `n` cues, cue i saying "Line i.", a second each. */
const many = (n: number) =>
  Array.from({ length: n }, (_, k) => {
    const s = String(k % 60).padStart(2, "0");
    const m = String(Math.floor(k / 60)).padStart(2, "0");
    return `${k + 1}\n00:${m}:${s},000 --> 00:${m}:${s},800\nLine ${k + 1}.`;
  }).join("\n\n");

/** A reply numbering `count` cues from 1, cue j saying `${prefix}${first + j - 1}`, one piece per cue. */
const reply = (prefix: string, first: number, count: number) =>
  Array.from({ length: count }, (_, k) => `${k + 1}\n${prefix}${first + k}\n\n`);

test("a long file goes in overlapping parts, put together into one translation", async ({ app, mock }) => {
  // 150 cues: cues 1–100, then 85–150 (16 overlap); the translation passes to the second part at cue 93.
  await mock.set({ replies: [reply("甲", 1, 100), reply("乙", 85, 66)], delayMs: 20 });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(many(150));
  await expect(app.advice).toHaveText("");
  await app.translate.click();
  await expect(app.meta).toContainText(/Part 2 of 2\.$/);
  await expect(app.meta).toContainText("generated");

  const { requests } = await mock.state();
  expect(requests).toHaveLength(2);
  expect(requests[0]!.prompt).toContain("1\nLine 1.\n\n2\nLine 2.");
  expect(requests[0]!.prompt).toContain("100\nLine 100.");
  expect(requests[0]!.prompt).not.toContain("101\n");
  expect(requests[1]!.prompt).toContain("1\nLine 85.\n\n2\nLine 86.");
  expect(requests[1]!.prompt).toContain("66\nLine 150.");
  for (const r of requests) {
    expect(r.prompt).toContain("逐条翻译");
  }

  const out = rows(app.page, "#output");
  await expect(out).toHaveCount(150);
  await expect(out.nth(91).locator(".cue-text")).toHaveText("甲92");
  await expect(out.nth(92).locator(".cue-text")).toHaveText("乙93");
  await expect(out.nth(149).locator(".cue-text")).toHaveText("乙150");
  await expect(app.notes).toHaveCount(0);
  await expect(app.page.locator("#output-area")).toHaveClass(/synced/);
});

test("Stop in a later part keeps what came before and stops that part's job", async ({ app, mock }) => {
  // The first part comes in one piece, the second slowly.
  await mock.set({ replies: [[reply("甲", 1, 100).join("")], reply("乙", 85, 66)], delayMs: 100 });
  await app.open();
  await app.text.fill(many(150));
  await app.translate.click();
  await expect(app.meta).toContainText(/Part 2 of 2\.$/);
  // Past the overlap, so the second part's text is shown.
  await expect(rows(app.page, "#output").nth(100)).toBeVisible();
  await app.stop.click();
  await expect(app.meta).toHaveText("You stopped the translation. The text above is incomplete.");
  await expect(rows(app.page, "#output").nth(91).locator(".cue-text")).toHaveText("甲92");
  await expect(app.notes.last()).toHaveText(/^Cues \d+ to 150 were not translated\.$/);
  await expect.poll(async () => (await mock.state()).aborted).toBe(1);
  expect((await mock.state()).requests).toHaveLength(2);
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

test("the page is wider while a cue table is shown, and Clear gives the width back", async ({ app, mock }) => {
  await mock.set({ chunks: OUTPUT, delayMs: 0 });
  await app.page.setViewportSize({ width: 2800, height: 900 });
  await app.open();
  const main = app.page.locator("main");
  const width = async () => (await main.boundingBox())!.width;
  const rem = await app.page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(await width()).toBeCloseTo(120 * rem, 0);

  await app.text.fill(SRT);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await expect.poll(width).toBeCloseTo(160 * rem, 0);

  await app.page.locator("#clear").click();
  await expect(app.text).toBeVisible();
  await expect.poll(width).toBeCloseTo(120 * rem, 0);
});

test("the width change animates, a window resize does not, and reduced motion turns it off", async ({ app, mock }) => {
  await mock.set({ chunks: OUTPUT, delayMs: 0 });
  await app.page.setViewportSize({ width: 2800, height: 900 });
  await app.open();
  const running = () =>
    app.page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => a instanceof CSSTransition && (a.effect as KeyframeEffect).target?.tagName === "MAIN").length,
    );

  for (const width of [2400, 320, 1280, 2800]) {
    await app.page.setViewportSize({ width, height: 900 });
    expect(await running()).toBe(0);
  }

  await app.text.fill(SRT);
  await app.page.evaluate(() => {
    const main = document.querySelector("main")!;
    (window as unknown as { seen: number }).seen = 0;
    main.addEventListener("transitionrun", () => void (window as unknown as { seen: number }).seen++);
  });
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await expect.poll(() => app.page.evaluate(() => (window as unknown as { seen: number }).seen)).toBeGreaterThan(0);
  expect(await app.page.locator("main").evaluate((m) => getComputedStyle(m).transitionDuration)).toBe("0.5s");

  await app.page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await app.page.locator("main").evaluate((m) => parseFloat(getComputedStyle(m).transitionDuration));
  expect(reduced).toBeLessThan(0.001);
});
