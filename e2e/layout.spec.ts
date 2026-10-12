// Layout and wording of the page: aligned panes, no shift between views, status text at the bottom,
// placeholders instead of labels and hints, the Model switch and the engine link.

import { type AppPage, expect, THINK, test } from "./fixtures";

const MARKDOWN = "# Title\n\nSome **bold** text.\n\n- one\n- two\n";

async function box(app: AppPage, selector: string) {
  const b = await app.page.locator(selector).boundingBox();
  expect(b, selector).not.toBeNull();
  return b!;
}

test("source and translation areas line up, before and after a translation", async ({ app, mock }) => {
  await app.page.setViewportSize({ width: 1280, height: 900 });
  await mock.set({ chunks: [THINK, "你好"] });
  await app.open();
  const idle = { source: await box(app, "#text"), output: await box(app, "#output-area") };
  expect(idle.source.y).toBe(idle.output.y);
  expect(idle.source.height).toBe(idle.output.height);

  await app.text.fill("Hello, world");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  const done = { source: await box(app, "#text"), output: await box(app, "#output-area") };
  expect(done.source).toEqual(idle.source);
  expect(done.output).toEqual(idle.output);
});

test("long text and a long translation do not change the pane size", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "译文\n\n".repeat(200)] });
  await app.open();
  const before = await box(app, "#text");
  await app.text.fill("line\n\n".repeat(200));
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  const after = await box(app, "#text");
  expect({ ...after, y: 0 }).toEqual({ ...before, y: 0 }); // the page may scroll, the size must not change
  expect((await box(app, "#output-area")).height).toBe(before.height);
});

test("Raw and Preview of the source, and of the translation, have one size and position", async ({ app, mock }) => {
  await app.page.setViewportSize({ width: 1280, height: 900 });
  await mock.set({ chunks: [THINK, "# 标题\n\n一些**粗体**文字。\n\n- 一\n- 二\n"] });
  await app.open();
  await app.text.fill(MARKDOWN);
  const raw = await box(app, "#text");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  expect(await box(app, "#source-area")).toEqual(raw);
  const outputPreview = await box(app, "#output-area");
  expect(outputPreview).toEqual({ ...outputPreview, y: raw.y, height: raw.height });

  await app.page.locator("#source-switch").getByRole("button", { name: "Raw" }).click();
  await expect(app.text).toBeVisible();
  expect(await box(app, "#text")).toEqual(raw);
  await app.page.locator("#output-switch").getByRole("button", { name: "Raw" }).click();
  expect(await box(app, "#output-area")).toEqual(outputPreview);
});

test("the text box cannot be resized", async ({ app }) => {
  await app.open();
  expect(await app.text.evaluate((el) => getComputedStyle(el).resize)).toBe("none");
});

test("progress, errors and copy confirmations share the meta line under the translation", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "你好"], delayMs: 300 });
  await app.open();
  await app.text.fill("Hello");
  await app.translate.click();
  const area = await box(app, "#output-area");
  await expect(app.meta).toContainText("Translating with Index-Translate-9B");
  expect((await box(app, "#meta")).y).toBeGreaterThanOrEqual(area.y + area.height);
  await expect(app.meta).toContainText("generated");
  await app.copy.click();
  await expect(app.meta).toHaveText(/copied|Copying failed/);
  expect((await box(app, "#meta")).y).toBeGreaterThanOrEqual(area.y + area.height);
});

test("an error shows in the meta line too", async ({ app, mock }) => {
  await mock.set({ failWith: "boom" });
  await app.open();
  await app.text.fill("Hello");
  await app.translate.click();
  await expect(app.meta).not.toBeEmpty();
  await expect(app.meta).toHaveAttribute("role", "alert");
  const area = await box(app, "#output-area");
  expect((await box(app, "#meta")).y).toBeGreaterThanOrEqual(area.y + area.height);
});

