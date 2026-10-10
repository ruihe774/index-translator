import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_ID, MODELS, findModel } from "../src/models";
import { DOCUMENT_DIRECTIONS, LANGUAGES, buildDocumentPrompt, buildPrompt, languageName } from "../src/prompt";

const PLAIN_TAIL = "只输出译文，不要有任何额外说明。";
const JSON_TAIL = "请以相同的 JSON 格式输出翻译结果，key 保持不变，value 为对应译文。只输出 JSON，不要有任何额外说明。";

/** The numbered lines of the 【约束要求】 block. */
function constraintBlock(prompt: string): string[] {
  const m = prompt.match(/【约束要求】\n([\s\S]*?)\n\n/);
  return m ? m[1]!.split("\n") : [];
}

describe("constraint lines", () => {
  test("a hard constraint already tagged 【硬性要求】 is not tagged twice", () => {
    const prompt = buildPrompt({ text: "x", targetLang: "en", hardConstraints: ["【硬性要求】保留占位符"] });
    expect(constraintBlock(prompt)).toEqual(["1. 【硬性要求】保留占位符"]);
  });

  test("soft constraints keep an existing 【注意】 or 【软性要求】 tag", () => {
    const prompt = buildPrompt({ text: "x", targetLang: "en", softConstraints: ["【注意】简洁", "【软性要求】准确"] });
    expect(constraintBlock(prompt)).toEqual(["1. 【注意】简洁", "2. 【软性要求】准确"]);
  });

  test.failing("a hard constraint carrying a soft tag is not double-tagged (spec: the three prefixes are never re-tagged)", () => {
    // Bug: hard items only accept 【硬性要求】, so "【注意】..." / "【软性要求】..." in hardConstraints becomes "【硬性要求】【注意】...".
    const prompt = buildPrompt({
      text: "x",
      targetLang: "en",
      hardConstraints: ["【注意】保持简洁", "【软性要求】保持准确"],
    });
    expect(prompt).not.toContain("【硬性要求】【注意】");
    expect(prompt).not.toContain("【硬性要求】【软性要求】");
  });

  test("a multi-line item becomes one numbered line per non-blank line", () => {
    const prompt = buildPrompt({
      text: "x",
      targetLang: "en",
      hardConstraints: ["第一条\n\n   第二条  \n   "],
      softConstraints: ["甲\n乙"],
    });
    expect(constraintBlock(prompt)).toEqual([
      "1. 【硬性要求】第一条",
      "2. 【硬性要求】第二条",
      "3. 【注意】甲",
      "4. 【注意】乙",
    ]);
  });

  test("blank and whitespace-only items yield the plain prompt", () => {
    const plain = buildPrompt({ text: "x", targetLang: "en" });
    expect(
      buildPrompt({
        text: "x",
        targetLang: "en",
        hardConstraints: ["", "   \n\t"],
        softConstraints: [" "],
      }),
    ).toBe(plain);
  });

  test("empty constraint lists and an omitted genre yield the plain prompt", () => {
    const plain = buildPrompt({ text: "x", targetLang: "en" });
    expect(buildPrompt({ text: "x", targetLang: "en", hardConstraints: [], softConstraints: [] })).toBe(plain);
    expect(plain).toBe("请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\nx");
  });

  test("leading list numbering is stripped", () => {
    const prompt = buildPrompt({
      text: "x",
      targetLang: "en",
      hardConstraints: ["1. 甲", "2.乙", "10. 丙", "  3 丁", "0.戊"],
      softConstraints: ["4. 【注意】己"],
    });
    expect(constraintBlock(prompt)).toEqual([
      "1. 【硬性要求】甲",
      "2. 【硬性要求】乙",
      "3. 【硬性要求】丙",
      "4. 【硬性要求】丁",
      "5. 【硬性要求】戊",
      "6. 【注意】己",
    ]);
  });

  test("a constraint starting with digits loses them, mirroring the reference lstrip", () => {
    // Intentional: translate.py does line.strip().lstrip("0123456789. "), so the port drops
    // the leading "2024" too. Digits not at the start of the item are untouched.
    const prompt = buildPrompt({
      text: "x",
      targetLang: "en",
      hardConstraints: ["2024年的日期保持不变", "保留 2024 年份"],
    });
    expect(constraintBlock(prompt)).toEqual(["1. 【硬性要求】年的日期保持不变", "2. 【硬性要求】保留 2024 年份"]);
  });
});

