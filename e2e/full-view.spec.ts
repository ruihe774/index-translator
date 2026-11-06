// Full view (full-view.ts): one side's rendered text alone on the page, scrolled by the page, under a bar
// with the Source / Translation switch and Exit.

import { type AppPage, expect, test, THINK } from "./fixtures";

const PHONE = { width: 360, height: 740 };
const BLOCKS = 40;
const source = Array.from({ length: BLOCKS }, (_, i) => `Paragraph ${i}: ${"words ".repeat(20)}`).join("\n\n");
const chunks = Array.from({ length: BLOCKS }, (_, i) => `段落 ${i}：${"文字".repeat(30)}\n\n`);

const bar = (app: AppPage) => app.page.getByRole("group", { name: "Shown panel" });
const exit = (app: AppPage) => app.page.getByRole("button", { name: "Exit full view" });
const openSource = (app: AppPage) => app.page.getByRole("button", { name: "Show the source text in full view" });
const openOutput = (app: AppPage) => app.page.getByRole("button", { name: "Show the translation in full view" });

/** The `data-line` of the first block of `view` below the bar (or the area's top out of full view). */
function topBlock(app: AppPage, view: "#source-view" | "#output") {
  return app.page.evaluate((view) => {
    const { fullView } = document.documentElement.dataset;
    const top = fullView
      ? document.querySelector(".pane-bar")!.getBoundingClientRect().bottom
      : document.querySelector(view)!.parentElement!.getBoundingClientRect().top;
    const el = [...document.querySelectorAll<HTMLElement>(`${view} > [data-line]`)].find(
      (e) => e.getBoundingClientRect().bottom > top + 1,
    );
    return el?.textContent?.match(/\d+/)?.[0];
  }, view);
}

async function translated(app: AppPage, mock: { set(k: object): Promise<void> }) {
  await mock.set({ chunks: [THINK, ...chunks] });
  await app.open();
  await app.text.fill(source);
  await app.translate.click();
  await expect(app.output).toContainText(`段落 ${BLOCKS - 1}`);
  await expect(app.copy).toHaveAttribute("aria-disabled", "false");
}