test("the text box and the option boxes carry their instructions as placeholders", async ({ app }) => {
  await app.open();
  await expect(app.text).toHaveAttribute("placeholder", "Text to translate");
  await expect(app.page.getByText("(required)")).toHaveCount(0);
  await expect(app.text).toHaveAttribute("aria-required", "true");

  await app.openAdvanced();
  await expect(app.page.getByLabel("Glossary", { exact: true })).toHaveAttribute(
    "placeholder",
    "One entry per line: source term = target term",
  );
  await expect(app.page.getByLabel("Hard constraints")).toHaveAttribute(
    "placeholder",
    /^One per line, for example keeping placeholders/,
  );
  await expect(app.page.getByLabel("Soft constraints")).toHaveAttribute(
    "placeholder",
    /^One per line, for example tone or register/,
  );
  // The same text is also the accessible description, so it survives typing, and is not shown twice.
  for (const [label, hint] of [
    ["Glossary", "glossary-hint"],
    ["Hard constraints", "hard-hint"],
    ["Soft constraints", "soft-hint"],
  ] as const) {
    const box = app.page.getByLabel(label, { exact: true });
    await expect(box).toHaveAccessibleDescription(
      await box.getAttribute("placeholder").then((p) => new RegExp(`^${p!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)),
    );
    expect(await app.page.locator(`#${hint}`).evaluate((el) => el.classList.contains("sr-only"))).toBe(true);
  }
});

test("Model is a switch on the same line as Model and options", async ({ app }) => {
  await app.open();
  const group = app.page.getByRole("group", { name: "Model" });
  await expect(group.getByRole("button")).toHaveCount(3);
  // innerText is what is rendered: the long names here, the short ones below 32rem.
  const names = () => group.getByRole("button").evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText));
  expect(await names()).toEqual(["Automatic", "Index-Translate-9B", "Index-NativeLong-9B"]);
  await app.page.setViewportSize({ width: 320, height: 700 });
  expect(await names()).toEqual(["Auto", "Index-Translate", "Nailong"]);
  const tops = await group
    .getByRole("button")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expect(group.getByRole("button", { name: "Nailong", exact: true })).toBeVisible();
  await app.page.setViewportSize({ width: 1280, height: 720 });
  await expect(app.page.locator("#selection")).toHaveCount(0);

  const heading = await box(app, "#settings-heading");
  const switchBox = await group.boundingBox();
  expect(Math.abs(heading.y + heading.height / 2 - (switchBox!.y + switchBox!.height / 2))).toBeLessThan(
    heading.height,
  );
  expect(switchBox!.x).toBeGreaterThan(heading.x + heading.width);

  await expect(app.model("Automatic")).toHaveAttribute("aria-pressed", "true");
  await app.model("Index-Translate-9B").click();
  await expect(app.model("Index-Translate-9B")).toHaveAttribute("aria-pressed", "true");
  await expect(app.model("Automatic")).toHaveAttribute("aria-pressed", "false");

  await app.page.reload();
  await expect(app.model("Index-Translate-9B")).toHaveAttribute("aria-pressed", "true");
});

test("the Model switch looks like the Raw / Preview switch", async ({ app }) => {
  await app.open();
  const style = (selector: string) =>
    app.page.locator(selector).evaluate((el) => {
      const b = getComputedStyle(el.querySelector("button[aria-pressed='true']")!);
      return [b.backgroundColor, b.color, b.borderColor, b.fontWeight, b.minHeight];
    });
  // The source switch starts disabled; enable it and keep the pointer off it.
  await app.text.fill("x");
  await app.page.mouse.move(0, 0);
  const model = await style("#model-switch");
  await expect.poll(() => style("#source-switch")).toEqual(model);
});

test("the engine status is a link to the health endpoint, and the footer links are gone", async ({ app }) => {
  await app.open();
  await expect(app.engine).toHaveText("Engine ready, Index-Translate-9B loaded.");
  await expect(app.page.getByRole("link", { name: "Engine ready, Index-Translate-9B loaded." })).toHaveAttribute(
    "href",
    "/api/v1/health",
  );
  await expect(app.page.getByRole("link")).toHaveCount(2); // skip link and the engine link
  await expect(app.page.getByText("API specification")).toHaveCount(0);
  await expect(app.page.getByText("Engine health (JSON)")).toHaveCount(0);
  await expect(app.page.locator("footer")).toHaveCount(0);
  const hrefs = await app.page.getByRole("link").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toEqual(["#main", "/api/v1/health"]);
});

test("a warning shows under the source, a plain choice shows nothing", async ({ app }) => {
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("en");
  await expect(app.advice).toContainText("source and target languages are the same");
  await app.to.selectOption("zh");
  await expect(app.advice).toBeEmpty();
});

const STABLE = ["#text", "#output-area", "#count", "#translate", "#meta", "#settings-heading", "#from", "#to"];

async function layout(app: AppPage, selectors = STABLE) {
  const out: Record<string, unknown> = {};
  for (const s of selectors) out[s] = await box(app, s);
  return out;
}

test("clicking Translate and finishing move nothing", async ({ app, mock }) => {
  await app.page.setViewportSize({ width: 1280, height: 1000 });
  await mock.set({ chunks: [THINK, "你好，世界"], delayMs: 400 });
  await app.open();
  await app.text.fill("Hello, world");
  await expect(app.page.locator("#count")).toHaveText("10 letters"); // the count follows the text after a short delay
  const idle = await layout(app);
  const sizes = ["#clear", "#translate"];
  const buttons = await layout(app, sizes);

  await app.translate.click();
  await expect(app.meta).toContainText("Translating");
  await expect(app.stop).toBeVisible();
  const running = await layout(
    app,
    STABLE.filter((s) => s !== "#meta"),
  );
  for (const [k, v] of Object.entries(running)) expect(v, `while running: ${k}`).toEqual(idle[k]);
  // Stop sits where Clear was, and Translate has not moved.
  expect(await box(app, "#stop")).toEqual(buttons["#clear"]);
  expect(await box(app, "#translate")).toEqual(buttons["#translate"]);

  await expect(app.meta).toContainText("generated");
  await expect(app.copy).toBeVisible();
  await expect(app.page.locator("#output-area")).toHaveClass(/synced/);
  const done = await layout(
    app,
    STABLE.filter((s) => s !== "#meta"),
  );
  for (const [k, v] of Object.entries(done)) expect(v, `when done: ${k}`).toEqual(idle[k]);
  expect(await box(app, "#clear")).toEqual(buttons["#clear"]);
  expect(await box(app, "#translate")).toEqual(buttons["#translate"]);
});

test("Clear and Stop are never shown together", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "一", "二", "三"], delayMs: 500 });
  await app.open();
  const clear = app.page.getByRole("button", { name: "Clear" });
  await expect(clear).toBeVisible();
  await expect(app.stop).toBeHidden();
  await app.text.fill("Hello");
  await app.translate.click();
  await expect(app.stop).toBeVisible();
  await expect(clear).toBeHidden();
  await app.stop.click();
  await expect(app.meta).toHaveText(/stopped/i);
  await expect(clear).toBeVisible();
  await expect(app.stop).toBeHidden();
});

