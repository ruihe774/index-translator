// The Open button: text, Markdown, PDF and Word files into the source box, in the browser alone,
// and images in its place, which Translate sends.
// The PDF and Word tests need the libraries in public/vendor/ (bun scripts/fetch_web_libs.ts) and
// use test/fixtures/sample.pdf (three pages, see make_sample_pdf.py beside it) and sample.docx
// (make_sample_docx.py).

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test, THINK } from "./fixtures";

const SAMPLE = join(import.meta.dirname, "..", "test", "fixtures", "sample.pdf");
const SAMPLE_DOCX = join(import.meta.dirname, "..", "test", "fixtures", "sample.docx");
const VENDOR = join(import.meta.dirname, "..", "public", "vendor");

function pick(page: Page, name: string, content: string | Buffer, mimeType = "") {
  return page.locator("#open-file").setInputFiles({
    name,
    mimeType,
    buffer: typeof content === "string" ? Buffer.from(content) : content,
  });
}

const note = (page: Page) => page.locator("#file-note");
/** The text box by id: it holds the source also while the preview is shown in its place. */
const box = (page: Page) => page.locator("#text");
const thumbnail = (page: Page, n: number) => page.locator(`#pdf-pages button[data-page="${n}"]`);

/** Every request to the API while the test ran, to show that a file stays in the browser. */
function watchApi(page: Page): { method: string; path: string; body: string }[] {
  const seen: { method: string; path: string; body: string }[] = [];
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith("/api/")) {
      seen.push({ method: r.method(), path: pathname, body: r.postData() ?? "" });
    }
  });
  return seen;
}

/** A PNG of one colour, drawn by the browser itself. */
async function png(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w!;
      canvas.height = h!;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w!, h!);
      return canvas.toDataURL("image/png").split(",")[1]!;
    },
    [width, height],
  );
  return Buffer.from(base64, "base64");
}

