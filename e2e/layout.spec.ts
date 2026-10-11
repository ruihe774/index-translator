// Layout and wording of the page: aligned panes, no shift between views, status text at the bottom,
// placeholders instead of labels and hints, the Model switch and the engine link.

import { THINK, expect, test, type AppPage } from "./fixtures";

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
  await expect(app.progress).toHaveText("Done.");
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
  await expect(app.progress).toHaveText("Done.");
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
  await expect(app.progress).toHaveText("Done.");

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

test("status text sits below the translation, with the other status text", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "你好"], delayMs: 300 });
  await app.open();
  await app.text.fill("Hello");
  await app.translate.click();
  const area = await box(app, "#output-area");
  await expect(app.progress).toContainText("Translating with Index-Translate-9B");
  expect((await box(app, "#progress")).y).toBeGreaterThanOrEqual(area.y + area.height);
  await expect(app.progress).toHaveText("Done.");
  expect((await box(app, "#progress")).y).toBeGreaterThanOrEqual(area.y + area.height);
  await app.copy.click();
  await expect(app.progress).toHaveText(/copied|Copying failed/);
  const progress = await box(app, "#progress");
  expect((await box(app, "#meta")).y).toBeGreaterThan(progress.y);
});

test("an error banner is below the translation too", async ({ app, mock }) => {
  await mock.set({ failWith: "boom" });
  await app.open();
  await app.text.fill("Hello");
  await app.translate.click();
  await expect(app.error).not.toBeEmpty();
  const area = await box(app, "#output-area");
  expect((await box(app, "#error")).y).toBeGreaterThanOrEqual(area.y + area.height);
});

test("the text box and the option boxes carry their instructions as placeholders", async ({ app }) => {
  await app.open();
  await expect(app.text).toHaveAttribute("placeholder", "Text to translate");
  await expect(app.page.getByText("(required)")).toHaveCount(0);
  await expect(app.text).toHaveAttribute("aria-required", "true");

  await app.openAdvanced();
  await expect(app.page.getByLabel("Glossary", { exact: true })).toHaveAttribute("placeholder", "One entry per line: source term = target term");
  await expect(app.page.getByLabel("Hard constraints")).toHaveAttribute("placeholder", /^One per line, for example keeping placeholders/);
  await expect(app.page.getByLabel("Soft constraints")).toHaveAttribute("placeholder", /^One per line, for example tone or register/);
  for (const id of ["glossary-hint", "hard-hint", "soft-hint"]) await expect(app.page.locator(`#${id}`)).toHaveCount(0);
});

test("Model is a switch on the same line as Model and options", async ({ app }) => {
  await app.open();
  const group = app.page.getByRole("group", { name: "Model" });
  await expect(group.getByRole("button")).toHaveText(["Automatic", "Index-Translate-9B", "Index-NativeLong-9B"]);
  await expect(app.page.locator("#selection")).toHaveCount(0);

  const heading = await box(app, "#settings-heading");
  const switchBox = await group.boundingBox();
  expect(Math.abs(heading.y + heading.height / 2 - (switchBox!.y + switchBox!.height / 2))).toBeLessThan(heading.height);
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
  await app.page.evaluate(() => document.querySelector("#source-switch")!.removeAttribute("hidden"));
  expect(await style("#model-switch")).toEqual(await style("#source-switch"));
});

test("the engine status is a link to the health endpoint, and the footer links are gone", async ({ app }) => {
  await app.open();
  await expect(app.engine).toHaveText("Engine ready, Index-Translate-9B loaded.");
  await expect(app.page.getByRole("link", { name: "Engine ready, Index-Translate-9B loaded." })).toHaveAttribute("href", "/api/v1/health");
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
