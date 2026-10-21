// A web address alone in the text box: Translate asks first, then fetches the page through the
// server (POST /webpage, the mock browser of test/helpers/mock-engine.ts; the mock server allows
// example.com and its subdomains) and puts its Markdown in the box as a preview. A second Translate
// translates it.

import type { Page } from "@playwright/test";

import { type AppPage, expect, test, THINK } from "./fixtures";

const MARKDOWN = "# A fetched page\n\nIts first paragraph.\n\nIts [second](https://example.com/two) paragraph.";

const dialog = (page: Page) => page.getByRole("dialog", { name: "Fetch this web page?" });
/** The text box by id: it holds the source also while the preview is shown in its place. */
const box = (page: Page) => page.locator("#text");
/** Under the box: the letter count, which says while a page is fetched. */
const count = (page: Page) => page.locator("#count");
/** What a screen reader is told about the box (visually hidden). */
const status = (page: Page) => page.locator("#source-status");
const textError = (page: Page) => page.locator("#text-error");

/** Opens the page once the server's status is in, which says whether pages can be fetched. */
async function openReady(app: AppPage) {
  await app.open();
  await expect(app.engine).toContainText("Engine ready");
}

test("an address alone is offered as a page; its Markdown becomes the source, shown as a preview", async ({
  app,
  mock,
}) => {
  await mock.set({ chunks: [THINK, "# 抓取的页面"], webpage: { title: "A fetched page", markdown: MARKDOWN } });
  await openReady(app);
  await app.text.fill("  example.com/post?id=1 \n");
  await app.translate.click();

  await expect(dialog(app.page)).toBeVisible();
  await expect(dialog(app.page).locator(".link-dialog-target")).toHaveText("https://example.com/post?id=1");
  await expect(dialog(app.page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog(app.page).getByRole("button", { name: "Fetch page" }).click();

  await expect(status(app.page)).toHaveText("Fetched “A fetched page”. Translate it when you are ready.");
  await expect(status(app.page)).toHaveAttribute("role", "status");
  await expect(count(app.page)).toHaveText(/^\d+ letters$/);
  // The status line under the translation is the translation's.
  await expect(app.meta).toHaveText("");
  await expect(box(app.page)).toHaveValue(MARKDOWN);
  await expect(box(app.page)).toBeHidden();
  await expect(app.page.locator("#source-view").getByRole("heading", { name: "A fetched page" })).toBeVisible();
  await expect(
    app.page.getByRole("group", { name: "Source view" }).getByRole("button", { name: "Preview" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(app.translate).toBeFocused();
  let state = await mock.state();
  expect(state.webpage.requests).toStrictEqual(["https://example.com/post?id=1"]);
  expect(state.requests).toHaveLength(0);

  // The box now holds the page, not an address: Translate translates it, without asking.
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await expect(dialog(app.page)).toBeHidden();
  state = await mock.state();
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]!.prompt).toContain("Its first paragraph.");
});

test("Translate as text translates the address; Cancel and Escape do nothing", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "节点"] });
  await openReady(app);
  await app.text.fill("https://example.com/");

  await app.translate.click();
  await dialog(app.page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(app.page)).toBeHidden();
  await expect(app.translate).toBeFocused();
  await app.translate.click();
  await expect(dialog(app.page)).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(dialog(app.page)).toBeHidden();
  expect((await mock.state()).requests).toHaveLength(0);

  await app.translate.click();
  await dialog(app.page).getByRole("button", { name: "Translate as text" }).click();
  await expect(app.meta).toContainText("generated");
  await expect(app.output).toHaveText("节点");
  const state = await mock.state();
  expect(state.webpage.requests).toStrictEqual([]);
  expect(state.requests[0]!.prompt).toContain("https://example.com/");
});

test("text that is more than an address is translated without asking", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "见"] });
  await openReady(app);
  await app.text.fill("See example.com for more.");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await expect(dialog(app.page)).toBeHidden();
});

test("a server that cannot fetch pages is not asked: the address is translated", async ({ app, mock }) => {
  await mock.set({ chunks: [THINK, "例"], webpage: { problem: "turndown is not installed on this server" } });
  await openReady(app);
  await app.text.fill("example.com");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  expect((await mock.state()).webpage.requests).toStrictEqual([]);
});

test("a page that cannot be fetched says why and leaves the address in the box", async ({ app, mock }) => {
  await mock.set({ webpage: { failWith: "the page could not be opened: net::ERR_NAME_NOT_RESOLVED" } });
  await openReady(app);
  await app.text.fill("example.com/missing");
  await app.translate.click();
  await dialog(app.page).getByRole("button", { name: "Fetch page" }).click();
  const why = "The page could not be fetched: the page could not be opened: net::ERR_NAME_NOT_RESOLVED.";
  // The box's own error, which describes it, and said to a screen reader.
  await expect(textError(app.page)).toHaveText(why);
  await expect(textError(app.page)).toBeVisible();
  await expect(app.text).toHaveAttribute("aria-invalid", "true");
  await expect(app.text).toHaveAccessibleDescription(`17 letters ${why}`);
  await expect(status(app.page)).toHaveText(why);
  await expect(app.meta).toHaveText("");
  await expect(app.text).toHaveValue("example.com/missing");
  await expect(app.translate).toBeFocused();

  // A host the server may not open is refused by the server, not guessed by the page.
  await app.text.fill("https://other.test/");
  await app.translate.click();
  await dialog(app.page).getByRole("button", { name: "Fetch page" }).click();
  await expect(textError(app.page)).toHaveText(
    "This server may not fetch that page: other.test is not in ALLOWED_WEBPAGE_DOMAINS.",
  );
  // Editing the box takes the error away, as for any other error of the box.
  await app.text.fill("https://example.com/");
  await expect(textError(app.page)).toBeHidden();
  expect((await mock.state()).webpage.requests).toStrictEqual(["https://example.com/missing"]);
});

test("Stop ends a fetch that takes long", async ({ app, mock }) => {
  await mock.set({ webpage: { delayMs: 10_000 } });
  await openReady(app);
  await app.text.fill("example.com");
  await app.translate.click();
  await dialog(app.page).getByRole("button", { name: "Fetch page" }).click();
  await expect(count(app.page)).toHaveText("Fetching the page…");
  await expect(status(app.page)).toHaveText("Fetching the page…");
  await expect(app.meta).toHaveText("");
  // Typing does not put the letter count back while the fetch runs.
  await app.text.press("End");
  await app.text.pressSequentially("/");
  await app.page.waitForTimeout(300);
  await expect(count(app.page)).toHaveText("Fetching the page…");
  await app.stop.click();
  await expect(status(app.page)).toHaveText("Stopped.");
  await expect(count(app.page)).toHaveText("10 letters");
  await expect(app.translate).toBeFocused();
  await expect(app.text).toHaveValue("example.com/");
  await expect.poll(async () => (await mock.state()).webpage.aborted).toBe(1);
});
