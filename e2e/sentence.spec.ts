// The sentence under the pointer is marked in the rendered views (sentence-hover.ts).

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

const SOURCE = "# Title\n\nFirst sentence here. Second sentence there.\n";

/** The middle of `word`'s first occurrence in the text of `container`. */
function centreOf(page: Page, container: string, word: string) {
  return page.evaluate(
    ([selector, w]) => {
      const walker = document.createTreeWalker(document.querySelector(selector!)!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const at = node.data.indexOf(w!);
        if (at !== -1) {
          const range = new Range();
          range.setStart(node, at);
          range.setEnd(node, at + w!.length);
          const box = range.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }
      }
      throw new Error(`no "${w}" in ${selector}`);
    },
    [container, word],
  );
}

/** The text of what is marked now. */
const marked = (page: Page) =>
  page.evaluate(() => [...(CSS.highlights.get("sentence") ?? [])].map((r) => (r as unknown as Range).toString()));

async function hover(page: Page, container: string, word: string) {
  const { x, y } = await centreOf(page, container, word);
  await page.mouse.move(x, y);
}

// The blocks of most tests here match, which would mark counterparts too (see the tests at the end): those
// are left out by having no aligner.
const NO_ALIGNER = { state: "unavailable" } as const;

test("the sentence under the pointer is marked in both views, and only it", async ({ app, mock }) => {
  await mock.set({ chunks: ["# Titre\n\n", "Première phrase ici. Seconde phrase là.\n"], align: NO_ALIGNER });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("fr");
  await app.text.fill(SOURCE);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  await hover(app.page, "#source-view", "Second");
  await expect.poll(() => marked(app.page)).toStrictEqual(["Second sentence there."]);
  await hover(app.page, "#source-view", "First");
  await expect.poll(() => marked(app.page)).toStrictEqual(["First sentence here."]);
  await hover(app.page, "#source-view", "Title");
  await expect.poll(() => marked(app.page)).toStrictEqual(["Title"]);

  await hover(app.page, "#output", "Seconde");
  await expect.poll(() => marked(app.page)).toStrictEqual(["Seconde phrase là."]);
  await hover(app.page, "#output", "Première");
  await expect.poll(() => marked(app.page)).toStrictEqual(["Première phrase ici."]);

  // Away from the text: nothing is marked.
  await app.page.mouse.move(2, 2);
  await expect.poll(() => marked(app.page)).toStrictEqual([]);
});

test("a hard line break inside a paragraph does not end its sentence", async ({ app, mock }) => {
  await mock.set({ chunks: ["# Titre\n\n", "Une phrase qui  \ncontinue ici. Puis une autre.\n"], align: NO_ALIGNER });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("fr");
  await app.text.fill("# Title\n\nSomething to translate.\n");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await expect(app.output.locator("br")).toHaveCount(1);

  // The range crosses the <br>, which has no text.
  await hover(app.page, "#output", "continue");
  await expect.poll(() => marked(app.page)).toStrictEqual(["Une phrase quicontinue ici."]);
  await hover(app.page, "#output", "Puis");
  await expect.poll(() => marked(app.page)).toStrictEqual(["Puis une autre."]);
});

test("the plain view marks a sentence within its line", async ({ app, mock }) => {
  await mock.set({ chunks: ["Une phrase qui\ncontinue ici. Puis une autre.\n"] });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("fr");
  await app.text.fill("Plain text, no markup.");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  // Each line is its own block in the plain view: the break ends the sentence there.
  await hover(app.page, "#output", "continue");
  await expect.poll(() => marked(app.page)).toStrictEqual(["continue ici."]);
  await hover(app.page, "#output", "Puis");
  await expect.poll(() => marked(app.page)).toStrictEqual(["Puis une autre."]);
});

// A full stop before a lowercase letter is no sentence end for Intl.Segmenter; the mock sentence model says it is one.
const ONE_FOR_INTL = "lorem ipsum done. then more.";

