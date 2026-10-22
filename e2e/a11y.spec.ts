/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
// Accessibility checks that need a rendered page: axe-core, reflow, text spacing, keyboard order.
// The acceptance record is A11Y-ACCEPTANCE.md.

import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test, THINK } from "./fixtures";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds no violations in ${scheme} mode, idle and with a result`, async ({ app, mock }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await mock.set({ chunks: [THINK, "你好，世界"] });
    await app.open();
    await app.openAdvanced();
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    await app.text.fill("Hello, world");
    await app.translate.click();
    await expect(app.meta).toContainText("generated");
    // Buttons fade their background; axe would read the blended colours mid-transition.
    await app.page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
  });

  test(`the engine bars (VRAM, loading) pass axe in ${scheme} mode and fit 320 px`, async ({ app }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await app.page.setViewportSize({ width: 320, height: 640 });
    let loading = true;
    let freeGiB = 2;
    await app.page.route("**/api/v1/health", async (route) => {
      const real = (await (await route.fetch()).json()) as object;
      await route.fulfill({
        json: loading
          ? { ...real, status: "loading", model: null }
          : { ...real, gpu_memory: { total_bytes: 8 * 1024 ** 3, free_bytes: freeGiB * 1024 ** 3 } },
      });
    });
    await app.page.goto("/");
    await expect(app.engine.locator(".bar.indeterminate")).toHaveCount(1);
    // The bar of the first poll is the one the page started with: its animation never restarts.
    await app.page.evaluate(() => {
      document.querySelector("#engine .bar")!.setAttribute("data-first", "");
    });
    await expect(app.engine).toHaveAttribute("title", "Engine loading a model…");
    await expect(app.engine.locator(".bar[data-first].indeterminate")).toHaveCount(1);
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    loading = false;
    await app.page.reload();
    await expect(app.engine.locator(".bar:not(.indeterminate)")).toHaveCount(1);
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
    expect(await app.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    freeGiB = 0.5;
    await app.page.reload();
    await expect(app.engine.locator(".bar.tight")).toHaveCount(1);
    await expect(app.engine).toHaveAttribute("title", /VRAM 7\.5 \/ 8\.0 GiB, free memory is tight\.$/);
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    // Error, stopped and unreachable are sentences in the warning colour, bold.
    await app.page.unroute("**/api/v1/health");
    await app.page.route("**/api/v1/health", (route) => route.abort());
    await app.page.reload();
    await expect(app.engine).toHaveText("The server cannot be reached.");
    await expect(app.engine).toHaveClass("problem");
    await expect(app.engine).toHaveCSS("font-weight", "700");
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
  });

  test(`an image as the source passes axe in ${scheme} mode and is named for assistive technology`, async ({
    app,
    mock,
  }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await mock.set({ chunks: [THINK, "你好，世界"] });
    await app.open();
    const file = await app.page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 200;
      canvas.getContext("2d")!.fillRect(0, 0, 320, 200);
      return canvas.toDataURL("image/png").split(",")[1]!;
    });
    await app.page
      .locator("#open-file")
      .setInputFiles({ name: "sign.png", mimeType: "image/png", buffer: Buffer.from(file, "base64") });
    const picture = app.page.getByRole("img", { name: "Image to translate: sign.png" });
    await expect(picture).toBeVisible();
    await expect(picture).toHaveAccessibleDescription("sign.png, 320 × 200 pixels");
    await expect(app.page.locator("#file-note")).toHaveAttribute("role", "status");
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    await app.translate.click();
    await expect(app.meta).toContainText("generated");
    await app.page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
    // At 320 px the picture still fits its pane: no horizontal scrolling.
    await app.page.setViewportSize({ width: 320, height: 640 });
    expect(await app.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`reading aloud passes axe in ${scheme} mode, with the controls and read-from buttons out, one block shaded and at 320 px`, async ({
    app,
    mock,
  }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await mock.set({
      chunks: ["# 标题\n\n", "第一段。\n\n", "第二段。\n"],
      speech: { delayMs: 1000, audioSeconds: 5 },
    });
    await app.open();
    await app.openAdvanced();
    await app.from.selectOption("en");
    await app.text.fill("# Title\n\nFirst.\n\nSecond.\n");
    await app.translate.click();
    await expect(app.meta).toContainText("generated");
    const listen = app.page.locator("#listen-output");
    await app.readAloud("output");
    await expect(app.output.locator(".speaking")).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
    await expect(listen).toHaveAttribute("data-state", "playing", { timeout: 10_000 });
    await app.page.locator("#next-output").click();
    await expect(listen).toHaveAttribute("data-state", "playing", { timeout: 10_000 });
    await app.page.locator("#pause-output").click();
    await expect(app.page.locator("#pause-output")).toHaveAccessibleName("Resume reading");
    await app.page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    const results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    // Every speech control is a 44 px target and, like the rest, needs no horizontal scrolling.
    for (const id of ["listen-output", "prev-output", "pause-output", "next-output"]) {
      const box = await app.page.locator(`#${id}`).boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await app.page.setViewportSize({ width: 320, height: 640 });
    expect(
      await app.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
    // The read-from buttons, at the narrowest: at least 24 px each way (2.5.8), apart, and clear of the text.
    const gutter = app.gutter("output");
    await expect(gutter).toHaveCount(3);
    const boxes = await gutter.evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().toJSON() as DOMRect));
    const text = await app.output.locator(":scope > [data-line]").first().boundingBox();
    boxes.forEach((box, i) => {
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
      expect(box.right).toBeLessThanOrEqual(text!.x);
      if (i > 0) {
        expect(box.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom);
      }
    });
    // The block being read has its button filled like the pressed Read aloud (axe checks no icon contrast).
    await app.page.mouse.move(0, 0);
    await app.page.waitForTimeout(300);
    const colours = (el: Element) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color];
    expect(await gutter.and(app.page.locator("[aria-current='true']")).evaluate(colours)).toStrictEqual(
      await listen.evaluate(colours),
    );
    await listen.click();
    await expect(app.page.locator("#pause-output")).toBeHidden();
    await expect(gutter.first()).toBeHidden();
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`the voice-clone group passes axe in ${scheme} mode in its error states`, async ({ app }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await app.page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    await app.open();
    await app.page.getByText("Reading aloud", { exact: true }).click();
    const group = app.page.getByRole("group", { name: "Clone a voice" });
    const status = app.page.locator("#clone-status");
    await expect(group.getByRole("button", { name: "Record" })).toBeVisible();
    await expect(group.getByRole("button", { name: "Upload audio…" })).toBeVisible();

    // Record refused: the reason is in the status line, a live region.
    await group.getByRole("button", { name: "Record" }).click();
    await expect(status).toContainText("Microphone access was denied");
    await app.page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    // Upload refused: a file that is not audio.
    await app.page
      .locator("#voice-file")
      .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("no") });
    await expect(status).not.toContainText("Microphone access was denied");
    await expect(status).toHaveText(/\S/);
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    // The group keeps 44 px targets and fits 320 px with the error showing.
    for (const name of ["Record", "Upload audio…"]) {
      const box = await group.getByRole("button", { name }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await app.page.setViewportSize({ width: 320, height: 640 });
    expect(
      await app.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
  });
}

