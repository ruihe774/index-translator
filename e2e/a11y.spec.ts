// Accessibility checks that need a rendered page: axe-core, reflow, text spacing, keyboard order.
// The acceptance record is A11Y-ACCEPTANCE.md.

import AxeBuilder from "@axe-core/playwright";
import { expect, THINK, test } from "./fixtures";

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
    await expect(app.meta).toContainText("generated");
    // Buttons fade their background; axe would read the blended colours mid-transition.
    await app.page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
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
  const overflow = await app.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
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
      .filter(
        (el) =>
          el.offsetParent &&
          !el.closest(".sr-only") &&
          el.scrollWidth > el.clientWidth + 1 &&
          getComputedStyle(el).overflow !== "visible",
      )
      .map((el) => el.id || el.textContent),
  );
  expect(clipped).toEqual([]);
});

test("skip link is first in the tab order and the whole form is reachable in reading order", async ({ app }) => {
  await app.open();
  const names: string[] = [];
  for (let i = 0; i < 14; i++) {
    await app.page.keyboard.press("Tab");
    names.push(
      await app.page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim() || ""),
    );
  }
  expect(names.slice(0, 8)).toEqual([
    "Skip to main content",
    "engine",
    "from",
    "Raw",
    "Preview",
    "text",
    "clear",
    "translate",
  ]);
});

test("every control keeps a visible focus outline", async ({ app }) => {
  await app.open();
  for (const el of [app.from, app.text, app.translate, app.to]) {
    await el.focus();
    expect(
      await el.evaluate(
        (n) => getComputedStyle(n).outlineStyle !== "none" && parseFloat(getComputedStyle(n).outlineWidth) >= 2,
      ),
    ).toBe(true);
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

for (const scheme of ["light", "dark"] as const) {
  test(`placeholder text has 4.5:1 contrast in ${scheme} mode`, async ({ app }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await app.open();
    await app.openAdvanced();
    const ratios = await app.page.evaluate(() => {
      const lum = (c: string) => {
        const [r, g, b] = c
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map((v) => {
            const x = Number(v) / 255;
            return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      return ["text", "glossary", "hard", "soft"].map((id) => {
        const el = document.getElementById(id)!;
        const a = lum(getComputedStyle(el, "::placeholder").color);
        const b = lum(getComputedStyle(el).backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    });
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
  });
}

const LINK_SOURCE = "[A](https://a.example)\n\n[B](https://b.example)\n\n[C](https://c.example)";
const LINK_OUTPUT = "[甲](https://a.example)\n\n[乙](https://a.example)\n\n[丙](https://evil.example)";

for (const scheme of ["light", "dark"] as const) {
  test(`marked links and the link dialog pass axe in ${scheme} mode`, async ({ app, mock }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await mock.set({ chunks: [LINK_OUTPUT] });
    await app.open();
    await app.text.fill(LINK_SOURCE);
    await app.translate.click();
    await expect(app.meta).toContainText("generated");
    await app.page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));

    // Paired, mismatched (marked) and missing (disabled) links are all present.
    await expect(app.output.locator("a[data-link-paired]")).toHaveCount(1);
    await expect(app.output.locator('a[data-link-problem="mismatch"]')).toHaveCount(1);
    await expect(app.output.locator('a[data-link-problem="missing"][aria-disabled="true"]')).toHaveCount(1);
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);

    for (const name of ["甲", "乙"]) {
      await app.output.getByRole("link", { name }).click();
      await expect(app.page.locator("dialog.link-dialog")).toBeVisible();
      results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);
      await app.page.keyboard.press("Escape");
    }
  });
}

test("the link dialog is keyboard operable: focus moves in, stays in, Esc closes and focus returns", async ({
  app,
  mock,
}) => {
  await mock.set({ chunks: [LINK_OUTPUT] });
  await app.open();
  await app.text.fill(LINK_SOURCE);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  const link = app.output.getByRole("link", { name: "乙" });
  await link.focus();
  await app.page.keyboard.press("Enter");
  const dialog = app.page.locator("dialog.link-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-labelledby", "link-dialog-title");
  await expect(dialog).toHaveAccessibleDescription(/could not be matched/);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  for (let i = 0; i < 4; i++) {
    await app.page.keyboard.press("Tab");
    // The page behind is inert: focus is in the dialog or has left the document (browser chrome).
    expect(
      await app.page.evaluate(
        () => document.activeElement === document.body || !!document.activeElement?.closest("dialog"),
      ),
    ).toBe(true);
  }
  await app.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(link).toBeFocused();
});

test("the link dialog needs no horizontal scrolling at 320 px and its buttons are 44 px", async ({ app, mock }) => {
  await mock.set({ chunks: [LINK_OUTPUT] });
  await app.page.setViewportSize({ width: 320, height: 640 });
  await app.open();
  await app.text.fill(LINK_SOURCE);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await app.output.getByRole("link", { name: "乙" }).click();
  const dialog = app.page.locator("dialog.link-dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  for (const b of await dialog.getByRole("button").all()) {
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});

test("the Model switch buttons report their state and are reachable by keyboard", async ({ app }) => {
  await app.open();
  await app.model("Automatic").focus();
  await app.page.keyboard.press("Tab");
  await app.page.keyboard.press("Enter");
  await expect(app.model("Index-Translate-9B")).toHaveAttribute("aria-pressed", "true");
  await app.page.keyboard.press("Tab");
  await app.page.keyboard.press("Space");
  await expect(app.model("Index-NativeLong-9B")).toHaveAttribute("aria-pressed", "true");
});