test("the disabled Translate button does not react to hover", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "一", "二"], delayMs: 600 });
  await app.open();
  await app.text.fill("Hello");
  const bg = () => app.translate.evaluate((el) => getComputedStyle(el).backgroundColor);
  await app.translate.click();
  await expect(app.translate).toHaveAttribute("aria-disabled", "true");
  await app.page.mouse.move(0, 0);
  await app.page.waitForTimeout(400); // the colour change is a 0.15 s transition
  const away = await bg();
  await app.translate.hover();
  await app.page.waitForTimeout(400);
  expect(await bg()).toBe(away);
  await expect(app.meta).toContainText("generated");
  await app.page.mouse.move(0, 0);
  await app.page.waitForTimeout(400);
  const enabled = await bg();
  await app.translate.hover();
  await app.page.waitForTimeout(400);
  expect(await bg()).not.toBe(enabled); // an enabled button still reacts
});

test("nested corners are concentric: outer radius = inner radius + padding + border", async ({ app }) => {
  await app.open();
  for (const width of [1280, 360]) {
    await app.page.setViewportSize({ width, height: 800 });
    const r = await app.page.evaluate(() => {
      const px = (v: string) => Number.parseFloat(v);
      const gap = (outer: Element, inner: Element) => {
        const o = outer.getBoundingClientRect();
        const i = inner.getBoundingClientRect();
        return Math.min(i.left - o.left, i.top - o.top, o.right - i.right);
      };
      const rad = (el: Element) => px(getComputedStyle(el).borderTopLeftRadius);
      const panel = document.querySelector(".panel.source")!;
      const pane = document.querySelector("#text")!;
      const settings = document.querySelector(".settings")!;
      const field = settings.querySelector("fieldset, .view-switch button, select")!;
      return {
        panel: [rad(panel), rad(pane), gap(panel, pane)],
        settings: [rad(settings), rad(field), gap(settings, field)],
      };
    });
    // gap() includes the 1px border of the outer box.
    const [outer, inner, g] = r.panel;
    expect(outer, `panel at ${width}px`).toBeCloseTo(inner + g, 0);
    const [so, si, sg] = r.settings;
    expect(so, `settings at ${width}px`).toBeGreaterThanOrEqual(si);
    expect(sg).toBeGreaterThan(0);
  }
});

test("gaps are even: panel padding, the rows, the buttons", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "你好"] });
  await app.open();
  await app.page.setViewportSize({ width: 1280, height: 800 });
  await app.text.fill("Hello");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  const gaps = await app.page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const panel = r(".source");
    const head = r(".source .pane-head");
    const text = r("#text");
    const foot = r(".source .panel-foot");
    const clear = r("#clear");
    const translate = r("#translate");
    return {
      top: head.top - panel.top - 1,
      left: head.left - panel.left - 1,
      headToText: text.top - head.bottom,
      textToFoot: foot.top - text.bottom,
      buttons: translate.left - clear.right,
      right: panel.right - 1 - translate.right,
      bottom: panel.bottom - 1 - translate.bottom,
    };
  });
  const gap = await app.page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  for (const [k, v] of Object.entries(gaps)) expect(Math.abs(v - gap), k).toBeLessThan(1.5);
});

test("a long status line scrolls sideways and stays reachable by keyboard", async ({ app, mock }) => {
  await app.page.setViewportSize({ width: 600, height: 800 });
  await mock.set({ failWith: "boom ".repeat(100) });
  await app.open();
  await app.text.fill("Hello");
  await app.translate.click();
  await expect(app.meta).toContainText("boom boom");
  expect(await app.meta.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await app.meta.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(50);
  await expect(app.meta).toHaveAttribute("tabindex", "0");
});