test("the sentence model's answer for a text, asked for once the translation is finished, decides where it ends", async ({
  app,
  mock,
}) => {
  await mock.set({ chunks: [ONE_FOR_INTL, "\n"], align: NO_ALIGNER });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("fr");
  await app.text.fill("Something to translate.");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  // The text of the output's block, as the page shows it, is what is asked about.
  await expect.poll(async () => (await mock.state()).segment.requests.flat()).toContain(ONE_FOR_INTL);

  // The answer may not have reached the page yet: move until it marks the model's sentence.
  let nudge = 0;
  await expect
    .poll(async () => {
      const { x, y } = await centreOf(app.page, "#output", "more");
      await app.page.mouse.move(x + (nudge++ % 2), y);
      return marked(app.page);
    })
    .toStrictEqual(["then more."]);
  await hover(app.page, "#output", "lorem");
  await expect.poll(() => marked(app.page)).toStrictEqual(["lorem ipsum done."]);
});

test("the sentence is Intl.Segmenter's where the sentence model fails", async ({ app, mock }) => {
  await mock.set({ chunks: [ONE_FOR_INTL, "\n"], segment: { failWith: "the model crashed" } });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("fr");
  await app.text.fill("Something to translate.");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  await hover(app.page, "#output", "more");
  await expect.poll(() => marked(app.page)).toStrictEqual([ONE_FOR_INTL]);
  // Nothing is said about the failure: the line still tells what the translation did.
  await expect(app.meta).toContainText("generated");
});

/** Sentences long enough for a block to be cut into several pieces by reading aloud; `tag` tells blocks apart. */
const english = (tag: string) =>
  Array.from({ length: 7 }, (_, i) => `Sentence ${tag} number ${i + 1} has a good number of words in it.`).join(" ");
const chinese = (tag: string) =>
  Array.from({ length: 8 }, (_, i) => `这是第${tag}段的第${i + 1}句话，里面有不少词语。`).join("");

