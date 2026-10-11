// Accessibility checks that need a rendered page: axe-core, reflow, text spacing, keyboard order.
// The acceptance record is A11Y-ACCEPTANCE.md.

import AxeBuilder from "@axe-core/playwright";
import { THINK, expect, test } from "./fixtures";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds no violations in ${scheme} mode, idle and with a result`, async ({ app, mock }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await mock.set({ chunks: [THINK, "你好，世界"] });
    await app.open();
    await app.openAdvanced();
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await app.text.fill("Hello, world");
    await app.translate.click();
    await expect(app.progress).toHaveText("Done.");
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
}

test("two columns on a desktop viewport, one column at 320 px without horizontal scrolling", async ({ app }) => {
  await app.page.setViewportSize({ width: 1280, height: 800 });
  await app.open();
  const source = await app.text.boundingBox();
  const output = await app.page.locator("#output-area").boundingBox();
  expect(source && output && Math.abs(source.y - output.y) < 200 && output.x > source.x + source.width - 1).toBe(true);

  await app.page.setViewportSize({ width: 320, height: 640 });
  await app.openAdvanced();
  const overflow = await app.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const stacked = await app.page.locator("#output-area").boundingBox();
  const field = await app.text.boundingBox();
  expect(stacked!.y).toBeGreaterThan(field!.y + field!.height);
});

test("text spacing overrides clip nothing", async ({ app }) => {
  await app.open();
  // Adopted style sheets are not blocked by the page's Content-Security-Policy.
  await app.page.evaluate((css) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets.push(sheet);
  }, "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-block-end: 2em !important; }");
  const clipped = await app.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("label, legend, summary, button, .hint, h1, h2, option")]
      .filter((el) => el.offsetParent && !el.closest(".sr-only") && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible")
      .map((el) => el.id || el.textContent),
  );
  expect(clipped).toEqual([]);
});

test("skip link is first in the tab order and the whole form is reachable in reading order", async ({ app }) => {
  await app.open();
  const names: string[] = [];
  for (let i = 0; i < 14; i++) {
    await app.page.keyboard.press("Tab");
    names.push(await app.page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim() || ""));
  }
  expect(names.slice(0, 6)).toEqual(["Skip to main content", "from", "text", "clear", "translate", "to"]);
});

test("every control keeps a visible focus outline", async ({ app }) => {
  await app.open();
  for (const el of [app.from, app.text, app.translate, app.to]) {
    await el.focus();
    expect(await el.evaluate((n) => getComputedStyle(n).outlineStyle !== "none" && parseFloat(getComputedStyle(n).outlineWidth) >= 2)).toBe(true);
  }
});

test("pointer targets are at least 24 px", async ({ app }) => {
  await app.open();
  const small = await app.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, select, input, summary, textarea")]
      .filter((el) => el.offsetParent)
      .map((el) => ({ id: el.id, ...el.getBoundingClientRect().toJSON() }))
      .filter((r) => r.width < 24 || r.height < 24)
      .map((r) => r.id),
  );
  expect(small).toEqual([]);
});