test("full view: the page scrolls one side; the switch brings the other in at its counterpart; Escape leaves", async ({
  app,
  mock,
}) => {
  await app.page.setViewportSize({ width: 1280, height: 800 });
  await translated(app, mock);
  // The source is in Raw: its full view waits for Preview.
  await expect(openSource(app)).toHaveAttribute("aria-disabled", "true");
  await openSource(app).click({ force: true });
  await expect(bar(app)).toBeHidden();

  await openOutput(app).click();
  await expect(exit(app)).toBeFocused();
  await expect(bar(app)).toBeVisible();
  await expect(app.page.locator(".site-header")).toBeHidden();
  await expect(app.text).toBeHidden();
  await expect(bar(app).getByRole("button", { name: "Translation" })).toHaveAttribute("aria-pressed", "true");
  // The pane does not scroll; the page does.
  const area = app.page.locator("#output-area");
  expect(await area.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect(await app.page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(1000);
  expect(await app.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);

  await app.page.locator("#output > [data-line]", { hasText: "段落 20：" }).evaluate((el) => {
    scrollBy(0, el.getBoundingClientRect().top - document.querySelector(".pane-bar")!.getBoundingClientRect().bottom);
  });
  await expect.poll(() => topBlock(app, "#output")).toBe("20");
  await expect(bar(app)).toBeInViewport();

  // The source was in Raw: going there turns it to Preview, at the counterpart of the block at the top.
  // Clicked by script: Playwright would first scroll the page to bring the sticky bar to the middle.
  await bar(app)
    .getByRole("button", { name: "Source text" })
    .evaluate((b: HTMLElement) => b.click());
  await expect(app.page.locator("#source-view")).toBeVisible();
  await expect(app.page.locator("#output")).toBeHidden();
  await expect(app.page.locator('#source-switch [data-value="preview"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => topBlock(app, "#source-view")).toBe("20");

  await app.page.keyboard.press("Escape");
  await expect(bar(app)).toBeHidden();
  await expect(app.page.locator(".site-header")).toBeVisible();
  await expect(openSource(app)).toBeFocused();
  await expect(openSource(app)).toHaveAttribute("aria-disabled", "false");
  // The pane is left where full view was.
  await expect.poll(() => topBlock(app, "#source-view")).toBe("20");
});

test("full view: a wide table grows beyond the reading column, centred, without page overflow", async ({
  app,
  mock,
}) => {
  const row = (cell: string) =>
    `| ${Array.from({ length: 16 }, (_, i) => `${cell} ${i} ${"word ".repeat(4)}`).join(" | ")} |`;
  const table = `${row("head")}\n${Array.from({ length: 16 }, () => "---")
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |")}\n${row("cell")}`;
  await mock.set({ chunks: [THINK, `# 表\n\n${table}\n`] });
  await app.page.setViewportSize({ width: 2400, height: 800 });
  await app.open();
  await app.text.fill(`# Table\n\n${table}\n`);
  await app.translate.click();
  await expect(app.output.locator("table")).toBeVisible();
  await expect(app.copy).toHaveAttribute("aria-disabled", "false");
  await openOutput(app).click();

  const measure = () =>
    app.page.evaluate(() => {
      const scroll = document.querySelector("#output > .table-scroll")!.getBoundingClientRect();
      const area = document.querySelector("#output-area")!.getBoundingClientRect();
      const root = document.documentElement;
      return { scroll, area, overflow: root.scrollWidth - root.clientWidth, width: root.clientWidth };
    });
  const wide = await measure();
  expect(wide.scroll.width).toBeGreaterThan(wide.area.width + 100);
  expect(wide.scroll.left).toBeGreaterThanOrEqual(0);
  expect(wide.scroll.right).toBeLessThanOrEqual(wide.width);
  expect(wide.scroll.left + wide.scroll.right).toBeCloseTo(wide.area.left + wide.area.right, 0);
  expect(wide.overflow).toBeLessThanOrEqual(0);
  // At most 96rem: twice the column.
  expect(wide.scroll.width).toBeLessThanOrEqual(1536 + 1);
  expect(wide.scroll.width).toBeGreaterThan(1536 - 1);

  // Less room than that: the page's width less the gutters.
  await app.page.setViewportSize({ width: 1280, height: 800 });
  const medium = await measure();
  expect(medium.scroll.width).toBeCloseTo(medium.width - 32, 0);
  expect(medium.overflow).toBeLessThanOrEqual(0);

  // Narrow: the column's own width, the table scrolling inside it.
  await app.page.setViewportSize(PHONE);
  const narrow = await measure();
  expect(narrow.scroll.width).toBeLessThanOrEqual(narrow.width);
  expect(narrow.overflow).toBeLessThanOrEqual(0);
});

test("full view: Back leaves it and stays on the page", async ({ app, mock }) => {
  await app.page.setViewportSize({ width: 1280, height: 800 });
  await translated(app, mock);
  const url = app.page.url();
  await openOutput(app).click();
  await expect(exit(app)).toBeVisible();
  await app.page.goBack();
  await expect(exit(app)).toBeHidden();
  await expect(app.page.locator(".site-header")).toBeVisible();
  expect(app.page.url()).toBe(url);
  await expect(app.output).toContainText("段落 0");

  // Exit takes its own history entry back with it.
  await openOutput(app).click();
  await exit(app).click();
  await expect(exit(app)).toBeHidden();
  await expect(openOutput(app)).toBeFocused();
  await expect.poll(() => app.page.evaluate(() => history.state as unknown)).toBeNull();
});

test("full view on one column: the bar is on top, and Exit leaves the row on the side shown", async ({ app, mock }) => {
  await app.page.setViewportSize(PHONE);
  await translated(app, mock);
  await openOutput(app).click();
  await expect(bar(app)).toBeVisible();
  expect(await app.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  const box = (await app.page.locator("#output").boundingBox())!;
  expect(box.width).toBeGreaterThan(PHONE.width - 40);
  for (const b of [...(await bar(app).getByRole("button").all()), exit(app)]) {
    const size = (await b.boundingBox())!;
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(24);
  }
  await app.page.mouse.wheel(0, 2000);
  await expect(bar(app)).toBeInViewport();

  await bar(app).getByRole("button", { name: "Source text" }).click();
  await expect(app.page.locator("#source-view")).toBeVisible();
  await exit(app).click();
  await expect(bar(app).getByRole("button", { name: "Source text" })).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      app.page.evaluate(() => {
        const panel = document.querySelector(".panel.source")!.getBoundingClientRect();
        return panel.left >= 0 && panel.right <= innerWidth;
      }),
    )
    .toBe(true);
});

test("full view leaves when its side has nothing to show", async ({ app, mock }) => {
  await app.page.setViewportSize({ width: 1280, height: 800 });
  await translated(app, mock);
  await app.previewSource();
  await openSource(app).click();
  await expect(exit(app)).toBeVisible();
  // As a file dropped on the page would: the source becomes empty.
  await app.page.evaluate(() => {
    const t = document.querySelector<HTMLTextAreaElement>("textarea#text")!;
    t.value = "";
    t.dispatchEvent(new Event("input"));
  });
  await expect(exit(app)).toBeHidden();
});

/** Makes the stylesheets' `(display-mode: standalone)` rules apply, as when installed (Chromium cannot emulate it). */
async function emulateStandalone(app: AppPage) {
  return app.page.evaluate(() => {
    let changed = 0;
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSImportRule && rule.styleSheet) {
          visit(rule.styleSheet.cssRules);
        } else if (rule instanceof CSSMediaRule) {
          const text = rule.media.mediaText;
          if (text.includes("display-mode: standalone")) {
            rule.media.mediaText = text.replaceAll("(display-mode: standalone)", "(min-width: 0)");
            changed++;
          }
          visit(rule.cssRules);
        } else if ("cssRules" in rule) {
          visit((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      visit(sheet.cssRules);
    }
    return changed;
  });
}

for (const [orientation, size] of [
  ["portrait", PHONE],
  ["landscape", { width: 740, height: 360 }],
] as const) {
  test(`full view installed as an app (${orientation}): the bar is on top and stays there`, async ({ app, mock }) => {
    // standalone.css moves the switch below the panels; full view puts it back on top.
    await app.page.setViewportSize(size);
    await translated(app, mock);
    expect(await emulateStandalone(app)).toBeGreaterThanOrEqual(3);
    await expect(app.page.locator(".site-header")).toHaveCSS("order", "1");
    // Full view opens where the pane was, which the stream left at its end.
    await app.page.locator("#output-area").evaluate((el) => (el.scrollTop = 0));
    await openOutput(app).click();
    await expect(exit(app)).toBeVisible();
    const barBox = async () => (await app.page.locator(".pane-bar").boundingBox())!;
    const output = (await app.output.boundingBox())!;
    expect((await barBox()).y).toBeLessThan(output.y);
    await app.page.mouse.wheel(0, 3000);
    await expect.poll(() => app.page.evaluate(() => scrollY)).toBeGreaterThan(1000);
    expect((await barBox()).y).toBeLessThanOrEqual(1);
  });
}
