import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MarkdownStream, looksLikeMarkdown, parseInline, parseMarkdown, type Block } from "../public/markdown";

describe("looksLikeMarkdown", () => {
  test("one unambiguous construct is enough", () => {
    expect(looksLikeMarkdown("# Title\n\nText.")).toBe(true);
    expect(looksLikeMarkdown("Run:\n\n```sh\nls\n```")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
    expect(looksLikeMarkdown("See [the docs](https://example.com) for more.")).toBe(true);
  });

  test("weaker hints need company", () => {
    expect(looksLikeMarkdown("Use the `ls` command.")).toBe(false);
    expect(looksLikeMarkdown("- just one dash line")).toBe(false);
    expect(looksLikeMarkdown("- apples\n- pears")).toBe(true);
    expect(looksLikeMarkdown("This is **important** and `code`.")).toBe(true);
    expect(looksLikeMarkdown("> quoted\n\n1. first")).toBe(true);
  });

  test("plain prose is not Markdown", () => {
    expect(looksLikeMarkdown("Hello, world")).toBe(false);
    expect(looksLikeMarkdown("#hashtag and 5 * 3 = 15, 2023. A year.")).toBe(false);
    expect(looksLikeMarkdown(readFileSync(new URL("./fixtures/essays.en.txt", import.meta.url), "utf8"))).toBe(false);
  });
});

describe("parseMarkdown blocks", () => {
  test("headings, ATX and setext", () => {
    expect(parseMarkdown("## Two ##\nTitle\n===\nSub\n---")).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", text: "Two" }] },
      { type: "heading", level: 1, children: [{ type: "text", text: "Title" }] },
      { type: "heading", level: 2, children: [{ type: "text", text: "Sub" }] },
    ]);
  });

  test("paragraph lines keep their breaks; blank lines separate paragraphs", () => {
    expect(parseMarkdown("a  \nb\n\nc")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "a" }, { type: "br" }, { type: "text", text: "b" }] },
      { type: "paragraph", children: [{ type: "text", text: "c" }] },
    ]);
  });

  test("fenced code keeps its text verbatim, open fences run to the end", () => {
    expect(parseMarkdown("```js\nlet a = *b*;\n\n```\nafter")).toEqual([
      { type: "code", lang: "js", text: "let a = *b*;\n" },
      { type: "paragraph", children: [{ type: "text", text: "after" }] },
    ]);
    expect(parseMarkdown("~~~\nopen")).toEqual([{ type: "code", lang: "", text: "open" }]);
  });

  test("thematic breaks and block quotes", () => {
    expect(parseMarkdown("* * *\n> # Q\n> line\nlazy")).toEqual([
      { type: "hr" },
      {
        type: "quote",
        children: [
          { type: "heading", level: 1, children: [{ type: "text", text: "Q" }] },
          { type: "paragraph", children: [{ type: "text", text: "line" }, { type: "br" }, { type: "text", text: "lazy" }] },
        ],
      },
    ]);
  });

  test("tight, loose, nested, ordered and task lists", () => {
    const [list] = parseMarkdown("- a\n  - b\n- [x] c\n");
    expect(list).toMatchObject({ type: "list", ordered: false, tight: true });
    const items = (list as Extract<Block, { type: "list" }>).items;
    expect(items).toHaveLength(2);
    expect(items[0]!.children[1]).toMatchObject({ type: "list", items: [{ children: [{ type: "paragraph" }] }] });
    expect(items[1]).toMatchObject({ task: true, children: [{ type: "paragraph", children: [{ text: "c" }] }] });

    expect(parseMarkdown("3. x\n\n4. y")[0]).toMatchObject({ type: "list", ordered: true, start: 3, tight: false, items: [{}, {}] });
    // A different marker starts a new list; a paragraph line after the list ends it.
    expect(parseMarkdown("- a\n+ b").map((b) => b.type)).toEqual(["list", "list"]);
    expect(parseMarkdown("- a\n\nafter").map((b) => b.type)).toEqual(["list", "paragraph"]);
  });

  test("an ordered item other than 1 does not interrupt a paragraph", () => {
    expect(parseMarkdown("In\n2023. A year.").map((b) => b.type)).toEqual(["paragraph"]);
    expect(parseMarkdown("Steps:\n1. one").map((b) => b.type)).toEqual(["paragraph", "list"]);
  });

  test("GFM tables with alignment", () => {
    expect(parseMarkdown("| a | b | c |\n|:--|:-:|--:|\n| 1 | `|` |\n")).toEqual([
      {
        type: "table",
        align: ["left", "center", "right"],
        head: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }], [{ type: "text", text: "c" }]],
        rows: [[[{ type: "text", text: "1" }], [{ type: "text", text: "`" }], [{ type: "text", text: "`" }]]],
      },
    ]);
  });
});

