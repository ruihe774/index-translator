// The Open button: text, Markdown and PDF files into the source box, in the browser alone.
// The PDF tests need the libraries in public/vendor/ (bun scripts/fetch_web_libs.ts) and use
// test/fixtures/sample.pdf (three pages, see make_sample_pdf.py beside it).

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, THINK, test } from "./fixtures";

const SAMPLE = join(import.meta.dirname, "..", "test", "fixtures", "sample.pdf");
const VENDOR = join(import.meta.dirname, "..", "public", "vendor");

function pick(page: Page, name: string, content: string | Buffer, mimeType = "") {
  return page.locator("#open-file").setInputFiles({
    name,
    mimeType,
    buffer: typeof content === "string" ? Buffer.from(content) : content,
  });
}

const note = (page: Page) => page.locator("#file-note");
const thumbnail = (page: Page, n: number) => page.locator(`#pdf-pages button[data-page="${n}"]`);

/** Every request to the API while the test ran, to show that a file stays in the browser. */
function watchApi(page: Page): { method: string; path: string; body: string }[] {
  const seen: { method: string; path: string; body: string }[] = [];
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith("/api/")) seen.push({ method: r.method(), path: pathname, body: r.postData() ?? "" });
  });
  return seen;
}

test.describe("text and Markdown", () => {
  test("a text file goes into the box and nothing is translated or sent", async ({ app, mock }) => {
    const api = watchApi(app.page);
    await app.open();
    await expect(app.page.getByRole("button", { name: "Open a file" })).toBeVisible();
    await pick(app.page, "notes.txt", "First line\r\nSecond line\n", "text/plain");
    await expect(app.text).toHaveValue("First line\nSecond line\n");
    await expect(note(app.page)).toHaveText("Opened notes.txt.");
    await expect(app.page.locator("#count")).toHaveText("19 letters");
    await expect(app.page.locator("#pdf-pages")).toBeHidden();
    expect((await mock.state()).requests).toHaveLength(0);
    expect(api.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("a Markdown file is opened as its source, ready for Preview", async ({ app }) => {
    await app.open();
    await pick(app.page, "doc.md", "# Title\n\nA paragraph with *emphasis*.\n");
    await expect(app.text).toHaveValue("# Title\n\nA paragraph with *emphasis*.\n");
    await app.page.getByRole("group", { name: "Source view" }).getByRole("button", { name: "Preview" }).click();
    await expect(app.page.locator("#source-view").getByRole("heading", { name: "Title" })).toBeVisible();
    await expect(app.page.locator("#source-view em")).toHaveText("emphasis");
  });

  test("opening a file replaces the text and drops the translation of the old one", async ({ app, mock }) => {
    await mock.set({ chunks: [THINK, "你好"] });
    await app.open();
    await app.text.fill("Hello");
    await app.translate.click();
    await expect(app.output).toHaveText("你好");
    await pick(app.page, "next.txt", "Another text");
    await expect(app.text).toHaveValue("Another text");
    await expect(app.output).toHaveText("");
    await expect(app.page.locator("#placeholder")).toBeVisible();
    expect((await mock.state()).requests).toHaveLength(1);
  });

  test("other files, other encodings and empty files are refused with a reason", async ({ app }) => {
    await app.open();
    await app.text.fill("kept");
    await pick(app.page, "report.docx", "PK");
    await expect(note(app.page)).toHaveText(
      "report.docx was not opened: only plain text, Markdown and PDF files can be.",
    );
    await expect(note(app.page)).toHaveClass(/error/);
    await pick(app.page, "gbk.txt", Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    await expect(note(app.page)).toHaveText("gbk.txt was not opened: it is not text in UTF-8.");
    await pick(app.page, "empty.txt", "");
    await expect(note(app.page)).toHaveText("empty.txt was not opened: it is empty.");
    await expect(app.text).toHaveValue("kept");
  });

  test("Open waits for a running translation", async ({ app, mock }) => {
    await mock.set({ chunks: [THINK, "一", "二", "三"], delayMs: 300 });
    await app.open();
    await app.text.fill("Hello");
    await app.translate.click();
    const open = app.page.getByRole("button", { name: "Open a file" });
    await expect(open).toHaveAttribute("aria-disabled", "true");
    await app.stop.click();
    await expect(open).toHaveAttribute("aria-disabled", "false");
  });
});

test.describe("PDF", () => {
  test.beforeAll(() => {
    if (!existsSync(join(VENDOR, "pdfjs", "VERSION")) || !existsSync(join(VENDOR, "pdf-inspector", "VERSION"))) {
      throw new Error("the PDF libraries are not in public/vendor; run: bun scripts/fetch_web_libs.ts");
    }
  });

  test("shows a thumbnail per page and extracts nothing until one is clicked", async ({ app, mock }) => {
    const api = watchApi(app.page);
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await expect(app.page.locator("#pdf-pages button[data-page]")).toHaveCount(3);
    await expect(note(app.page)).toHaveText("sample.pdf: 3 pages. Select a page to put its text in the box.");
    await expect(app.text).toHaveValue("");

    // Drawn, and not blank: the first page has ink on it.
    await expect(app.page.locator("#pdf-pages canvas[data-drawn]")).toHaveCount(3);
    const dark = await thumbnail(app.page, 1)
      .locator("canvas")
      .evaluate((canvas: HTMLCanvasElement) => {
        const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
        let n = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i]! < 128 && data[i + 3]! > 0) n++;
        return n;
      });
    expect(dark).toBeGreaterThan(20);

    // The strip is as tall as the box beside it and inside the panel.
    const strip = (await app.page.locator("#pdf-pages").boundingBox())!;
    const box = (await app.text.boundingBox())!;
    expect(Math.abs(strip.height - box.height)).toBeLessThan(1);
    expect(strip.x + strip.width).toBeLessThanOrEqual(box.x);

    expect((await mock.state()).requests).toHaveLength(0);
    expect(api.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("a clicked page goes into the box as Markdown, without translating", async ({ app, mock }) => {
    const api = watchApi(app.page);
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await thumbnail(app.page, 2).click();
    await expect(app.text).toHaveValue(/^# Mountains of the South\n\nThe second page is about mountains\./);
    await expect(thumbnail(app.page, 2)).toHaveAttribute("aria-current", "true");
    await expect(note(app.page)).toHaveText("sample.pdf, page 2 of 3.");
    await expect(app.output).toHaveText("");

    await thumbnail(app.page, 1).click();
    await expect(app.text).toHaveValue(/^# Rivers of the North\n/);
    await expect(app.text).not.toHaveValue(/Mountains/);
    await expect(thumbnail(app.page, 1)).toHaveAttribute("aria-current", "true");
    await expect(thumbnail(app.page, 2)).not.toHaveAttribute("aria-current");

    expect((await mock.state()).requests).toHaveLength(0);
    expect(api.filter((r) => r.method !== "GET")).toEqual([]);

    // Translating is the user's step, and sends the page's text only.
    await mock.set({ chunks: [THINK, "# 北方的河流"] });
    await app.translate.click();
    await expect(app.output).toContainText("北方的河流");
    const posts = api.filter((r) => r.method !== "GET");
    expect(posts.map((r) => r.path)).toEqual(["/api/v1/translate"]);
    expect(posts[0]!.body).toContain("Rivers of the North");
    expect(posts[0]!.body).not.toContain("sample.pdf");
    expect(posts[0]!.body).not.toContain("Mountains");
  });

  test("a page whose text the library could not read reliably is put in the box with a warning", async ({ app }) => {
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await thumbnail(app.page, 3).click();
    await expect(note(app.page)).toContainText("sample.pdf, page 3 of 3: some of the text could not be read");
    await expect(note(app.page)).toHaveClass(/advice/);
    await expect(app.text).not.toHaveValue("");
  });

  test("Close removes the thumbnails and keeps the text; Clear keeps the thumbnails", async ({ app }) => {
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await thumbnail(app.page, 1).click();
    await expect(app.text).toHaveValue(/Rivers/);

    await app.page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(app.text).toHaveValue("");
    await expect(app.page.locator("#pdf-pages button[data-page]")).toHaveCount(3);
    await expect(thumbnail(app.page, 1)).not.toHaveAttribute("aria-current");

    await thumbnail(app.page, 2).click();
    await expect(app.text).toHaveValue(/Mountains/);
    await app.page.getByRole("button", { name: "Close the PDF" }).click();
    await expect(app.page.locator("#pdf-pages")).toBeHidden();
    await expect(note(app.page)).toBeHidden();
    await expect(app.text).toHaveValue(/Mountains/);

    // A text file closes the PDF too.
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await expect(app.page.locator("#pdf-pages")).toBeVisible();
    await pick(app.page, "notes.txt", "plain");
    await expect(app.page.locator("#pdf-pages")).toBeHidden();
    await expect(app.text).toHaveValue("plain");
  });

  test("thumbnails wait for a running translation", async ({ app, mock }) => {
    await mock.set({ chunks: [THINK, "一", "二", "三"], delayMs: 300 });
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await thumbnail(app.page, 1).click();
    await expect(app.text).toHaveValue(/Rivers/);
    await app.translate.click();
    await expect(thumbnail(app.page, 2)).toHaveAttribute("aria-disabled", "true");
    await thumbnail(app.page, 2).click({ force: true });
    await app.stop.click();
    await expect(thumbnail(app.page, 2)).toHaveAttribute("aria-disabled", "false");
    // The box is behind the source preview now, so it is read directly.
    await expect(app.page.locator("#text")).toHaveValue(/Rivers/);
  });

  test("a file that is not a PDF inside is refused", async ({ app }) => {
    await app.open();
    await pick(app.page, "fake.pdf", "this is not a PDF", "application/pdf");
    await expect(note(app.page)).toHaveText("fake.pdf was not opened. It is not a readable PDF.");
    await expect(app.page.locator("#pdf-pages")).toBeHidden();
  });

  test("without the libraries, text files still open and a PDF is refused with a reason", async ({ app }) => {
    await app.page.route("**/vendor/**", (route) => route.fulfill({ status: 404, body: "Not Found" }));
    const errors: string[] = [];
    app.page.on("pageerror", (e) => errors.push(e.message));
    await app.open();
    const input = app.page.locator("#open-file");
    await expect(input).toHaveAttribute("accept", ".txt,.md,.markdown,text/plain,text/markdown");
    await expect(app.page.getByRole("button", { name: "Open a file" })).toHaveAttribute("title", /not installed/);

    await input.setInputFiles(SAMPLE);
    await expect(note(app.page)).toHaveText("sample.pdf was not opened. PDF support could not be loaded.");
    await expect(note(app.page)).toHaveClass(/error/);
    await expect(app.page.locator("#pdf-pages")).toBeHidden();

    await pick(app.page, "notes.txt", "still works");
    await expect(app.text).toHaveValue("still works");
    await expect(app.translate).toHaveAttribute("aria-disabled", "false");
    expect(errors).toEqual([]);
  });
});