test("reading aloud and the hover share one answer: each text as the page shows it is asked about once", async ({
  app,
  mock,
}) => {
  const table = (cell: string) => `| name | note |\n| --- | --- |\n| ${cell} | x |`;
  await mock.set({
    chunks: [
      "# 标题\n\n",
      `${chinese("甲")}有*强调*、[链接](https://example.com)和\`代码\`。  \n断行之后。\n\n`,
      `- [ ] ${chinese("乙")}\n- [x] ${chinese("丙")}\n\n`,
      `1. ${chinese("丁")}\n2. ${chinese("戊")}\n\n`,
      `> ${chinese("己")}\n\n`,
      table(chinese("庚")),
    ],
  });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("zh");
  const source = [
    "# A heading",
    `${english("A")} Some *emphasis*, a [link](https://example.com) and \`code\`.  \nAfter the break.`,
    `- [ ] ${english("B")}\n- [x] ${english("C")}`,
    `1. ${english("D")}\n2. ${english("E")}`,
    `> ${english("F")}`,
    table(english("G")),
    "```\ncode. more code.\n```",
  ].join("\n\n");
  await app.text.fill(source);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  // Wait for the requests to finish: no more come.
  await expect.poll(async () => (await mock.state()).segment.requests.length).toBeGreaterThan(0);
  await app.page.waitForTimeout(500);

  // What the page shows of the long blocks, once each: reading aloud's strings are the hover's, not copies of them.
  const requested = (await mock.state()).segment.requests.flat();
  expect(new Set(requested).size).toBe(requested.length);
  const long = requested.filter((t) => t.length >= 100);
  expect(long).toHaveLength(14);
  expect(long.filter((t) => /[*`[\]]/.test(t))).toStrictEqual([]);
  expect(long).toContain(`${english("A")} Some emphasis, a link and code.\nAfter the break.`);
  expect(long).toContain(` ${english("B")}`);
  expect(long).toContain(english("D"));
  expect(long).toContain(english("G"));
  expect(long).toContain(` ${chinese("乙")}`);
  expect(long).toContain(`${chinese("甲")}有强调、链接和代码。\n断行之后。`);

  // Reading either side asks for nothing more.
  await app.previewSource();
  await app.readAloud("source", 1);
  await app.page.locator("#listen-source").click();
  await app.readAloud("output", 1);
  await app.page.waitForTimeout(300);
  expect((await mock.state()).segment.requests.flat()).toStrictEqual(requested);
});

test("a code block is not marked, and nothing is marked while a translation streams", async ({ app, mock }) => {
  await mock.set({ chunks: ["Texte avant.\n\n", "```\ncode. more code.\n```\n\n", "Texte après.\n"] });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("fr");
  await app.text.fill("# Title\n\nText before.\n\n```\ncode\n```\n\nText after.\n");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  await hover(app.page, "#output", "more");
  await app.page.waitForTimeout(200);
  expect(await marked(app.page)).toStrictEqual([]);
  await hover(app.page, "#output", "après");
  await expect.poll(() => marked(app.page)).toStrictEqual(["Texte après."]);
});

/** What is marked, sorted, once moving over `word` again and again (answers arrive while the pointer rests) gives it. */
async function settlesTo(page: Page, container: string, word: string, expected: string[]) {
  let nudge = 0;
  await expect
    .poll(async () => {
      const { x, y } = await centreOf(page, container, word);
      await page.mouse.move(x + (nudge++ % 2), y);
      return (await marked(page)).sort();
    })
    .toStrictEqual([...expected].sort());
}

test("with matched blocks, the sentence's counterpart in the other view is marked too", async ({ app, mock }) => {
  await mock.set({ chunks: ["# Titre\n\n", "Première phrase ici. Seconde phrase là.\n"] });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("fr");
  await app.text.fill(SOURCE);
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  await settlesTo(app.page, "#source-view", "Second", ["Second sentence there.", "Seconde phrase là."]);
  await settlesTo(app.page, "#output", "Première", ["First sentence here.", "Première phrase ici."]);
  // Only the hovered block was asked about, with its sentences as the sentence model cuts them.
  expect((await mock.state()).align.requests).toStrictEqual([
    {
      source: ["First sentence here.", "Second sentence there."],
      target: ["Première phrase ici.", "Seconde phrase là."],
    },
  ]);
});

test("a sentence translated by two is marked with both, and both with it", async ({ app, mock }) => {
  await mock.set({
    chunks: ["# Titre\n\n", "Une. Deux. Trois.\n"],
    align: {
      pairs: [
        { source: [0], target: [0, 1], similarity: 0.9 },
        { source: [1], target: [2], similarity: 0.9 },
      ],
    },
  });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("fr");
  await app.text.fill("# Title\n\nOne and two. Three.\n");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  await settlesTo(app.page, "#output", "Deux", ["One and two.", "Une.", "Deux."]);
  await settlesTo(app.page, "#source-view", "One", ["One and two.", "Une.", "Deux."]);
  await settlesTo(app.page, "#output", "Trois", ["Three.", "Trois."]);
});

test("without matched blocks nothing is asked, and only the sentence is marked", async ({ app, mock }) => {
  // Three blocks for two: the paragraph check fails.
  await mock.set({ chunks: ["# Titre\n\n", "Une phrase.\n\n", "En trop.\n"] });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("fr");
  await app.text.fill("# Title\n\nOne sentence.\n");
  await app.translate.click();
  await expect(app.meta).toContainText("generated");

  await hover(app.page, "#output", "phrase");
  await expect.poll(() => marked(app.page)).toStrictEqual(["Une phrase."]);
  await app.page.waitForTimeout(300);
  await hover(app.page, "#output", "Une");
  expect(await marked(app.page)).toStrictEqual(["Une phrase."]);
  expect((await mock.state()).align.requests).toStrictEqual([]);
});