describe("parseInline", () => {
  test("emphasis, strong, both and strikethrough", () => {
    expect(parseInline("*a* **b** ***c*** ~~d~~")).toEqual([
      { type: "em", children: [{ type: "text", text: "a" }] },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "em", children: [{ type: "text", text: "c" }] }] },
      { type: "text", text: " " },
      { type: "del", children: [{ type: "text", text: "d" }] },
    ]);
    expect(parseInline("**a *b* c**")).toEqual([
      { type: "strong", children: [{ type: "text", text: "a " }, { type: "em", children: [{ type: "text", text: "b" }] }, { type: "text", text: " c" }] },
    ]);
  });

  test("unmatched or spaced delimiters stay literal", () => {
    expect(parseInline("5 * 3 * 2")).toEqual([{ type: "text", text: "5 * 3 * 2" }]);
    expect(parseInline("**open")).toEqual([{ type: "text", text: "**open" }]);
    expect(parseInline("snake_case_name")).toEqual([{ type: "text", text: "snake_case_name" }]);
  });

  test("code spans win over emphasis, escapes are literal", () => {
    expect(parseInline("`*x*` \\*y\\*")).toEqual([
      { type: "code", text: "*x*" },
      { type: "text", text: " *y*" },
    ]);
    expect(parseInline("`` a`b ``")).toEqual([{ type: "code", text: "a`b" }]);
  });

  test("links, images, autolinks and bare URLs", () => {
    expect(parseInline('[**x**](https://a.b/c_(d) "T")')).toEqual([
      { type: "link", href: "https://a.b/c_(d)", title: "T", children: [{ type: "strong", children: [{ type: "text", text: "x" }] }] },
    ]);
    expect(parseInline("![alt *t*](/i.png)")).toEqual([{ type: "image", href: "/i.png", title: "", alt: "alt t" }]);
    expect(parseInline("<mailto:a@b.c>")).toEqual([{ type: "link", href: "mailto:a@b.c", title: "", children: [{ type: "text", text: "a@b.c" }] }]);
    expect(parseInline("see https://x.org/a.")).toEqual([
      { type: "text", text: "see " },
      { type: "link", href: "https://x.org/a", title: "", children: [{ type: "text", text: "https://x.org/a" }] },
      { type: "text", text: "." },
    ]);
    expect(parseInline("[not a link] (x)")).toEqual([{ type: "text", text: "[not a link] (x)" }]);
  });

  test("raw HTML is text", () => {
    expect(parseInline("<b>x</b>")).toEqual([{ type: "text", text: "<b>x</b>" }]);
  });
});

describe("MarkdownStream", () => {
  const DOC = [
    "# Title",
    "Intro paragraph with **bold**",
    "continued.",
    "",
    "Setext",
    "------",
    "",
    "- one",
    "- two",
    "  - nested",
    "",
    "- three",
    "",
    "```ts",
    "const a = 1;",
    "",
    "```",
    "> quote",
    "lazy",
    "",
    "| h | i |",
    "|---|---|",
    "| 1 | 2 |",
    "***",
    "1. a",
    "2. b",
    "",
    "Last line",
  ].join("\n");

  /** Streams `text` in the given chunks and returns every handed-out block plus the final tail. */
  function streamed(chunks: string[]): { blocks: Block[]; doneAt: number[] } {
    const s = new MarkdownStream();
    const blocks: Block[] = [];
    const doneAt: number[] = [];
    let tail: Block[] = [];
    chunks.forEach((c, k) => {
      s.push(c);
      const r = s.take();
      blocks.push(...r.done);
      for (const _ of r.done) doneAt.push(k);
      tail = r.tail;
    });
    return { blocks: [...blocks, ...tail], doneAt };
  }

  test("any chunking ends in the same blocks as one parse of the whole text", () => {
    const whole = parseMarkdown(DOC);
    expect(streamed([DOC]).blocks).toEqual(whole);
    expect(streamed([...DOC]).blocks).toEqual(whole);
    let seed = 7;
    for (let round = 0; round < 50; round++) {
      const chunks: string[] = [];
      for (let i = 0; i < DOC.length; ) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        const len = 1 + (seed % 12);
        chunks.push(DOC.slice(i, i + len));
        i += len;
      }
      expect(streamed(chunks).blocks).toEqual(whole);
    }
  });

  test("a block is handed out once a later complete line starts another", () => {
    const s = new MarkdownStream();
    s.push("Para\n");
    expect(s.take()).toEqual({ done: [], tail: [{ type: "paragraph", children: [{ type: "text", text: "Para" }] }] });
    // A partial "---" might be a setext underline, so nothing is final yet.
    s.push("--");
    expect(s.take().done).toEqual([]);
    s.push("-\n\nNext");
    expect(s.take()).toEqual({ done: [], tail: [{ type: "heading", level: 2, children: [{ type: "text", text: "Para" }] }, { type: "paragraph", children: [{ type: "text", text: "Next" }] }] });
    s.push("\n");
    const r = s.take();
    expect(r.done).toEqual([{ type: "heading", level: 2, children: [{ type: "text", text: "Para" }] }]);
    expect(r.tail).toEqual([{ type: "paragraph", children: [{ type: "text", text: "Next" }] }]);
  });

  test("an open code fence stays in the tail until it closes", () => {
    const s = new MarkdownStream();
    s.push("```\ncode\n\n# not a heading\n");
    expect(s.take()).toMatchObject({ done: [], tail: [{ type: "code", text: "code\n\n# not a heading" }] });
    s.push("```\nafter\n");
    expect(s.take()).toMatchObject({ done: [{ type: "code" }], tail: [{ type: "paragraph" }] });
  });
});
