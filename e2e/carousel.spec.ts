// One column: the two panels side by side in a row that scrolls sideways (pane-carousel.ts), the
// Source / Translation switch under it, and the panel coming in scrolled to what the other showed.

import { type AppPage, expect, test, THINK } from "./fixtures";

const PHONE = { width: 360, height: 740 };

const row = (app: AppPage) => app.page.locator("#workspace");
const paneSwitch = (app: AppPage) => app.page.getByRole("group", { name: "Shown panel" });

/** Whether the row rests with the panel of `side` in view. */
async function resting(app: AppPage, side: "source" | "output") {
  await expect
    .poll(() =>
      row(app).evaluate((el, side) => {
        const panel = el.querySelector(side === "source" ? ".panel.source" : ".panel.result")!.getBoundingClientRect();
        // At the end of its scroll (Firefox's smooth scroll ignores a click on its last pixels).
        const end = side === "source" ? 0 : el.scrollWidth - el.clientWidth;
        return panel.left >= 0 && panel.right <= innerWidth && Math.abs(el.scrollLeft - end) < 0.5;
      }, side),
    )
    .toBe(true);
}

test("one column: the panels sit side by side, the switch shows the one in view, two columns hide it", async ({
  app,
}) => {
  await app.page.setViewportSize(PHONE);
  await app.open();
  expect(await app.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  const source = (await app.text.boundingBox())!;
  const output = (await app.page.locator("#output-area").boundingBox())!;
  expect(Math.abs(source.y - output.y)).toBeLessThan(1);
  expect(output.x).toBeGreaterThan(PHONE.width - 32);
  await resting(app, "source");
  const buttons = paneSwitch(app).getByRole("button");
  await expect(buttons).toHaveText(["Source text", "Translation"]);
  await expect(buttons.first()).toHaveAttribute("aria-pressed", "true");
  for (const b of await buttons.all()) {
    const size = (await b.boundingBox())!;
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(24);
  }

  await app.page.setViewportSize({ width: 1280, height: 800 });
  await expect(paneSwitch(app)).toBeHidden();
});

test("Translate brings the translation in; the switch goes back and forth and keeps focus", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "你好"] });
  await app.page.setViewportSize(PHONE);
  await app.open();
  await app.text.fill("Hello");
  await app.translate.click();
  await resting(app, "output");
  await expect(app.output).toHaveText("你好");
  const [toSource, toOutput] = await paneSwitch(app).getByRole("button").all();
  await expect(toOutput!).toHaveAttribute("aria-pressed", "true");

  await toSource!.focus();
  await app.page.keyboard.press("Enter");
  await resting(app, "source");
  await expect(toSource!).toHaveAttribute("aria-pressed", "true");
  await expect(toSource!).toBeFocused();

  // Tabbing into the other panel brings it in too.
  await app.to.focus();
  await resting(app, "output");
  await expect(toOutput!).toHaveAttribute("aria-pressed", "true");
});

test("an error brings the translation's status line into view", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "一", "二", "三"], delayMs: 800, failWith: "boom" });
  await app.page.setViewportSize(PHONE);
  await app.open();
  await app.text.fill("Hello");
  await app.translate.click();
  await resting(app, "output");
  await paneSwitch(app).getByRole("button", { name: "Source" }).click();
  await resting(app, "source");
  await expect(app.meta).toHaveAttribute("role", "alert");
  await resting(app, "output");
});

test("the panel coming in shows the counterpart of what the other one showed", async ({ app, mock }) => {
  const source = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
  const translation = Array.from({ length: 200 }, (_, i) => `第${i}行`).join("\n");
  await mock.set({ chunks: [THINK, translation] });
  await app.page.setViewportSize(PHONE);
  await app.open();
  await app.text.fill(source);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await expect(app.page.locator("#output-area")).toHaveClass(/synced/);
  await resting(app, "output");

  // Line 60 of the translation at the top of its pane; the source comes in at line 60, already
  // there while the row is still moving.
  await app.page
    .locator("#output-area")
    .evaluate(
      (area) =>
        (area.scrollTop +=
          area.querySelector('[data-line="60"]')!.getBoundingClientRect().top - area.getBoundingClientRect().top),
    );
  await row(app).evaluate((el) => {
    const w = window as { midway?: number[] };
    w.midway = [];
    el.addEventListener("scroll", () => {
      w.midway!.push(document.querySelector("textarea")!.scrollTop);
    });
  });
  await paneSwitch(app).getByRole("button", { name: "Source" }).click();
  await resting(app, "source");
  const { inTextarea, midway } = await app.text.evaluate((t) => {
    const style = getComputedStyle(t);
    const lineTop = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) + 60 * parseFloat(style.lineHeight);
    return { inTextarea: lineTop - t.scrollTop, midway: (window as { midway?: number[] }).midway! };
  });
  // The lines are short and do not wrap; sub-pixel line heights add up over 60 lines.
  expect(Math.abs(inTextarea)).toBeLessThan(4);
  expect(midway.length).toBeGreaterThan(1);
  // Firefox reports a pixel or two of movement (inside the carousel's tolerance) before the sync; drop those.
  expect(new Set(midway.slice(2)).size).toBe(1);

  // And back: the source at line 20 brings the translation in at line 20.
  await app.text.evaluate((t) => {
    const style = getComputedStyle(t);
    t.scrollTop = parseFloat(style.paddingTop) + 20 * parseFloat(style.lineHeight);
  });
  await paneSwitch(app).getByRole("button", { name: "Translation" }).click();
  await resting(app, "output");
  const offset = await app.page.evaluate(
    () =>
      document.querySelector('#output [data-line="20"]')!.getBoundingClientRect().top -
      document.querySelector("#output-area")!.getBoundingClientRect().top,
  );
  expect(Math.abs(offset)).toBeLessThan(4);
});

test("one column: the translation panel has its own Stop in Copy's place, two columns keep Copy", async ({
  app,
  mock,
}) => {
  await mock.set({ chunks: [THINK, "一", "二", "三"], delayMs: 500 });
  await app.page.setViewportSize(PHONE);
  await app.open();
  const stop = app.page.locator("#stop-output");
  await expect(stop).toBeHidden();
  await expect(app.copy).toBeVisible();
  await app.text.fill("Hello");
  await app.translate.click();
  await resting(app, "output");
  await expect(stop).toBeVisible();
  await expect(app.copy).toBeHidden();
  await expect(stop).toBeFocused();
  await stop.click();
  await expect(app.meta).toHaveText(/stopped/i);
  await expect(stop).toBeHidden();
  await expect(app.copy).toBeVisible();

  await app.page.setViewportSize({ width: 1280, height: 800 });
  await app.text.fill("Hello again");
  await app.translate.click();
  await expect(app.page.locator("#stop")).toBeVisible();
  await expect(stop).toBeHidden();
  await expect(app.copy).toBeVisible();
});