describe("glossary constraints", () => {
  test("keys and values are trimmed", () => {
    const prompt = buildPrompt({ text: "x", targetLang: "en", glossary: { " 碳纤维 ": "  carbon fiber " } });
    expect(constraintBlock(prompt)).toEqual(["1. 【硬性要求】专名/术语对照: 碳纤维→carbon fiber"]);
  });

  test("an empty glossary adds nothing", () => {
    expect(buildPrompt({ text: "x", targetLang: "en", glossary: {} })).toBe(
      buildPrompt({ text: "x", targetLang: "en" }),
    );
  });

  test("multiple terms are joined with 、 in insertion order", () => {
    const prompt = buildPrompt({ text: "x", targetLang: "en", glossary: { b: "B", a: "A", c: "C" } });
    expect(constraintBlock(prompt)).toEqual(["1. 【硬性要求】专名/术语对照: b→B、a→A、c→C"]);
  });

  test("a glossary alone uses the constrained layout", () => {
    const prompt = buildPrompt({ text: "源", targetLang: "en", glossary: { k: "v" } });
    expect(prompt).toBe(
      "请将以下文本翻译成英语，并且严格遵循所有约束要求。\n\n" +
        "【源文】\n源\n\n" +
        "【约束要求】\n1. 【硬性要求】专名/术语对照: k→v\n\n" +
        PLAIN_TAIL,
    );
  });

  test("order is hard, glossary, soft with continuous numbering", () => {
    const prompt = buildPrompt({
      text: "x",
      targetLang: "en",
      hardConstraints: ["h1", "h2"],
      glossary: { k: "v" },
      softConstraints: ["s1\ns2"],
    });
    expect(constraintBlock(prompt)).toEqual([
      "1. 【硬性要求】h1",
      "2. 【硬性要求】h2",
      "3. 【硬性要求】专名/术语对照: k→v",
      "4. 【注意】s1",
      "5. 【注意】s2",
    ]);
  });
});

describe("genre", () => {
  test("defaults to 文本 when constraints are present", () => {
    const prompt = buildPrompt({ text: "x", targetLang: "en", hardConstraints: ["a"] });
    expect(prompt).toStartWith("请将以下文本翻译成英语，并且严格遵循所有约束要求。");
  });

  test("is trimmed, and a blank genre falls back to 文本", () => {
    expect(buildPrompt({ text: "x", targetLang: "en", genre: " 新闻 ", hardConstraints: ["a"] })).toStartWith(
      "请将以下新闻翻译成英语",
    );
    expect(buildPrompt({ text: "x", targetLang: "en", genre: "   ", hardConstraints: ["a"] })).toStartWith(
      "请将以下文本翻译成英语",
    );
  });

  test("is ignored when there are no constraints", () => {
    expect(buildPrompt({ text: "x", targetLang: "en", genre: "新闻" })).toBe(
      "请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\nx",
    );
  });
});

describe("source language", () => {
  test("AUTO and padded auto are treated as absent", () => {
    const absent = buildPrompt({ text: "Hello", targetLang: "zh" });
    expect(buildPrompt({ text: "Hello", targetLang: "zh", sourceLang: "AUTO" })).toBe(absent);
    expect(buildPrompt({ text: "Hello", targetLang: "zh", sourceLang: " auto " })).toBe(absent);
  });

  test("an empty or blank source language is treated as absent", () => {
    const absent = buildPrompt({ text: "Hello", targetLang: "zh" });
    expect(buildPrompt({ text: "Hello", targetLang: "zh", sourceLang: "" })).toBe(absent);
    expect(buildPrompt({ text: "Hello", targetLang: "zh", sourceLang: "   " })).toBe(absent);
  });

  test("known codes are matched case-insensitively with surrounding whitespace", () => {
    expect(buildPrompt({ text: "Hello", targetLang: " ZH ", sourceLang: " EN " })).toBe(
      "请将以下英语文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\nHello",
    );
    expect(buildPrompt({ text: "x", targetLang: "ja", sourceLang: "Ko", hardConstraints: ["a"] })).toStartWith(
      "请将以下韩语文本翻译成日语",
    );
  });

  test("unknown language names pass through trimmed", () => {
    expect(buildPrompt({ text: "Hello", targetLang: "  Klingon ", sourceLang: "\tTlhIngan\n" })).toBe(
      "请将以下TlhIngan文本翻译为Klingon，直接输出翻译结果，不要进行任何解释。\n\nHello",
    );
  });
});