test("the speech controls are reached in order and focus does not get lost when reading ends", async ({
  app,
  mock,
}) => {
  await mock.set({ speech: { delayMs: 300 } });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill("One.\n\nTwo.");
  await app.previewSource();
  await app.page.locator("#listen-source").focus();
  // Read aloud puts focus in the column of read-from buttons; Enter reads from the first block.
  await app.page.keyboard.press("Enter");
  await expect(app.gutter("source").first()).toBeFocused();
  await app.page.keyboard.press("Enter");
  // The column is one tab stop, before the controls of the panel.
  const order: string[] = [];
  for (let i = 0; i < 5; i++) {
    await app.page.keyboard.press("Tab");
    order.push(await app.page.evaluate(() => document.activeElement?.id ?? ""));
  }
  expect(order).toStrictEqual(["listen-source", "prev-source", "pause-source", "next-source", "clear"]);
  await app.page.keyboard.press("Shift+Tab");
  await app.page.keyboard.press("Shift+Tab");
  await app.page.keyboard.press("Shift+Tab");
  await app.page.keyboard.press("Shift+Tab");
  await app.page.keyboard.press("Shift+Tab");
  await expect(app.gutter("source").first()).toBeFocused();
  // Hidden under focus (the source back in Raw), the column hands focus to Read aloud.
  await app.page.evaluate(() =>
    document.querySelector<HTMLButtonElement>("#source-switch [data-value='raw']")!.click(),
  );
  await expect(app.page.locator("#listen-source")).toBeFocused();
  await app.previewSource();
  await app.readAloud("source");
  await app.page.locator("#pause-source").focus();
  await expect(app.page.locator("#listen-source")).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  expect(await app.page.evaluate(() => document.activeElement?.id)).toBe("listen-source");
});

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
  expect(clipped).toStrictEqual([]);
});

