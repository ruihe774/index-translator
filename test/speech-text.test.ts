import { describe, expect, test } from "bun:test";
import { canSpeak, kanjiNumber, speechSegments } from "../public/speech-text";

const texts = (text: string, markdown: boolean, lang = "en") => speechSegments(text, markdown, lang).map((s) => s.text);

describe("Markdown is read from its structure, not its source", () => {
  test("headings, emphasis, inline code and links lose their markers", () => {
    const md =
      "# Release *notes*\n\nWe fixed **three** bugs in [the parser](https://example.com/p?id=1) and `bun test`.";
    expect(texts(md, true)).toEqual(["Release notes.", "We fixed three bugs in the parser and bun test."]);
  });

  test("a heading that ends in punctuation is left as it is", () => {
    expect(texts("## What is new?", true)).toEqual(["What is new?"]);
  });

  test("list items are read one by one; ordered ones with their number", () => {
    expect(texts("- apples\n- pears", true)).toEqual(["apples.", "pears."]);
    expect(texts("3. Install it.\n4. Run it", true)).toEqual(["3. Install it.", "4. Run it."]);
    expect(texts("1. 安装依赖项。\n2. 运行测试", true, "zh")).toEqual(["1、安装依赖项。", "2、运行测试。"]);
  });

  test("nested lists and task boxes", () => {
    expect(texts("- [x] done\n- [ ] open\n  - inner", true)).toEqual(["done.", "open.", "inner."]);
  });

  test("code blocks and rules are skipped", () => {
    expect(texts("Before.\n\n```bash\nrm -rf /\n```\n\n---\n\nAfter.", true)).toEqual(["Before.", "After."]);
  });

  test("a table row is read as header and cell pairs", () => {
    const md = "| Name | Speed |\n|---|---|\n| Vulkan | 70 tokens |\n| CPU | |";
    expect(texts(md, true)).toEqual(["Name: Vulkan, Speed: 70 tokens.", "Name: CPU."]);
    expect(texts("| 名称 | 速度 |\n|---|---|\n| Vulkan | 快 |", true, "zh")).toEqual(["名称：Vulkan，速度：快。"]);
    expect(texts("| Name | Speed |\n|---|---|", true)).toEqual(["Name, Speed."]);
  });

  test("block quotes are read, images by their alt text", () => {
    expect(texts("> Thanks to **all**.\n\n![A cat on a mat](cat.png)", true)).toEqual([
      "Thanks to all.",
      "A cat on a mat",
    ]);
  });

  test("a wrapped paragraph is one sentence", () => {
    expect(texts("# T\n\nThis line is wrapped\nin the source.", true)).toEqual([
      "T.",
      "This line is wrapped in the source.",
    ]);
    expect(texts("# 标题\n\n这一行在源文件中\n换行了。", true, "zh")).toEqual(["标题。", "这一行在源文件中换行了。"]);
  });

  test("the same text read raw keeps every character that can be spoken", () => {
    expect(texts("# Title", false)).toEqual(["# Title"]);
  });
});

describe("pieces", () => {
  test("each carries the line of its top-level block", () => {
    const md = "# One\n\nTwo.\n\n- a\n- b\n\nThree.";
    expect(speechSegments(md, true, "en").map((s) => s.line)).toEqual([0, 2, 4, 4, 7]);
  });

  test("plain text is read line by line; blank and symbol-only lines are dropped", () => {
    const segments = speechSegments("First line.\n\n***\nThird line.", false, "en");
    expect(segments.map((s) => [s.line, s.text])).toEqual([
      [0, "First line."],
      [3, "Third line."],
    ]);
  });

  test("a long paragraph is cut at sentence ends, short sentences stay together", () => {
    const sentence = "This sentence is here to fill the paragraph with ordinary words. ";
    const parts = texts(sentence.repeat(6), false);
    expect(parts.length).toBe(3);
    for (const p of parts) expect(p).toBe(sentence.repeat(2).trim());
    expect(texts("Yes. No. Maybe.", false)).toEqual(["Yes. No. Maybe."]);
  });

  test("a sentence beyond the limit is cut at commas, then at spaces", () => {
    const clause = "and then another clause follows with a few more words in it, ";
    for (const p of texts(clause.repeat(12), false)) expect(p.length).toBeLessThanOrEqual(400);
    const unbroken = texts("word ".repeat(200), false);
    expect(unbroken.length).toBeGreaterThan(1);
    for (const p of unbroken) expect(p.length).toBeLessThanOrEqual(400);
    expect(unbroken.join(" ")).toBe("word ".repeat(200).trim());
  });

  test("Chinese is cut into shorter pieces than English", () => {
    const parts = texts("今天天气很好，我们一起去公园散步吧。".repeat(8), false, "zh");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(60);
  });

  test("the silence is longest after a heading and shortest inside a paragraph", () => {
    const sentence = "This sentence is here to fill the paragraph with ordinary words and a few more of them. ";
    const pauses = speechSegments(`# Title\n\n${sentence.repeat(3)}`, true, "en").map((s) => s.pause);
    expect(pauses[0]).toBeGreaterThan(pauses.at(-1)!);
    expect(pauses.at(-1)).toBeGreaterThan(pauses[1]!);
  });

  test("every piece fits one speech request", () => {
    const long = `${"x".repeat(5000)} ${"好".repeat(5000)}`;
    for (const lang of ["en", "zh"]) {
      for (const s of speechSegments(long, false, lang)) expect(s.text.length).toBeLessThanOrEqual(1000);
    }
  });
});