test.describe("images", () => {
  const picture = (page: Page) => page.getByRole("img", { name: "Image to translate: menu.png" });

  test("an image takes the place of the text box and is sent only by Translate", async ({ app, mock }) => {
    await mock.set({ chunks: [THINK, "拉面 800 日元"] });
    const api = watchApi(app.page);
    await app.open();
    await app.text.fill("old text");
    const file = await png(app.page, 300, 120);
    await pick(app.page, "menu.png", file, "image/png");

    await expect(picture(app.page)).toBeVisible();
    await expect(box(app.page)).toBeHidden();
    await expect(box(app.page)).toHaveValue("");
    await expect(note(app.page)).toHaveText(
      "Opened menu.png. Translate sends the image to the server, which reads the text in it.",
    );
    await expect(app.page.locator("#count")).toHaveText("menu.png, 300 × 120 pixels");
    await expect(app.page.getByRole("group", { name: "Source view" }).getByRole("button").first()).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(api.filter((r) => r.method !== "GET")).toStrictEqual([]);

    await app.to.selectOption("zh");
    await app.translate.click();
    await expect(app.output).toHaveText("拉面 800 日元");
    await expect(app.meta).toContainText("Index-Translate-9B");
    await expect(app.notes).toHaveCount(0);
    // Still there after the translation, to compare with.
    await expect(picture(app.page)).toBeVisible();

    const sent = api.filter((r) => r.path === "/api/v1/translate");
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "index-translate-9b", target_lang: "zh", stream: true });
    expect(body).not.toHaveProperty("text");
    expect(body.image).toBe(`data:image/png;base64,${file.toString("base64")}`);
    const { requests } = await mock.state();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toBe("请将图片中的文本翻译为中文，直接输出翻译结果，不要进行任何解释。");
    expect(requests[0]!.image?.png).toBe(true);
    // Not kept in the history, which holds texts.
    await expect(app.page.locator("#history-list li")).toHaveCount(0);
  });

  test("Clear, and opening a text, put the text box back", async ({ app }) => {
    await app.open();
    await pick(app.page, "menu.png", await png(app.page, 40, 40), "image/png");
    await expect(picture(app.page)).toBeVisible();
    const clear = app.page.getByRole("button", { name: "Clear", exact: true }).first();
    await expect(clear).toHaveAttribute("aria-disabled", "false");
    await clear.click();
    await expect(picture(app.page)).toBeHidden();
    await expect(app.text).toBeVisible();
    await expect(app.text).toBeFocused();
    await expect(app.page.locator("#count")).toHaveText("0 letters");

    await pick(app.page, "menu.png", await png(app.page, 40, 40), "image/png");
    await expect(picture(app.page)).toBeVisible();
    await pick(app.page, "notes.txt", "Some text", "text/plain");
    await expect(picture(app.page)).toBeHidden();
    await expect(app.text).toHaveValue("Some text");
  });

  test("a pasted image switches to image input", async ({ app }) => {
    await app.open();
    const bytes = [...(await png(app.page, 40, 40))];
    await app.text.focus();
    await app.page.evaluate((data) => {
      const t = new DataTransfer();
      t.items.add(new File([new Uint8Array(data)], "menu.png", { type: "image/png" }));
      document
        .getElementById("text")!
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: t, bubbles: true, cancelable: true }));
    }, bytes);
    await expect(picture(app.page)).toBeVisible();
  });

  test("a pasted text file is opened like a picked one", async ({ app }) => {
    await app.open();
    await app.page.evaluate(() => {
      const t = new DataTransfer();
      t.items.add(new File(["Pasted text\n"], "paste.txt", { type: "text/plain" }));
      document
        .getElementById("text")!
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: t, bubbles: true, cancelable: true }));
    });
    await expect(app.text).toHaveValue("Pasted text\n");
  });

  test("a dropped image is opened like a picked one, whole inside the pane", async ({ app }) => {
    await app.open();
    const bytes = [...(await png(app.page, 200, 3000))];
    const dt = await app.page.evaluateHandle((data) => {
      const t = new DataTransfer();
      t.items.add(new File([new Uint8Array(data)], "menu.png", { type: "image/png" }));
      return t;
    }, bytes);
    const target = app.page.locator("header").first();
    await target.dispatchEvent("dragover", { dataTransfer: dt });
    await target.dispatchEvent("drop", { dataTransfer: dt });
    await expect(picture(app.page)).toBeVisible();
    // Far taller than the pane: scaled to fit it, in proportion.
    const pane = (await app.page.locator("#source-image").boundingBox())!;
    const shown = await picture(app.page).evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const box = canvas.getBoundingClientRect();
      // `object-fit: contain` draws the picture inside the box at its own proportions.
      const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
      return { boxHeight: box.height, boxWidth: box.width, height: canvas.height * scale, width: canvas.width * scale };
    });
    expect(shown.boxHeight).toBeLessThanOrEqual(pane.height);
    expect(shown.boxWidth).toBeLessThanOrEqual(pane.width);
    expect(shown.height / shown.width).toBeCloseTo(15, 0);
    expect(shown.height).toBeGreaterThan(pane.height * 0.9);
  });

  test("what is not an image, and one over 8 MB, are refused with a reason", async ({ app }) => {
    await app.open();
    await app.text.fill("kept");
    await pick(app.page, "broken.png", "this is not a picture", "image/png");
    await expect(note(app.page)).toHaveText("broken.png was not opened: it could not be read as an image.");
    await expect(note(app.page)).toHaveClass(/error/);
    await pick(app.page, "huge.jpg", Buffer.alloc(8 * 2 ** 20 + 1), "image/jpeg");
    await expect(note(app.page)).toHaveText("huge.jpg was not opened: it is larger than 8 MB.");
    await pick(app.page, "anim.gif", "GIF89a", "image/gif");
    await expect(note(app.page)).toContainText("anim.gif was not opened: only plain text");
    await expect(app.text).toHaveValue("kept");
    await expect(app.text).toBeVisible();
  });

  test("the document model is not used for an image, and a missing image encoder is said", async ({ app, mock }) => {
    await mock.set({ imageUnavailable: "the image encoder of index-translate-9b is not at /models/mmproj.gguf" });
    await app.open();
    await app.model("Index-NativeLong-9B").click();
    await pick(app.page, "menu.png", await png(app.page, 40, 40), "image/png");
    await expect(app.advice).toContainText("Index-NativeLong-9B does not translate images");
    await app.translate.click();
    await expect(app.meta).toContainText(
      "Images cannot be translated on this server: the image encoder of index-translate-9b is not at /models/mmproj.gguf.",
    );
    await expect(app.meta).toHaveAttribute("role", "alert");
    await expect(picture(app.page)).toBeVisible();
    expect((await mock.state()).launches).not.toContain("index-nailong-9b");
  });
});

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
    expect(api.filter((r) => r.method !== "GET")).toStrictEqual([]);
  });

  test("a file dropped anywhere on the page is opened like a picked one", async ({ app }) => {
    await app.open();
    const dt = await app.page.evaluateHandle(() => {
      const t = new DataTransfer();
      t.items.add(new File(["Dropped text\n"], "drop.txt", { type: "text/plain" }));
      return t;
    });
    // The footer-most element: nowhere near the text box.
    const target = app.page.locator("header").first();
    await target.dispatchEvent("dragover", { dataTransfer: dt });
    await expect(app.page.locator("html")).toHaveClass(/dropping/);
    // Leaving the window (no related target) clears the outline, and so does a drag that goes quiet.
    await target.dispatchEvent("dragleave", { dataTransfer: dt, relatedTarget: null });
    await expect(app.page.locator("html")).not.toHaveClass(/dropping/);
    await target.dispatchEvent("dragover", { dataTransfer: dt });
    await expect(app.page.locator("html")).toHaveClass(/dropping/);
    await expect(app.page.locator("html")).not.toHaveClass(/dropping/, { timeout: 2000 });
    await target.dispatchEvent("dragover", { dataTransfer: dt });
    await target.dispatchEvent("drop", { dataTransfer: dt });
    await expect(app.page.locator("html")).not.toHaveClass(/dropping/);
    await expect(app.text).toHaveValue("Dropped text\n");
    await expect(note(app.page)).toHaveText("Opened drop.txt.");
  });

  test("a Markdown file is opened in Preview, with Raw one click away; plain text opens in the box", async ({
    app,
  }) => {
    await app.open();
    const view = app.page.getByRole("group", { name: "Source view" });
    await pick(app.page, "doc.md", "# Title\n\nA paragraph with *emphasis*.\n");
    await expect(box(app.page)).toHaveValue("# Title\n\nA paragraph with *emphasis*.\n");
    await expect(view.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
    await expect(app.page.locator("#source-view").getByRole("heading", { name: "Title" })).toBeVisible();
    await expect(app.page.locator("#source-view em")).toHaveText("emphasis");
    await expect(app.text).toBeHidden();

    await view.getByRole("button", { name: "Raw" }).click();
    await expect(app.text).toBeVisible();
    await expect(app.text).toHaveValue("# Title\n\nA paragraph with *emphasis*.\n");

    await pick(app.page, "notes.txt", "Just a line.\n");
    await expect(view.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
    await expect(app.text).toBeVisible();
    await expect(app.text).toHaveValue("Just a line.\n");
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
    await pick(app.page, "report.doc", "ÐÏ");
    await expect(note(app.page)).toHaveText(
      "report.doc was not opened: only plain text, Markdown, PDF and Word (.docx) files and JPEG, PNG and WebP images can be.",
    );
    await expect(note(app.page)).toHaveClass(/error/);
    await pick(app.page, "gbk.txt", Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    await expect(note(app.page)).toHaveText("gbk.txt was not opened: it is not text in UTF-8.");
    await pick(app.page, "empty.txt", "");
    await expect(note(app.page)).toHaveText("empty.txt was not opened: it is empty.");
    await expect(app.text).toHaveValue("kept");
  });

  test("the picker offers text, Markdown, PDF, Word and images", async ({ app }) => {
    await app.open();
    const accept = (await app.page.locator("#open-file").getAttribute("accept")) ?? "";
    for (const kind of [
      ".txt",
      ".md",
      ".pdf",
      ".docx",
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]) {
      expect(accept.split(",")).toContain(kind);
    }
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
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! < 128 && data[i + 3]! > 0) {
            n++;
          }
        }
        return n;
      });
    expect(dark).toBeGreaterThan(20);

    // The strip is as tall as the box beside it and inside the panel.
    const strip = (await app.page.locator("#pdf-pages").boundingBox())!;
    const box = (await app.text.boundingBox())!;
    expect(Math.abs(strip.height - box.height)).toBeLessThan(1);
    expect(strip.x + strip.width).toBeLessThanOrEqual(box.x);

    expect((await mock.state()).requests).toHaveLength(0);
    expect(api.filter((r) => r.method !== "GET")).toStrictEqual([]);
  });

  test("a clicked page goes into the box as Markdown, without translating", async ({ app, mock }) => {
    const api = watchApi(app.page);
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await thumbnail(app.page, 2).click();
    await expect(box(app.page)).toHaveValue(/^# Mountains of the South\n\nThe second page is about mountains\./);
    await expect(thumbnail(app.page, 2)).toHaveAttribute("aria-current", "true");
    await expect(note(app.page)).toHaveText("sample.pdf, page 2 of 3.");
    await expect(app.output).toHaveText("");
    // Shown rendered: the text was not typed, so it is more likely read than edited.
    const preview = app.page.getByRole("group", { name: "Source view" }).getByRole("button", { name: "Preview" });
    await expect(preview).toHaveAttribute("aria-pressed", "true");
    await expect(
      app.page.locator("#source-view").getByRole("heading", { name: "Mountains of the South" }),
    ).toBeVisible();
    await expect(app.text).toBeHidden();

    await thumbnail(app.page, 1).click();
    await expect(box(app.page)).toHaveValue(/^# Rivers of the North\n/);
    await expect(box(app.page)).not.toHaveValue(/Mountains/);
    await expect(app.page.locator("#source-view").getByRole("heading", { name: "Rivers of the North" })).toBeVisible();
    await expect(thumbnail(app.page, 1)).toHaveAttribute("aria-current", "true");
    await expect(thumbnail(app.page, 2)).not.toHaveAttribute("aria-current");

    expect((await mock.state()).requests).toHaveLength(0);
    expect(api.filter((r) => r.method !== "GET")).toStrictEqual([]);

    // Translating is the user's step, and sends the page's text only.
    await mock.set({ chunks: [THINK, "# 北方的河流"] });
    await app.translate.click();
    await expect(app.output).toContainText("北方的河流");
    const posts = api.filter((r) => r.method !== "GET");
    expect(posts.map((r) => r.path)).toStrictEqual(["/api/v1/translate"]);
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
    await expect(box(app.page)).not.toHaveValue("");
  });

  test("a clicked thumbnail shows that its page is being read", async ({ app }) => {
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await expect(thumbnail(app.page, 1)).toBeVisible();
    // The small page is read within milliseconds, so the state is looked at in the click's own task.
    const during = await thumbnail(app.page, 1).evaluate((button: HTMLElement) => {
      button.click();
      return {
        busy: button.getAttribute("aria-busy"),
        spinner: getComputedStyle(button.querySelector(".picture")!, "::after").content,
        note: document.getElementById("file-note")?.textContent,
      };
    });
    expect(during).toStrictEqual({ busy: "true", spinner: '""', note: "sample.pdf: reading page 1…" });
    await expect(thumbnail(app.page, 1)).toHaveAttribute("aria-current", "true");
    await expect(thumbnail(app.page, 1)).not.toHaveAttribute("aria-busy");
    expect(
      await thumbnail(app.page, 1).evaluate((b) => getComputedStyle(b.querySelector(".picture")!, "::after").content),
    ).toBe("none");
  });

  test("the page spinner sits at the center of the thumbnail's picture", async ({ app }) => {
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await expect(thumbnail(app.page, 1)).toBeVisible();
    const offsets = await thumbnail(app.page, 1).evaluate((button: HTMLElement) => {
      button.setAttribute("aria-busy", "true");
      const canvas = button.querySelector("canvas") as HTMLElement;
      const spinner = getComputedStyle(canvas.parentElement as Element, "::after");
      const box = canvas.getBoundingClientRect();
      const size = Number.parseFloat(spinner.width);
      // ::after is absolutely placed in .picture, which has the canvas's box.
      return { size, width: box.width, height: box.height, left: Number.parseFloat(spinner.marginLeft) };
    });
    expect(offsets.size).toBeGreaterThan(0);
    expect(offsets.size).toBeLessThan(offsets.width);
  });

  test("a spinner shows at the center of the box while a file is read", async ({ app }) => {
    await app.open();
    const field = app.page.locator("#source-field");
    await expect(field).not.toHaveAttribute("aria-busy");
    const during = await app.page.evaluate(() => {
      const input = document.getElementById("open-file") as HTMLInputElement;
      const data = new DataTransfer();
      data.items.add(new File(["hello"], "a.txt", { type: "text/plain" }));
      input.files = data.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const field = document.getElementById("source-field")!;
      return { busy: field.getAttribute("aria-busy"), spinner: getComputedStyle(field, "::after").content };
    });
    expect(during).toStrictEqual({ busy: "true", spinner: '""' });
    await expect(field).not.toHaveAttribute("aria-busy");
  });

  test("the corners of the strip, a page button and its picture are concentric", async ({ app }) => {
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await expect(thumbnail(app.page, 1)).toBeVisible();
    const px = (selector: string, property: string) =>
      app.page
        .locator(selector)
        .first()
        .evaluate((el, p) => Number.parseFloat(getComputedStyle(el).getPropertyValue(p)), property);
    const strip = await px("#pdf-pages", "border-top-left-radius");
    const button = await px("#pdf-pages button", "border-top-left-radius");
    const canvas = await px("#pdf-pages canvas", "border-top-left-radius");
    // Each radius is the one around it less the padding and the 1px border between them.
    expect(button).toBeCloseTo(strip - (await px("#pdf-pages", "padding-top")) - 1, 1);
    expect(canvas).toBeCloseTo(Math.max(4, button - (await px("#pdf-pages button", "padding-top")) - 1), 1);
    expect(canvas).toBeGreaterThan(0);
  });

  test("Open becomes Close while a PDF is open; Clear keeps the thumbnails", async ({ app }) => {
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await thumbnail(app.page, 1).click();
    await expect(box(app.page)).toHaveValue(/Rivers/);

    // One button: it closes the open PDF, and nothing else can be opened until it has.
    const close = app.page.getByRole("button", { name: "Close the PDF" });
    await expect(close).toHaveText("Close");
    await expect(app.page.getByRole("button", { name: "Open a file" })).toHaveCount(0);
    await expect(app.page.locator("#pdf-pages button:not([data-page])")).toHaveCount(0);
    await pick(app.page, "notes.txt", "not opened");
    await expect(box(app.page)).toHaveValue(/Rivers/);
    await expect(app.page.locator("#pdf-pages")).toBeVisible();

    await app.page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(app.text).toHaveValue("");
    await expect(app.page.locator("#pdf-pages button[data-page]")).toHaveCount(3);
    await expect(thumbnail(app.page, 1)).not.toHaveAttribute("aria-current");

    await thumbnail(app.page, 2).click();
    await expect(box(app.page)).toHaveValue(/Mountains/);
    await close.click();
    await expect(app.page.locator("#pdf-pages")).toBeHidden();
    await expect(note(app.page)).toBeHidden();
    await expect(box(app.page)).toHaveValue(/Mountains/);
    const open = app.page.getByRole("button", { name: "Open a file" });
    await expect(open).toHaveText("Open");
    await expect(open).toBeFocused();

    // And the same file can be opened again.
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await expect(app.page.locator("#pdf-pages button[data-page]")).toHaveCount(3);
  });

  test("thumbnails and Close wait for a running translation", async ({ app, mock }) => {
    await mock.set({ chunks: [THINK, "一", "二", "三"], delayMs: 300 });
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE);
    await thumbnail(app.page, 1).click();
    await expect(box(app.page)).toHaveValue(/Rivers/);
    await app.translate.click();
    await expect(thumbnail(app.page, 2)).toHaveAttribute("aria-disabled", "true");
    await expect(app.page.getByRole("button", { name: "Close the PDF" })).toHaveAttribute("aria-disabled", "true");
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

  test("without the libraries, text files still open and a PDF or Word file is refused with a reason", async ({
    app,
  }) => {
    await app.page.route("**/vendor/**", (route) => route.fulfill({ status: 404, body: "Not Found" }));
    const errors: string[] = [];
    app.page.on("pageerror", (e) => errors.push(e.message));
    await app.open();
    const input = app.page.locator("#open-file");
    await expect(input).toHaveAttribute(
      "accept",
      ".txt,.md,.markdown,text/plain,text/markdown,.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp",
    );
    await expect(app.page.getByRole("button", { name: "Open a file" })).toHaveAttribute(
      "title",
      "PDF and Word files cannot be opened: their support is not installed on this server.",
    );

    await input.setInputFiles(SAMPLE);
    await expect(note(app.page)).toHaveText("sample.pdf was not opened. PDF support could not be loaded.");
    await expect(note(app.page)).toHaveClass(/error/);
    await expect(app.page.locator("#pdf-pages")).toBeHidden();

    await input.setInputFiles(SAMPLE_DOCX);
    await expect(note(app.page)).toHaveText("sample.docx was not opened. Word support could not be loaded.");
    await expect(note(app.page)).toHaveClass(/error/);

    await pick(app.page, "notes.txt", "still works");
    await expect(app.text).toHaveValue("still works");
    await expect(app.translate).toHaveAttribute("aria-disabled", "false");
    expect(errors).toStrictEqual([]);
  });
});

test.describe("Word", () => {
  test.beforeAll(() => {
    if (!existsSync(join(VENDOR, "undoc", "VERSION"))) {
      throw new Error("undoc is not in public/vendor; run: bun scripts/fetch_web_libs.ts");
    }
  });

  test("a .docx goes into the box whole as Markdown, shown formatted, and nothing is sent", async ({ app, mock }) => {
    const api = watchApi(app.page);
    await app.open();
    await app.page.locator("#open-file").setInputFiles(SAMPLE_DOCX);
    await expect(note(app.page)).toHaveText("Opened sample.docx.");
    await expect(note(app.page)).not.toHaveClass(/error/);
    const view = app.page.locator("#source-view");
    await expect(view.getByRole("heading", { name: "Harbours of the South" })).toBeVisible();
    await expect(view.locator("strong")).toHaveText("Lighthouses");
    await expect(view.locator("td").first()).toHaveText("Marlow");
    await expect(box(app.page)).toHaveValue(/^# Harbours of the South\n\nA harbour shelters ships/);
    await expect(box(app.page)).toHaveValue(/\| Marlow \| 1204 \|/);
    await expect(app.page.locator("#pdf-pages")).toBeHidden();
    await expect(app.page.locator("#source-field")).not.toHaveAttribute("aria-busy");
    expect((await mock.state()).requests).toHaveLength(0);
    expect(api.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("a file that is not a Word document inside is refused, and the box is kept", async ({ app }) => {
    await app.open();
    await app.text.fill("kept");
    await pick(app.page, "fake.docx", "this is not a zip");
    await expect(note(app.page)).toHaveText("fake.docx was not opened. It is not a readable Word (.docx) document.");
    await expect(note(app.page)).toHaveClass(/error/);
    await expect(app.text).toHaveValue("kept");
  });
});