test("under text spacing overrides the read-from buttons stay beside their blocks", async ({ app }) => {
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(
    "# Title\n\nA paragraph long enough to wrap onto more than one line in the pane, and then some more.\n\nEnd.\n",
  );
  await app.previewSource();
  await app.page.locator("#listen-source").click();
  await expect(app.gutter("source")).toHaveCount(3);
  await app.page.evaluate((css) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets.push(sheet);
  }, "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-block-end: 2em !important; }");
  const blocks = app.page.locator("#source-view > [data-line]");
  for (let i = 0; i < 3; i++) {
    await expect
      .poll(async () => {
        const button = (await app.gutter("source").nth(i).boundingBox())!;
        const block = (await blocks.nth(i).boundingBox())!;
        return Math.abs(button.y - block.y) < 2 && Math.abs(button.height - block.height) < 2;
      })
      .toBe(true);
  }
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
  expect(names.slice(0, 10)).toStrictEqual([
    "Skip to main content",
    "engine",
    "from",
    "open",
    "Raw",
    "Preview",
    "text",
    "listen-source",
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
  expect(small).toStrictEqual([]);
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
    for (const r of ratios) {
      expect(r).toBeGreaterThanOrEqual(4.5);
    }
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
    expect(results.violations).toStrictEqual([]);

    for (const name of ["甲", "乙"]) {
      await app.output.getByRole("link", { name }).click();
      await expect(app.page.locator("dialog.link-dialog")).toBeVisible();
      results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toStrictEqual([]);
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

// A web address alone in the box: the same dialog asks whether to fetch the page (e2e/webpage.spec.ts).

const WEBPAGE_DIALOG = (page: Page) => page.getByRole("dialog", { name: "Fetch this web page?" });

for (const scheme of ["light", "dark"] as const) {
  test(`the fetch-a-page dialog, the fetch and the fetched page pass axe in ${scheme} mode`, async ({ app, mock }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await mock.set({ webpage: { delayMs: 500 } });
    await app.open();
    await expect(app.engine).toContainText("Engine ready");
    await app.text.fill("example.com/post");
    await app.translate.click();
    await expect(WEBPAGE_DIALOG(app.page)).toBeVisible();
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    await WEBPAGE_DIALOG(app.page).getByRole("button", { name: "Fetch page" }).click();
    await expect(app.page.locator("#count")).toHaveText("Fetching the page…");
    await expect(app.page.locator("#source-status")).toHaveText("Fetching the page…");
    await expect(app.page.locator("#source-status")).toHaveAttribute("role", "status");
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    await expect(app.page.locator("#source-status")).toContainText("Fetched");
    await app.page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`the typed translation box and the Match dialog pass axe in ${scheme} mode`, async ({ app }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await app.open();
    await expect(app.engine).toContainText("Engine ready");
    await SWITCH(app.page, "Translation view", "Raw").click();
    const target = app.page.getByRole("textbox", { name: /Translation, to match/ });
    await expect(target).toBeVisible();
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    await app.text.fill("One.\n\nTwo.");
    await target.fill("Un.\n\nDeux.");
    await app.page.getByRole("button", { name: "Match", exact: true }).click();
    const dialog = app.page.getByRole("dialog", { name: "Match the two texts?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button")).toHaveText(["Cancel", "Clear output and translate", "Match"]);
    await expect(dialog.getByRole("button").first()).toBeFocused();
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
    await app.page.keyboard.press("Escape");
    await expect(app.page.getByRole("button", { name: "Match", exact: true })).toBeFocused();
  });
}

test("the fetch-a-page dialog is keyboard operable: Cancel first, focus stays in, Esc returns it to Translate", async ({
  app,
}) => {
  await app.open();
  await expect(app.engine).toContainText("Engine ready");
  await app.text.fill("https://example.com/");
  await app.translate.focus();
  await app.page.keyboard.press("Enter");
  const dialog = WEBPAGE_DIALOG(app.page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(/The text is a web address/);
  const buttons = dialog.getByRole("button");
  await expect(buttons).toHaveText(["Cancel", "Translate as text", "Fetch page"]);
  await expect(buttons.first()).toBeFocused();
  for (let i = 0; i < 5; i++) {
    await app.page.keyboard.press("Tab");
    expect(
      await app.page.evaluate(
        () => document.activeElement === document.body || !!document.activeElement?.closest("dialog"),
      ),
    ).toBe(true);
  }
  await app.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(app.translate).toBeFocused();

  // Fetching by keyboard: focus goes to Stop while it runs, to Translate when the page is in.
  await app.page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Fetch page" }).focus();
  await app.page.keyboard.press("Enter");
  await expect(app.page.locator("#source-status")).toContainText("Fetched");
  await expect(app.translate).toBeFocused();
});

test("the fetch-a-page dialog needs no horizontal scrolling at 320 px and its buttons are 44 px", async ({ app }) => {
  await app.page.setViewportSize({ width: 320, height: 640 });
  await app.open();
  await expect(app.engine).toContainText("Engine ready");
  await app.text.fill(`https://www.example.com/${"a-long-path-segment/".repeat(6)}`);
  await app.translate.click();
  const dialog = WEBPAGE_DIALOG(app.page);
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(await dialog.evaluate((d) => d.scrollWidth - d.clientWidth)).toBeLessThanOrEqual(0);
  for (const b of await dialog.getByRole("button").all()) {
    const size = (await b.boundingBox())!;
    expect(size.height).toBeGreaterThanOrEqual(44);
    expect(size.x + size.width).toBeLessThanOrEqual(box!.x + box!.width);
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

// Views, Markdown output, Clear, click-to-sync, Open and the PDF strip, opening notes, History.

const SWITCH = (page: Page, group: string, name: string) =>
  page.getByRole("group", { name: group }).getByRole("button", { name, exact: true });

// Waits for the button fades axe would read mid-blend, but not for endless ones (a spinner).
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity),
  );

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const COLUMNS = Array.from({ length: 12 }, (_, i) => `column${i}`);
const TABLE = `| ${COLUMNS.join(" | ")} |\n| ${COLUMNS.map(() => "-").join(" | ")} |\n| ${COLUMNS.map((_, i) => i).join(" | ")} |`;
const MD_SOURCE = [
  "# Title",
  "A paragraph with *emphasis*, `code` and [a link](https://a.example).",
  "- [x] done\n- [ ] todo",
  "> quoted text",
  TABLE,
  `\`\`\`\n${"x".repeat(300)}\n\`\`\``,
].join("\n\n");
const MD_OUTPUT = [
  "# 标题",
  "一段带有*强调*、`code`和[链接](https://a.example)的文字。",
  "- [x] 完成\n- [ ] 待办",
  "> 引用的文字",
  TABLE,
  `\`\`\`\n${"y".repeat(300)}\n\`\`\``,
].join("\n\n");

for (const scheme of ["light", "dark"] as const) {
  test(`rendered Markdown, both views and click-to-sync pass axe in ${scheme} mode`, async ({ app, mock }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await mock.set({ chunks: [MD_OUTPUT] });
    await app.open();
    await app.from.selectOption("en");
    await app.to.selectOption("zh");
    await app.text.fill(MD_SOURCE);
    await app.translate.click();
    await expect(app.meta).toContainText("generated");
    await settle(app.page);

    // Both sides rendered; each carries the language of its text.
    await expect(app.page.locator("#source-view")).toBeVisible();
    await expect(app.page.locator("#source-view")).toHaveAttribute("lang", "en");
    await expect(app.output).toHaveAttribute("lang", "zh");
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    // Click-to-sync is on and its hover shade (a source block's counterpart in the translation) passes too.
    await expect(app.page.locator("#output-area")).toHaveClass(/synced/);
    await app.page.locator("#source-view blockquote").hover();
    await expect(app.output.locator(".linked")).toHaveCount(1);
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
    await app.page.mouse.move(0, 0);

    // Raw on both sides.
    await SWITCH(app.page, "Source view", "Raw").click();
    await SWITCH(app.page, "Translation view", "Raw").click();
    await settle(app.page);
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`paragraphs matched by the aligner: the detailed note is in a live list, the group shade and axe pass in ${scheme} mode`, async ({
    app,
    mock,
  }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    // Eight paragraphs; the translation merged the second and third.
    await mock.set({
      chunks: ["Un.\n\n", "Deux. Trois.\n\n", "Quatre.\n\n", "Cinq.\n\n", "Six.\n\n", "Sept.\n\n", "Huit.\n"],
      align: {
        pairs: [
          { source: [0], target: [0], similarity: 0.9 },
          { source: [1, 2], target: [1], similarity: 0.9 },
          ...[3, 4, 5, 6, 7].map((k) => ({ source: [k], target: [k - 1], similarity: 0.9 })),
        ],
      },
    });
    await app.open();
    await app.from.selectOption("en");
    await app.to.selectOption("fr");
    await app.text.fill("# One\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\nSix.\n\nSeven.\n\nEight.\n");
    await app.translate.click();
    await expect(app.meta).toContainText("generated");
    await expect(app.page.locator("#notes")).toHaveAttribute("aria-live", "polite");
    await expect(app.notes.first()).toHaveText(
      "The source has 8 paragraphs and the translation has 7. Paragraphs 2–3 of the source match only paragraph 2 of the translation: merged, or one is missing. Check it against the source.",
    );
    await expect(app.page.locator("#output-area")).toHaveClass(/synced/);
    await settle(app.page);
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    // The merged paragraph's counterpart is both source paragraphs, shaded with the same rule.
    await app.output.locator("p").nth(1).hover();
    await expect(app.page.locator("#source-view .linked")).toHaveCount(2);
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
    await app.page.mouse.move(0, 0);
  });
}

test("rendered Markdown: wide tables and code blocks are reachable by keyboard, nothing overflows at 320 px", async ({
  app,
  mock,
}) => {
  await mock.set({ chunks: [MD_OUTPUT] });
  await app.page.setViewportSize({ width: 320, height: 640 });
  await app.open();
  await app.from.selectOption("en");
  await app.text.fill(MD_SOURCE);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  expect(await overflow(app.page)).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toStrictEqual([]);
  // Every horizontally scrolling region inside the two views is focusable (2.1.1) or holds a focusable element.
  const unreachable = await app.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#output *, #source-view *")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX))
      .filter((el) => el.tabIndex < 0 && !el.querySelector("a[href], button, input, select, textarea, [tabindex]"))
      .map((el) => `${el.tagName}.${el.className}`),
  );
  expect(unreachable).toStrictEqual([]);
});

test("a pane with more text than room is focusable, scrolls by keyboard, and others add no tab stop", async ({
  app,
  mock,
}) => {
  const lines = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n");
  await mock.set({ chunks: [THINK, lines] });
  await app.open();
  const area = app.page.locator("#output-area");
  await expect(area).not.toHaveAttribute("tabindex", /.*/);
  await app.text.fill("Short");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await expect(area).toHaveAttribute("tabindex", "0");
  await expect(area).toHaveAccessibleName("Translation text");
  await area.focus();
  await app.page.keyboard.press("PageDown");
  expect(await area.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // The source box (a short text) is no tab stop of this kind.
  await expect(app.page.locator("#source-area")).not.toHaveAttribute("tabindex", /.*/);
  // A short translation takes it away again.
  await mock.set({ chunks: [THINK, "短"] });
  await app.translate.click();
  await expect(app.output).toHaveText("短");
  await expect(area).not.toHaveAttribute("tabindex", /.*/);
});

test("the Raw/Preview switches: disabled without text, pressed state, keyboard, focus stays, 44 px", async ({
  app,
}) => {
  await app.open();
  const raw = SWITCH(app.page, "Source view", "Raw");
  const preview = SWITCH(app.page, "Source view", "Preview");
  for (const b of [raw, preview]) {
    await expect(b).toHaveAttribute("aria-disabled", "true");
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  // The translation switch is enabled from the start: Raw is the box to type a translation in.
  for (const name of ["Raw", "Preview"]) {
    await expect(SWITCH(app.page, "Translation view", name)).toHaveAttribute("aria-disabled", "false");
  }
  // Pressing a disabled switch changes nothing.
  await preview.click({ force: true });
  await expect(raw).toHaveAttribute("aria-pressed", "true");

  await app.text.fill("# Title\n\nSome *Markdown*.");
  await expect(preview).toHaveAttribute("aria-disabled", "false");
  await preview.focus();
  await app.page.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("aria-pressed", "true");
  await expect(raw).toHaveAttribute("aria-pressed", "false");
  await expect(app.page.locator("#text")).toBeHidden();
  await expect(app.page.locator("#source-view").getByRole("heading", { name: "Title" })).toBeVisible();
  // The control that was used keeps focus although the box it switched has gone.
  await expect(preview).toBeFocused();
  await raw.focus();
  await app.page.keyboard.press("Space");
  await expect(app.text).toBeVisible();
  await expect(raw).toBeFocused();
});

test("Clear: aria-disabled when idle, keyboard operable, focus goes to the emptied box", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "你好"] });
  await app.open();
  const clear = app.page.locator("#clear");
  await expect(clear).toHaveAttribute("aria-disabled", "true");
  await clear.focus();
  await expect(clear).toBeFocused(); // still focusable, like Translate
  expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await app.text.fill("Hello");
  await app.translate.click();
  await expect(app.output).toHaveText("你好");
  await expect(clear).toHaveAttribute("aria-disabled", "false");
  await clear.focus();
  await app.page.keyboard.press("Enter");
  await expect(app.text).toHaveValue("");
  await expect(app.text).toBeFocused();
  await expect(app.output).toHaveText("");
  await expect(clear).toHaveAttribute("aria-disabled", "true");
  await expect(app.copy).toHaveAttribute("aria-disabled", "true");
  await expect(SWITCH(app.page, "Source view", "Preview")).toHaveAttribute("aria-disabled", "true");
});

test("Open and the PDF strip: names, keyboard, focus, Close, targets and axe", async ({ app }) => {
  await app.open();
  const open = app.page.locator("#open");
  await expect(open).toHaveAccessibleName("Open a file");
  await app.page.locator("#open-file").setInputFiles(`${import.meta.dirname}/../test/fixtures/sample.pdf`);
  const note = app.page.locator("#file-note");
  await expect(note).toHaveText(/sample\.pdf: 3 pages/);
  await expect(note).toHaveAttribute("role", "status");
  // The visible word is part of the name (2.5.3) and the name says what is closed.
  await expect(open).toHaveText("Close");
  await expect(open).toHaveAccessibleName("Close the PDF");
  const pages = app.page.locator("#pdf-pages button[data-page]");
  await expect(pages).toHaveCount(3);
  await expect(app.page.locator("#pdf-pages canvas[data-drawn]")).toHaveCount(3);
  for (let n = 1; n <= 3; n++) {
    await expect(pages.nth(n - 1)).toHaveAccessibleName(`Page ${n}`);
    const box = (await pages.nth(n - 1).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  // By keyboard: Enter on a page puts its text in the box and marks it as the current page.
  await pages.nth(0).focus();
  await app.page.keyboard.press("Enter");
  await expect(pages.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(note).toContainText("page 1");
  await expect(pages.nth(0)).toBeFocused();
  for (const scheme of ["light", "dark"] as const) {
    await app.page.emulateMedia({ colorScheme: scheme });
    await settle(app.page);
    const results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
  }

  // Page 3 comes with a warning (undecodable text): the warning style passes in both schemes.
  await pages.nth(2).focus();
  await app.page.keyboard.press("Enter");
  await expect(note).toHaveClass(/advice/);
  for (const scheme of ["light", "dark"] as const) {
    await app.page.emulateMedia({ colorScheme: scheme });
    await settle(app.page);
    const results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
  }

  await app.page.setViewportSize({ width: 320, height: 640 });
  expect(await overflow(app.page)).toBeLessThanOrEqual(0);

  // Close puts the PDF away; the button keeps focus and is named Open again.
  await open.focus();
  await app.page.keyboard.press("Enter");
  await expect(app.page.locator("#pdf-pages")).toBeHidden();
  await expect(open).toHaveAccessibleName("Open a file");
  await expect(open).toBeFocused();
  await expect(note).toBeHidden();
});

for (const scheme of ["light", "dark"] as const) {
  test(`the opening notes (error, Word document) pass axe in ${scheme} mode`, async ({ app }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await app.open();
    const note = app.page.locator("#file-note");
    await app.page
      .locator("#open-file")
      .setInputFiles({ name: "gbk.txt", mimeType: "", buffer: Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) });
    await expect(note).toHaveClass(/error/);
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    await app.page.locator("#open-file").setInputFiles(`${import.meta.dirname}/../test/fixtures/sample.docx`);
    await expect(note).toContainText("sample.docx");
    await expect(app.page.locator("#source-view")).toBeVisible();
    await settle(app.page);
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);
  });

  test(`the History panel passes axe in ${scheme} mode, with entries and paused`, async ({ app, mock }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await mock.set({ chunks: [THINK, "你好，世界"] });
    await app.open();
    await app.text.fill("Hello, world");
    await app.translate.click();
    await expect(app.page.locator("#history-list li")).toHaveCount(1);
    await settle(app.page);
    let results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    // Each action link is at least 24 px (2.5.8) and shows a focus outline.
    for (const link of await app.page.locator("#history-list a").all()) {
      const box = (await link.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
      await link.focus();
      expect(await link.evaluate((n) => parseFloat(getComputedStyle(n).outlineWidth))).toBeGreaterThanOrEqual(2);
    }

    await app.page.locator("#history-pause").click();
    await expect(app.page.locator("#history-pause")).toHaveAccessibleName("Resume history");
    await settle(app.page);
    results = await new AxeBuilder({ page: app.page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toStrictEqual([]);

    await app.page.setViewportSize({ width: 320, height: 640 });
    expect(await overflow(app.page)).toBeLessThanOrEqual(0);
  });
}
