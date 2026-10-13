// The History panel: finished translations kept in the browser, never sent to the server.

import { expect, test, THINK } from "./fixtures";

test("a finished translation is listed, survives a reload and can be restored", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "你好，世界"] });
  await app.open();
  await expect(app.page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(app.page.locator("#history-empty")).toBeVisible();

  await app.text.fill("Hello, world");
  await app.translate.click();
  await expect(app.output).toHaveText("你好，世界");

  const items = app.page.locator("#history-list li");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Hello, world");
  await expect(items.first()).toContainText("→");

  await app.page.reload();
  await expect(app.from.locator("option")).not.toHaveCount(0);
  await expect(items).toHaveCount(1);
  await expect(app.text).toHaveValue("");

  const requestsBefore = (await mock.state()).requests.length;
  await app.page.getByRole("link", { name: /^Restore translation/ }).click();
  await expect(app.text).toHaveValue("Hello, world");
  await expect(app.output).toHaveText("你好，世界");
  await expect(app.meta).toContainText("Restored from the history");
  expect((await mock.state()).requests).toHaveLength(requestsBefore);
});

test("entries can be deleted one by one and all at once", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "一"] });
  await app.open();
  for (const text of ["first", "second"]) {
    await app.text.fill(text);
    await app.translate.click();
    await expect(app.output).toHaveText("一");
    await expect(app.translate).toHaveAttribute("aria-disabled", "false");
  }
  const items = app.page.locator("#history-list li");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("second");

  await items
    .first()
    .getByRole("link", { name: /^Delete/ })
    .click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("first");

  await app.page.getByRole("button", { name: "Clear history" }).click();
  await expect(items).toHaveCount(0);
  await expect(app.page.locator("#history-empty")).toBeVisible();
  await app.page.reload();
  await expect(app.page.locator("#history-empty")).toBeVisible();
});

test("pausing the history keeps what is there and records nothing new, also after a reload", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "一"] });
  await app.open();
  await app.text.fill("before");
  await app.translate.click();
  await expect(app.output).toHaveText("一");
  const items = app.page.locator("#history-list li");
  await expect(items).toHaveCount(1);

  await app.page.getByRole("button", { name: "Pause history" }).click();
  await expect(app.page.getByRole("button", { name: "Resume history" })).toBeVisible();
  await app.text.fill("during");
  await app.translate.click();
  await expect(app.output).toHaveText("一");
  await expect(app.translate).toHaveAttribute("aria-disabled", "false");
  await expect(items).toHaveCount(1);

  await app.page.reload();
  await expect(app.page.getByRole("button", { name: "Resume history" })).toBeVisible();
  await app.page.getByRole("button", { name: "Resume history" }).click();
  await app.text.fill("after");
  await app.translate.click();
  await expect(items).toHaveCount(2);
});

test("the history is not sent to the server", async ({ app, mock, page }) => {
  await mock.set({ chunks: [THINK, "一"] });
  const api: { path: string; body: string }[] = [];
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith("/api/")) api.push({ path: pathname, body: r.postData() ?? "" });
  });
  await app.open();
  await app.text.fill("secret-earlier-text");
  await app.translate.click();
  await expect(app.output).toHaveText("一");
  await app.text.fill("another text");
  await app.translate.click();
  await expect(app.page.locator("#history-list li")).toHaveCount(2);
  expect(api.some((r) => r.path.includes("history"))).toBe(false);
  const translates = api.filter((r) => r.path.endsWith("/translate"));
  expect(translates).toHaveLength(2);
  expect(translates[1]!.body).not.toContain("secret-earlier-text");
});