describe("cutting by code points", () => {
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  test("a long word of surrogate pairs is never cut inside a pair", () => {
    // "a" + a pair is three UTF-16 units, so a cut every 400 units would land inside a pair.
    const word = "a😀".repeat(500);
    for (const lang of ["en", "zh"]) {
      const parts = texts(word, false, lang);
      expect(parts.length).toBeGreaterThan(1);
      for (const p of parts) {
        expect(LONE.test(p)).toBe(false);
        expect(Array.from(p).length).toBeLessThanOrEqual(lang === "zh" ? 150 : 400);
      }
      expect(parts.join("")).toBe(word);
    }
  });

  test("the limit counts code points, so astral characters fill a piece as full as BMP ones", () => {
    const parts = texts("𠮷".repeat(1000), false, "zh");
    expect(parts.map((p) => Array.from(p).length)).toEqual([150, 150, 150, 150, 150, 150, 100]);
    expect(parts.some((p) => LONE.test(p))).toBe(false);
  });
});

describe("tables and lists that are odd", () => {
  test("pipes inside a cell are never spoken", () => {
    const parts = texts("| Cmd | Use |\n|---|---|\n| a \\| b | x \\| y |", true);
    expect(parts.length).toBe(1);
    expect(parts[0]).not.toContain("|");
    expect(parts[0]).toMatch(/^Cmd: a b, Use: x y\.$/);
  });

  test("a table without a header row text and with empty cells", () => {
    expect(texts("| | |\n|---|---|\n| a | |\n| | |", true)).toEqual(["a."]);
  });

  test("empty and marker-only list items are dropped, numbering follows the source", () => {
    expect(texts("- \n- real\n- **\n- ***", true)).toEqual(["real."]);
    expect(texts("2. \n3. third\n4. `` ", true)).toEqual(["3. third."]);
  });

  test("a list of nothing but Markdown syntax gives no pieces", () => {
    expect(texts("- **\n- __\n- []()", true)).toEqual([]);
  });

  test("links and images in list items are read by their text", () => {
    expect(texts("- [docs](https://example.com/a)\n- ![logo](l.png) **bold** `code`", true)).toEqual([
      "docs.",
      "logo bold code.",
    ]);
  });
});

describe("cleaning", () => {
  test("a web address is read as its host", () => {
    expect(texts("See https://www.example.com/docs/a?b=1#c for more.", false)).toEqual(["See example.com for more."]);
    expect(texts("<https://example.org/x>", true)).toEqual(["example.org"]);
  });

  test("characters of the model's pronunciation syntax never reach it", () => {
    expect(texts("Use a <b|c> here | there.", false)).toEqual(["Use a b c here there."]);
  });

  test("spaces between Chinese characters are closed, those around Latin words kept", () => {
    expect(texts("我们修复了 解析器 中的 三个 错误，并提升了 bun test 的速度。", false, "zh")).toEqual([
      "我们修复了解析器中的三个错误，并提升了 bun test 的速度。",
    ]);
  });

  test("Japanese digits are written out, others are left to the engine", () => {
    expect(texts("2026年には、15人が参加しました。", false, "ja")).toEqual([
      "二千二十六年には、十五人が参加しました。",
    ]);
    expect(texts("3. 依存関係をインストールします", true, "ja")).toEqual(["三、依存関係をインストールします。"]);
    expect(texts("2026年有15位研究人员。", false, "zh")).toEqual(["2026年有15位研究人员。"]);
  });

  test("Japanese: commas are thousands separators only in the strict form", () => {
    expect(texts("1,2,3", false, "ja")).toEqual(["一,二,三"]);
    expect(texts("2026, then 15", false, "ja")).toEqual(["二千二十六, then 十五"]);
    expect(texts("1,234,567円", false, "ja")).toEqual(["百二十三万四千五百六十七円"]);
    expect(texts("1,234.5と12,3456", false, "ja")).toEqual(["千二百三十四点五と十二,三千四百五十六"]);
    expect(texts("23.5%", false, "ja")).toEqual(["二十三点五%"]);
  });

  test("other languages leave numbers and commas alone", () => {
    for (const lang of ["en", "zh", "es", "ar"]) {
      expect(texts("1,2,3 and 1,234,567 in 2026, then 23.5", false, lang)).toEqual([
        "1,2,3 and 1,234,567 in 2026, then 23.5",
      ]);
    }
  });
});

test("kanjiNumber", () => {
  const cases: [string, string][] = [
    ["0", "〇"],
    ["7", "七"],
    ["10", "十"],
    ["15", "十五"],
    ["110", "百十"],
    ["2026", "二千二十六"],
    ["10000", "一万"],
    ["12,345", "一万二千三百四十五"],
    ["100000000", "一億"],
    ["300000005", "三億五"],
    ["23.5", "二十三点五"],
    ["0.05", "〇点〇五"],
    ["007", "〇〇七"],
  ];
  for (const [digits, kanji] of cases) expect([digits, kanjiNumber(digits)]).toEqual([digits, kanji]);
});

test("canSpeak", () => {
  expect(["zh", "en", "ja", "es", "ar"].every(canSpeak)).toBe(true);
  expect(canSpeak("de")).toBe(false);
  expect(canSpeak(undefined)).toBe(false);
});