describe("JSON suffix", () => {
  const json = '{"message": "您的订单已支付完成。"}';

  test("a JSON object with a constraint mentioning JSON in any case gets the JSON suffix", () => {
    for (const word of ["JSON", "Json", "json"]) {
      const prompt = buildPrompt({ text: json, targetLang: "en", hardConstraints: [`保留 ${word} 结构`] });
      expect(prompt).toEndWith(JSON_TAIL);
    }
  });

  test("a soft constraint mentioning JSON also selects the JSON suffix", () => {
    const prompt = buildPrompt({ text: json, targetLang: "en", softConstraints: ["保留 JSON 结构"] });
    expect(prompt).toEndWith(JSON_TAIL);
  });

  test("the source is checked after trimming", () => {
    const prompt = buildPrompt({ text: `\n  ${json} \n`, targetLang: "en", hardConstraints: ["JSON"] });
    expect(prompt).toEndWith(JSON_TAIL);
    expect(prompt).toContain(`【源文】\n${json}\n\n`);
  });

  test("a JSON array source gets the plain suffix", () => {
    const prompt = buildPrompt({ text: '[{"a": "b"}]', targetLang: "en", hardConstraints: ["JSON"] });
    expect(prompt).toEndWith(PLAIN_TAIL);
  });

  test("invalid JSON gets the plain suffix", () => {
    const prompt = buildPrompt({ text: "{not: json}", targetLang: "en", hardConstraints: ["JSON"] });
    expect(prompt).toEndWith(PLAIN_TAIL);
  });

  test("a JSON object without a JSON constraint gets the plain suffix", () => {
    const prompt = buildPrompt({ text: json, targetLang: "en", hardConstraints: ["保留术语"] });
    expect(prompt).toEndWith(PLAIN_TAIL);
  });

  test("non-JSON text with a JSON constraint gets the plain suffix", () => {
    const prompt = buildPrompt({ text: "hello json", targetLang: "en", hardConstraints: ["JSON"] });
    expect(prompt).toEndWith(PLAIN_TAIL);
  });
});

describe("languageName", () => {
  test("every known code maps to its prompt name, in any case", () => {
    for (const lang of LANGUAGES) {
      expect(languageName(lang.code)).toBe(lang.zh);
      expect(languageName(lang.code.toUpperCase())).toBe(lang.zh);
    }
  });

  test("language codes are unique", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("prompt names are unique", () => {
    const names = LANGUAGES.map((l) => l.zh);
    expect(new Set(names).size).toBe(names.length);
  });

  test("unknown names are returned trimmed", () => {
    expect(languageName("  Norwegian ")).toBe("Norwegian");
    expect(languageName("zz")).toBe("zz");
  });
});

describe("models", () => {
  test("ids and files are unique", () => {
    const ids = MODELS.map((m) => m.id);
    const files = MODELS.map((m) => m.file);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(files).size).toBe(files.length);
  });

  test("the default model exists", () => {
    expect(findModel(DEFAULT_MODEL_ID)).toBeDefined();
    expect(findModel(DEFAULT_MODEL_ID)?.kind).toBe("chat");
  });

  test("every kind is chat or document, and only document models carry directions", () => {
    for (const m of MODELS) {
      expect(["chat", "document"]).toContain(m.kind);
      if (m.kind === "chat") expect(m.directions).toBeUndefined();
      else expect(m.directions).toBeDefined();
    }
  });

  test("the document model's directions match DOCUMENT_DIRECTIONS in order", () => {
    const doc = MODELS.filter((m) => m.kind === "document");
    expect(doc.length).toBe(1);
    expect(doc[0]!.directions).toEqual(DOCUMENT_DIRECTIONS);
  });

  test("every advertised document direction has a template", () => {
    for (const m of MODELS) {
      for (const direction of m.directions ?? []) {
        expect(() => buildDocumentPrompt(direction, "x")).not.toThrow();
      }
    }
  });

  test("findModel returns the spec for a known id and undefined otherwise", () => {
    for (const m of MODELS) expect(findModel(m.id)).toBe(m);
    expect(findModel("no-such-model")).toBeUndefined();
    expect(findModel("")).toBeUndefined();
  });
});

describe("buildDocumentPrompt extras", () => {
  test("a document containing the placeholder text is inserted literally", () => {
    const doc = "（在这里放入需要翻译的完整英文原文）\nmore";
    const prompt = buildDocumentPrompt("en-zh", doc);
    expect(prompt).toEndWith(`【源文】\n\n${doc}`);
    expect(prompt.split("（在这里放入").length).toBe(2);
  });

  test("multi-paragraph text is preserved verbatim", () => {
    const doc = "第一段\n\n第二段\n\n\n第三段 $$ $' $`";
    expect(buildDocumentPrompt("zh-en", doc)).toEndWith(`【源文】\n\n${doc}`);
  });

  test("CRLF line endings inside the document are preserved", () => {
    expect(buildDocumentPrompt("ja-zh", "a\r\nb\r\n")).toEndWith("【源文】\n\na\r\nb");
    expect(buildDocumentPrompt("ja-zh", "a\r\n\r\nb")).toEndWith("【源文】\n\na\r\n\r\nb");
  });
});
